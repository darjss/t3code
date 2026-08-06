/**
 * Pure auto-settle policy: decides whether a thread should settle, given the
 * thread shell, the wall clock, the configured inactivity window, and the
 * thread's change-request (PR) state. The server is the single author of
 * settled state — clients only read settledOverride — so everything that used
 * to be client-side effectiveSettled derivation lives here and runs in the
 * ThreadAutoSettleReactor sweep.
 */
import type { OrchestrationThreadShell } from "@t3tools/contracts";

const DAY_MS = 24 * 60 * 60 * 1_000;

/**
 * A queued turn start lives for at most this long: session adoption takes
 * seconds, so a user message still unadopted after the grace window is a
 * failed start (or stale data), not pending work. Shared by the decider's
 * settle invariant and the auto-settle sweep; mirrors the client's constant
 * in client-runtime threadSettled.ts.
 */
export const QUEUED_TURN_START_GRACE_MS = 2 * 60 * 1_000;

/**
 * Change-request state resolved for a thread's checkout:
 * - "open" / "closed" / "merged": the cwd's cached VCS status matched the
 *   thread's branch and carried this PR state.
 * - "none": PR state is decided and there is no gating PR (no branch, no PR
 *   on the branch, or the cwd is checked out elsewhere so the state can
 *   never be determined — same as the clients' old branch-match guard).
 * - "unknown": the thread has a branch but no cached VCS status exists yet;
 *   the sweep should verify with a live lookup before an inactivity settle.
 */
export type AutoSettleChangeRequestState = "open" | "closed" | "merged" | "none" | "unknown";

export type AutoSettleVerdict =
  | { readonly kind: "skip" }
  | { readonly kind: "settle"; readonly settledAt: string }
  | { readonly kind: "verify-pr" };

type AutoSettleShell = Pick<
  OrchestrationThreadShell,
  | "settledOverride"
  | "pinnedAt"
  | "snoozedUntil"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "session"
  | "latestUserMessageAt"
  | "latestTurn"
>;

/**
 * When the thread last saw real activity: the newest of the latest user
 * message, any latest-turn timestamp, and — for previously snoozed threads —
 * the wake time. Counting the wake as activity gives a woken thread a fresh
 * inactivity window; without it, a thread snoozed past the window would
 * settle the instant it woke, defeating the snooze.
 */
export function threadLastActivityAt(
  thread: Pick<OrchestrationThreadShell, "latestUserMessageAt" | "latestTurn" | "snoozedUntil">,
  nowMs: number,
): string | null {
  const snoozeWakePassed =
    thread.snoozedUntil != null && Date.parse(thread.snoozedUntil) <= nowMs
      ? thread.snoozedUntil
      : null;
  const candidates = [
    thread.latestUserMessageAt,
    thread.latestTurn?.requestedAt,
    thread.latestTurn?.startedAt,
    thread.latestTurn?.completedAt,
    snoozeWakePassed,
  ];
  let latest: string | null = null;
  let latestTimestamp = Number.NEGATIVE_INFINITY;
  for (const candidate of candidates) {
    if (candidate == null) continue;
    const timestamp = Date.parse(candidate);
    if (timestamp > latestTimestamp) {
      latest = candidate;
      latestTimestamp = timestamp;
    }
  }
  return latest;
}

/**
 * A user message no turn has picked up yet (turn.start dispatched, session
 * not yet adopted). Bounded on both sides of the grace window because
 * message timestamps originate on whichever device sent them — a clock
 * ahead of this one must not hold the queued state for the whole skew.
 */
function hasQueuedTurnStart(thread: AutoSettleShell, nowMs: number): boolean {
  if (thread.latestUserMessageAt == null) return false;
  if (thread.session?.status === "error") return false;
  const messageAt = Date.parse(thread.latestUserMessageAt);
  if (Number.isNaN(messageAt)) return false;
  if (Math.abs(nowMs - messageAt) > QUEUED_TURN_START_GRACE_MS) return false;
  const turn = thread.latestTurn;
  if (turn === null) return true;
  return [turn.requestedAt, turn.startedAt, turn.completedAt].every(
    (candidate) => candidate == null || Date.parse(candidate) < messageAt,
  );
}

/**
 * Auto-settle policy for one eligible-looking thread. Skips anything with an
 * explicit override ("settled" is done, "active" is the user's keep-active
 * pin), anything pinned or still snoozed, and anything blocked on the user
 * or mid-work. Past the blockers: a merged/closed PR settles immediately
 * (merge means done, regardless of recency), an open PR blocks the
 * inactivity path entirely, and otherwise the thread settles once its last
 * activity falls outside the configured window. settledAt is stamped with
 * the last-activity time so the settled shelf orders by when work ended,
 * not when the sweep happened to run.
 */
export function resolveAutoSettleVerdict(
  thread: AutoSettleShell,
  options: {
    readonly now: string;
    readonly autoSettleAfterDays: number | null;
    readonly changeRequestState: AutoSettleChangeRequestState;
  },
): AutoSettleVerdict {
  const { autoSettleAfterDays, changeRequestState } = options;
  const nowMs = Date.parse(options.now);
  // A malformed clock must never surprise-settle anything.
  if (Number.isNaN(nowMs)) return { kind: "skip" };
  if (thread.settledOverride !== null) return { kind: "skip" };
  // Settling a pinned thread would clear the pin (the decider bundles
  // thread.unpinned with thread.settled); a pin means "never out of sight".
  if (thread.pinnedAt != null) return { kind: "skip" };
  if (thread.snoozedUntil != null && Date.parse(thread.snoozedUntil) > nowMs) {
    return { kind: "skip" };
  }
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return { kind: "skip" };
  if (thread.session?.status === "starting" || thread.session?.status === "running") {
    return { kind: "skip" };
  }
  if (hasQueuedTurnStart(thread, nowMs)) return { kind: "skip" };

  const lastActivityAt = threadLastActivityAt(thread, nowMs);

  if (changeRequestState === "merged" || changeRequestState === "closed") {
    return { kind: "settle", settledAt: lastActivityAt ?? options.now };
  }
  // An open PR is unfinished business no matter how long the thread has been
  // quiet: review can take days, and hiding the thread would bury the work
  // waiting on it.
  if (changeRequestState === "open") return { kind: "skip" };
  if (autoSettleAfterDays === null) return { kind: "skip" };
  if (lastActivityAt === null) return { kind: "skip" };
  if (Date.parse(lastActivityAt) >= nowMs - autoSettleAfterDays * DAY_MS) {
    return { kind: "skip" };
  }
  // Quiet past the window, but PR state undetermined: verify before hiding —
  // the branch may have an open PR nobody has looked at from this server yet.
  if (changeRequestState === "unknown") return { kind: "verify-pr" };
  return { kind: "settle", settledAt: lastActivityAt };
}
