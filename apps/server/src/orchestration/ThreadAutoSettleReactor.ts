/**
 * ThreadAutoSettleReactor - Server-side auto-settle sweep.
 *
 * The server is the single author of settled state: this reactor periodically
 * evaluates unsettled threads against the auto-settle policy (inactivity
 * window from the threadAutoSettleAfterDays server setting, merged/closed PR)
 * and dispatches thread.settle for the ones that qualify. Clients only read
 * settledOverride.
 *
 * @module ThreadAutoSettleReactor
 */
import {
  CommandId,
  DEFAULT_THREAD_AUTO_SETTLE_AFTER_DAYS,
  type ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { forkParked } from "../serverActivation.ts";
import { VcsStatusBroadcaster } from "../vcs/VcsStatusBroadcaster.ts";
import { type AutoSettleChangeRequestState, resolveAutoSettleVerdict } from "./autoSettle.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";

export class ThreadAutoSettleReactor extends Context.Service<
  ThreadAutoSettleReactor,
  {
    /** Start the periodic auto-settle sweep within the provided scope. */
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /** Run one sweep immediately. Intended for tests, which must never wait
        on the timer schedule. */
    readonly sweepOnce: Effect.Effect<void>;
  }
>()("t3/orchestration/ThreadAutoSettleReactor") {}

// A sweep is one shell-snapshot read plus cache-only PR peeks, so it can run
// often; a merged PR settles its thread within a tick while a client's VCS
// watcher keeps the status cache warm.
const DEFAULT_SWEEP_INTERVAL_MS = 60 * 1_000;
// Live PR verification hits git and the forge, so cold cwds are re-checked at
// most this often — an unwatched repo's open PR still unblocks settle within
// the cooldown of merging.
const DEFAULT_PR_VERIFY_COOLDOWN_MS = 30 * 60 * 1_000;
// At most this many live verifications per sweep: right after an upgrade a
// server can hold dozens of quiet branch-carrying threads, and verifying all
// of them at once would stampede git and the forge. The backlog drains a few
// threads per sweep instead.
const PR_VERIFY_MAX_PER_SWEEP = 5;

export interface ThreadAutoSettleReactorOptions {
  readonly sweepIntervalMs?: number;
  readonly prVerifyCooldownMs?: number;
}

export const make = (options?: ThreadAutoSettleReactorOptions) =>
  Effect.gen(function* () {
    const orchestrationEngine = yield* OrchestrationEngineService;
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const vcsStatusBroadcaster = yield* VcsStatusBroadcaster;
    const serverSettings = yield* ServerSettingsService;
    const backgroundPolicy = yield* BackgroundPolicy.BackgroundPolicy;
    const crypto = yield* Crypto.Crypto;

    const sweepIntervalMs = Math.max(1, options?.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);
    const prVerifyCooldownMs = Math.max(
      1,
      options?.prVerifyCooldownMs ?? DEFAULT_PR_VERIFY_COOLDOWN_MS,
    );
    const lastPrVerifyAtByCwd = yield* Ref.make(new Map<string, number>());

    const serverCommandId = crypto.randomUUIDv4.pipe(
      Effect.map((uuid) => CommandId.make(`server:auto-settle:${uuid}`)),
    );

    const autoSettleAfterDays = serverSettings.getSettings.pipe(
      Effect.map((settings) => settings.threadAutoSettleAfterDays),
      Effect.orElseSucceed(() => DEFAULT_THREAD_AUTO_SETTLE_AFTER_DAYS),
    );

    // The cached PR state for a thread's checkout, mapped exactly like the
    // clients' old resolveThreadPr: a status only counts when its refName is
    // the thread's branch (a workspace checked out elsewhere can never
    // determine this thread's PR state, so it gates nothing). A cached
    // "open" maps to "open-cached": it may have merged since polling
    // stopped, so it never permanently blocks the inactivity path — the
    // verdict asks for a cooldown-limited live verification instead.
    const peekChangeRequestState = Effect.fn("ThreadAutoSettleReactor.peekChangeRequestState")(
      function* (thread: {
        readonly branch: string | null;
        readonly cwd: string;
      }): Effect.fn.Return<AutoSettleChangeRequestState> {
        if (thread.branch === null) return "none";
        const status = yield* vcsStatusBroadcaster.peekStatus({ cwd: thread.cwd });
        if (status === null) return "unknown";
        if (status.refName !== thread.branch) return "none";
        const prState = status.pr?.state ?? null;
        if (prState === null) return "none";
        return prState === "open" ? "open-cached" : prState;
      },
    );

    // Live PR lookup for an inactivity-settle candidate whose cached state is
    // missing or stale-open. Cooldown-limited per cwd and gated on the
    // background policy so an idle laptop is not woken for forge polls.
    // `verified` is false when the cooldown suppressed the lookup — such
    // calls are free and must not consume the sweep's verification budget.
    const verifyChangeRequestState = Effect.fn("ThreadAutoSettleReactor.verifyChangeRequestState")(
      function* (thread: {
        readonly branch: string | null;
        readonly cwd: string;
      }): Effect.fn.Return<{
        readonly state: AutoSettleChangeRequestState;
        readonly verified: boolean;
      }> {
        if (thread.branch === null) return { state: "none", verified: false };
        const now = yield* Clock.currentTimeMillis;
        const mayVerify = yield* Ref.modify(lastPrVerifyAtByCwd, (byCwd) => {
          const lastAt = byCwd.get(thread.cwd);
          if (lastAt !== undefined && now - lastAt < prVerifyCooldownMs) {
            return [false, byCwd] as const;
          }
          const next = new Map(byCwd);
          next.set(thread.cwd, now);
          return [true, next] as const;
        });
        if (!mayVerify) return { state: "unknown", verified: false };
        const status = yield* vcsStatusBroadcaster.refreshStatus(thread.cwd).pipe(
          Effect.catch((error) =>
            Effect.logDebug("thread.auto-settle.pr-verify-failed", {
              cwd: thread.cwd,
              error,
            }).pipe(Effect.as(null)),
          ),
        );
        if (status === null) return { state: "unknown", verified: true };
        if (status.refName !== thread.branch) return { state: "none", verified: true };
        return { state: status.pr?.state ?? "none", verified: true };
      },
    );

    const settleThread = Effect.fn("ThreadAutoSettleReactor.settleThread")(function* (input: {
      readonly threadId: ThreadId;
    }) {
      const commandId = yield* serverCommandId;
      yield* orchestrationEngine
        .dispatch({
          type: "thread.settle",
          commandId,
          threadId: input.threadId,
        })
        .pipe(
          Effect.tap(() =>
            Effect.logInfo("thread.auto-settled", {
              threadId: input.threadId,
            }),
          ),
          // Invariant rejections are routine races (a turn started between
          // snapshot and dispatch); anything else is logged and retried by
          // the next sweep.
          Effect.catch((error) =>
            Effect.logDebug("thread.auto-settle.dispatch-rejected", {
              threadId: input.threadId,
              error,
            }),
          ),
        );
    });

    const sweepOnce: ThreadAutoSettleReactor["Service"]["sweepOnce"] = Effect.gen(function* () {
      const [snapshot, afterDays, now] = yield* Effect.all([
        projectionSnapshotQuery.getShellSnapshot(),
        autoSettleAfterDays,
        Effect.map(DateTime.now, DateTime.formatIso),
      ]);
      const workspaceRootByProjectId = new Map(
        snapshot.projects.map((project) => [project.id, project.workspaceRoot]),
      );
      const mayVerifyPr = yield* backgroundPolicy.shouldRunOpportunisticWork;
      let verifyBudget = PR_VERIFY_MAX_PER_SWEEP;

      for (const thread of snapshot.threads) {
        const cwd = thread.worktreePath ?? workspaceRootByProjectId.get(thread.projectId);
        if (cwd === undefined) continue;
        const target = { branch: thread.branch, cwd };
        const verdict = resolveAutoSettleVerdict(thread, {
          now,
          autoSettleAfterDays: afterDays,
          changeRequestState: yield* peekChangeRequestState(target),
        });
        if (verdict.kind === "skip") continue;
        if (verdict.kind === "settle") {
          yield* settleThread({ threadId: thread.id });
          continue;
        }
        // verify-pr: quiet past the window but PR state undetermined (nothing
        // cached, or a possibly-stale cached "open").
        if (!mayVerifyPr || verifyBudget <= 0) continue;
        const verification = yield* verifyChangeRequestState(target);
        // Cooldown-suppressed lookups are free; only real refreshes (which
        // hit git and possibly the forge) consume the per-sweep budget.
        if (verification.verified) verifyBudget -= 1;
        const reVerdict = resolveAutoSettleVerdict(thread, {
          now,
          autoSettleAfterDays: afterDays,
          changeRequestState: verification.state,
        });
        if (reVerdict.kind === "settle") {
          yield* settleThread({ threadId: thread.id });
        }
      }
    }).pipe(
      Effect.catch((error: unknown) =>
        Effect.logWarning("thread.auto-settle.sweep-failed", { error }),
      ),
      Effect.catchDefect((defect: unknown) =>
        Effect.logWarning("thread.auto-settle.sweep-defect", { defect }),
      ),
    );

    const start: ThreadAutoSettleReactor["Service"]["start"] = () =>
      Effect.gen(function* () {
        yield* forkParked(
          sweepOnce.pipe(Effect.repeat(Schedule.spaced(Duration.millis(sweepIntervalMs)))),
        );
        yield* Effect.logInfo("thread.auto-settle.started", { sweepIntervalMs });
      });

    return ThreadAutoSettleReactor.of({
      start,
      sweepOnce,
    });
  });

export const layer = Layer.effect(ThreadAutoSettleReactor, make());
