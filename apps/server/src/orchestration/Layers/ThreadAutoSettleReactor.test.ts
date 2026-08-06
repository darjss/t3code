// @effect-diagnostics globalDate:off -- fixtures are offsets from the real clock the sweep reads.
import {
  ProjectId,
  ProviderInstanceId,
  type ServerSettingsError,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationProjectShell,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { VcsStatusBroadcaster } from "../../vcs/VcsStatusBroadcaster.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ThreadAutoSettleReactor } from "../Services/ThreadAutoSettleReactor.ts";
import { makeThreadAutoSettleReactorLive } from "./ThreadAutoSettleReactor.ts";

const NOW_MS = Date.now();
const STALE = new Date(NOW_MS - 4 * 24 * 60 * 60 * 1_000).toISOString();
const FRESH = new Date(NOW_MS - 60 * 60 * 1_000).toISOString();

function makeProject(): OrchestrationProjectShell {
  return {
    id: ProjectId.make("project-1"),
    title: "Project",
    workspaceRoot: "/workspace/project-1",
    defaultModelSelection: null,
    scripts: [],
    createdAt: STALE,
    updatedAt: STALE,
  };
}

function makeThread(input: {
  readonly id: string;
  readonly activityAt: string | null;
  readonly settledOverride?: "settled" | "active" | null;
  readonly branch?: string | null;
}): OrchestrationThreadShell {
  return {
    id: ThreadId.make(input.id),
    projectId: ProjectId.make("project-1"),
    title: input.id,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: input.branch ?? null,
    worktreePath: null,
    latestTurn: null,
    createdAt: STALE,
    updatedAt: STALE,
    archivedAt: null,
    settledOverride: input.settledOverride ?? null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    session: null,
    latestUserMessageAt: input.activityAt,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
}

function makeHarness(input: {
  readonly threads: ReadonlyArray<OrchestrationThreadShell>;
  readonly settingsOverrides?: Parameters<typeof ServerSettingsService.layerTest>[0];
}) {
  const dispatched: OrchestrationCommand[] = [];
  const snapshot: OrchestrationShellSnapshot = {
    snapshotSequence: 1,
    projects: [makeProject()],
    threads: input.threads,
    updatedAt: STALE,
  };
  const layer = makeThreadAutoSettleReactorLive().pipe(
    Layer.provide(
      Layer.mock(OrchestrationEngineService)({
        dispatch: (command) =>
          Effect.sync(() => {
            dispatched.push(command);
            return { sequence: dispatched.length };
          }),
      }),
    ),
    Layer.provide(
      Layer.mock(ProjectionSnapshotQuery)({
        getShellSnapshot: () => Effect.succeed(snapshot),
      }),
    ),
    Layer.provide(
      Layer.succeed(VcsStatusBroadcaster, {
        getStatus: () => Effect.die("getStatus should not be called"),
        peekStatus: () => Effect.succeed(null),
        refreshLocalStatus: () => Effect.die("refreshLocalStatus should not be called"),
        refreshStatus: () => Effect.die("refreshStatus should not be called"),
        streamStatus: () => Stream.empty,
      }),
    ),
    Layer.provide(
      Layer.mock(BackgroundPolicy.BackgroundPolicy)({
        // Not opportunistic: the cold-cwd PR verification path (which would
        // hit git and the forge) must stay off in these tests.
        shouldRunOpportunisticWork: Effect.succeed(false),
      }),
    ),
    Layer.provide(ServerSettingsService.layerTest(input.settingsOverrides ?? {})),
    Layer.provide(NodeServices.layer),
  );
  return { dispatched, layer };
}

const runSweep = (layer: Layer.Layer<ThreadAutoSettleReactor, ServerSettingsError>) =>
  Effect.service(ThreadAutoSettleReactor).pipe(
    Effect.flatMap((reactor) => reactor.sweepOnce),
    Effect.provide(layer),
    Effect.orDie,
  );

describe("ThreadAutoSettleReactor", () => {
  // it.live: fixtures are offsets from the real clock the sweep reads; the
  // TestClock's epoch-zero "now" would put every fixture in the future.
  it.live("settles quiet threads past the window and stamps their last activity", () =>
    Effect.gen(function* () {
      const { dispatched, layer } = makeHarness({
        threads: [
          makeThread({ id: "stale", activityAt: STALE }),
          makeThread({ id: "fresh", activityAt: FRESH }),
          makeThread({ id: "pinned-active", activityAt: STALE, settledOverride: "active" }),
          makeThread({ id: "already-settled", activityAt: STALE, settledOverride: "settled" }),
        ],
      });
      yield* runSweep(layer);

      expect(dispatched).toHaveLength(1);
      const command = dispatched[0];
      expect(command?.type).toBe("thread.settle");
      if (command?.type === "thread.settle") {
        expect(command.threadId).toBe("stale");
        expect(command.settledAt).toBe(STALE);
        expect(command.commandId.startsWith("server:auto-settle:")).toBe(true);
      }
    }),
  );

  it.live("does nothing with auto-settle disabled", () =>
    Effect.gen(function* () {
      const { dispatched, layer } = makeHarness({
        threads: [makeThread({ id: "stale", activityAt: STALE })],
        settingsOverrides: { threadAutoSettleAfterDays: null },
      });
      yield* runSweep(layer);

      expect(dispatched).toHaveLength(0);
    }),
  );

  it.live("defers a quiet branch-carrying thread with no cached PR state", () =>
    Effect.gen(function* () {
      // peekStatus returns null (nothing cached) and opportunistic work is
      // off, so the sweep can neither confirm nor rule out an open PR — it
      // must leave the thread alone rather than hide work waiting on review.
      const { dispatched, layer } = makeHarness({
        threads: [makeThread({ id: "stale-branch", activityAt: STALE, branch: "feature/x" })],
      });
      yield* runSweep(layer);

      expect(dispatched).toHaveLength(0);
    }),
  );
});
