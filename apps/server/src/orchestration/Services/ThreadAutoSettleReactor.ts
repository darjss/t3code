/**
 * ThreadAutoSettleReactor - Server-side auto-settle sweep service interface.
 *
 * The server is the single author of settled state: this reactor periodically
 * evaluates unsettled threads against the auto-settle policy (inactivity
 * window from the threadAutoSettleAfterDays server setting, merged/closed PR)
 * and dispatches thread.settle for the ones that qualify. Clients only read
 * settledOverride.
 *
 * @module ThreadAutoSettleReactor
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

/**
 * ThreadAutoSettleReactorShape - Service API for the auto-settle sweep.
 */
export interface ThreadAutoSettleReactorShape {
  /**
   * Start the periodic auto-settle sweep within the provided scope.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;

  /**
   * Run one sweep immediately. Intended for tests, which must never wait on
   * the timer schedule.
   */
  readonly sweepOnce: Effect.Effect<void>;
}

export class ThreadAutoSettleReactor extends Context.Service<
  ThreadAutoSettleReactor,
  ThreadAutoSettleReactorShape
>()("t3/orchestration/Services/ThreadAutoSettleReactor") {}
