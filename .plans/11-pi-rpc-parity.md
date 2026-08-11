# Pi Provider: RPC Parity Plan

## Status

Implemented and merged to `main` (commits `970ed712a` → `932e824f5`, pushed to `darjss/t3code`): items 1–6. Item 7 (full reasoning traces) deferred by the developer — it is a new feature to do last. Item 8 (bdsqqq durability ports) not started.

- **1. Failures surface as errors** — `970ed712a`
- **2. Interrupt reliability** — `f0f0543e2`
- **3. Drop cumulative tool snapshots** — `c8f111b0b`
- **4. Wire usage → context meter** — `807ead16e`
- **5. Wire dropped events** (compaction, retries, session names, extension errors) — `4ff494b0a`
- **6a. Native commands + remove slash/skill surface** — `2c7b473da`
- **6b. Native /compact end-to-end** — `932e824f5`

## Summary

Bring the Pi provider (`--mode rpc`) to near-parity with the Codex adapter and the pi TUI by consuming what pi already emits but the adapter drops, fixing the two known bugs, wiring token usage, and replacing pi's slash-command/skill surface with native T3 actions. Everything below is powered by pi 0.84.0's existing RPC protocol — no pi-side changes required except where noted.

## Decisions (confirmed)

- **Keep `--mode rpc`** as the integration surface. Extensions cannot extend the RPC protocol, and SDK embedding (`createAgentSession`) is the wrong fit for T3's per-instance subprocess isolation.
- **Skip plan-mode surface.** pi has no plan concept; `entry_appended`/plan entries are out of scope. No `turn.plan.updated` parity.
- **Keep full thinking traces.** Emit/stream `thinking_delta` → `reasoning_text` and never summarize. Explicitly do NOT chase `reasoning_summary_text` (Codex/Claude summarize; we keep the full trace — none of the other T3 adapters do).
- **No `turn.diff.updated`, `model.rerouted`, MCP OAuth, account/rate-limit, or auth-status parity** — the protocol does not emit them.
- **Replace the pi slash-command/skill surface** (`get_commands` mapping in `PiProvider.ts`) with native T3 UI actions that call RPC commands directly (`compact`, `set_model`, `cycle_thinking_level`, `abort_retry`, `new_session`/`fork`, …).
- **Copy the session-tree and durability work from bdsqqq's fork** instead of reimplementing.

---

## Implementation order (highest impact, smallest diff first)

### 1. Failures surface as errors (bug fix) — ~30 lines, 3 files

**Problem:** pi signals failure via `message_end`/`agent_end` (`stopReason: "error" | "aborted"`, `errorMessage`), which the adapter drops; failed runs settle as `turn.completed: "completed"`. The one `message_update` error branch is dead (pi never forwards it) and reads the wrong field (`reason` instead of `error.errorMessage`). `failActive` silently returns with no active turn. The UI row drops the `runtime.error` message.

- `apps/server/src/provider/Layers/PiAdapter.ts`
  - In `handleEvent`, track the last assistant outcome from `message_end`/`agent_end` (`stopReason`, `errorMessage`, `willRetry`).
  - In `agent_settled`, before publishing terminal events: if failure recorded and `!turn.interruptRequested`, call `failActive(ctx, errorMessage ?? "Pi assistant failed.", native)` instead of completing.
  - Fix the `message_update` error branch to read `update.error.errorMessage` (nested AssistantMessage), keep `reason` only as fallback, and don't treat `reason === "aborted"` as failure when `turn.interruptRequested` is set.
  - Let `failActive` emit a session-level `runtime.error` when no active turn exists (crash while idle).
- `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts:426-435` — carry `detail: message` on `runtime.error` activity payload (one line).
- `apps/web/src/session-logic.ts` (`extractToolDetail`) — fall back to `payload.message` when no `detail`.

### 2. Interrupt reliability (bug fix) — ~25 lines, 1 file

**Problem:** pi's `abort` never clears the steering/follow-up queues — a queued steer survives a single abort and `agent.continue()` runs a whole new turn. Also `interruptTurn` holds the thread lock while awaiting pi's abort response (which waits for idle), so Stop can hang or appear broken.

- `apps/server/src/provider/Layers/PiAdapter.ts`
  - In `agent_settled` when `turn.interruptRequested` and `getState` reports `isStreaming === true`: send another `ctx.client.abort()` and re-defer settlement (stops the steer continuation).
  - In the `agent_start` branch: if `turn.interruptRequested`, send `abort()` immediately (covers interrupt-before-run-start window).
  - `interruptTurn`: set `turn.interruptRequested` synchronously, then `Effect.fork`/`raceFirst`-with-timeout the `client.abort()` so the lock isn't held across the await; make abort errors best-effort.

### 3. Drop cumulative tool snapshots (perf) — ~10 lines, 1 file

**Problem:** pi's `tool_execution_update` partial result is a cumulative snapshot, not a delta; the adapter emits an `item.updated` per update (`PiAdapter.ts:964-993`), duplicating all prior output and outrunning the serial ingestion worker.

- Copy bdsqqq `a2651c96f`: skip persisting `tool_execution_update`; keep start/end. The `toolArgs` map already makes the dropped-update path safe.

### 4. Wire usage → composer context meter — ~40 lines, 2 files

**Problem:** no `thread.token-usage.updated`; the composer's `activeContextWindow` meter is dead for Pi.

- `apps/server/src/provider/pi/PiRpcClient.ts` — add `getSessionStats()` (`get_session_stats` → `{ input, output, cacheRead, cacheWrite, cost }` totals).
- `apps/server/src/provider/Layers/PiAdapter.ts` — on `turn_end`/`agent_settled`, poll stats and emit `thread.token-usage.updated` with a `ThreadTokenUsageSnapshot` (map input→inputTokens, output→outputTokens, cacheRead→cachedInputTokens; derive usedTokens/totalProcessedTokens; model context window from `get_state.model.contextWindow`).
- Consume `turn_end.message.usage`/`toolResults[].usage` when present as a delta source.

### 5. Wire dropped events — ~120 lines, 1 file (case branches in `handleEvent`)

| pi event | emit |
|---|---|
| `turn_start` / `turn_end` | `turn.started` / `turn.completed` (real boundaries; also feeds #4) |
| `message_start` | precise `item.started` ordering |
| `bash_execution_update` (`id`, `delta`) | `content.delta` with `streamKind: "command_output"` (live command output) |
| `compaction_start` / `compaction_end` | `item.started/completed` with `itemType: "context_compaction"` + thread state |
| `auto_retry_start` / `auto_retry_end` / `summarization_retry_*` | `runtime.warning` / item with retry status ("Retrying 2/3…") |
| `queue_update` (`steering[]`, `followUp[]`) | pending-count runtime event (honest steering UX) |
| `thinking_level_changed` | trait/effort indicator refresh |
| `session_info_changed` (`name`) | `thread.metadata.updated` (title follows the agent) |
| `extension_error` | `runtime.error` (class `provider_error`) |

### 6. Native commands from T3 (replaces slash/skill surface) — ~150 lines + UI

- Remove the `get_commands` → slashCommands/skills mapping in `apps/server/src/provider/Layers/PiProvider.ts:38-62,152-159` (and the `PiRpcSchema.PiRpcCommands` surface if nothing else uses it). Actions become T3-native.
- `PiRpcClient.ts` — add: `compact`, `cycleModel`, `cycleThinkingLevel`, `getAvailableThinkingLevels`, `setAutoRetry`, `abortRetry`, `steer`, `followUp`, `newSession`/`fork`, `getEntries`/`getTree` (title regeneration + fork support).
- Adapter methods on the provider shape: `compactThread`, `cycleModel`, `cycleThinkingLevel`, `retry`.
- UI: `/compact` action (composer menu or thread header — no compact action exists in the web UI today); thinking level via the existing `TraitsPicker` descriptor; model via existing model picker.
- Recommended command set: **`/compact`** (context management — highest value), **`/retry`** (recover a failed turn), **`/new`** (new session), **`/model`**, **`/thinking`** — each one call → one RPC command.

### 7. Reasoning traces render fully — verify + small fix

- Confirm `thinking_delta` → `reasoning_text` `content.delta` renders as an expandable full-trace item in the web timeline for Pi (the adapter emits it; check the UI path — the user reports seeing it in Codex but not Pi).
- If the timeline collapses/truncates reasoning, add Pi-specific full-text rendering. No summarization.

### 8. Copy from bdsqqq's fork (durability + session tree)

- **Settlement durability** (`cc363b6d3`): `setLifecycle` bridge + `PiExternalLifecycleOverrides` persistence + `validExternalLifecycleOverride()` race reconciliation — survives missed `agent_settled` across restarts. Ports on top of the existing `piNative/` supervisor (already byte-identical on `feat/pi-native-control`).
- **Semantic system messages** (`0bc925e65`): compaction/branch-summary/custom entries render as system chat messages in `PiSessionProjection.ts` + web/mobile timeline.
- **Sidebar session trees** (`6515e1d6a`, `c75aeb95e`): `buildSidebarThreadTree` with `parentThreadId` nesting — pi sub-sessions become navigable rows.
- **Provider session ownership** (`b65b46eb2`, `a0041b9e7`, `6e0cdc154`): committed-session listing + orphan reconciliation — the durability substrate the native work needs.

---

## Explicitly out of scope

- Plan steps / `entry_appended` plan entries (pi has no plan concept)
- Unified diff streaming (`turn.diff.updated`)
- `model.rerouted` (manual `cycle_model` only)
- Reasoning summaries (we keep full `thinking_delta` traces)
- MCP OAuth, account/rate-limit, `auth.status`
- SDK embedding (`createAgentSession`) — revisit only if the RPC surface is deprecated

## Rough order rationale

1–3 are bug/perf fixes (broken core UX) with tiny diffs → do first. 4 is the headline feature (context meter) and is small. 5 is the biggest parity jump per line. 6 removes a surface and adds real commands. 7 is a verify-and-possibly-fix. 8 is porting work from a known-good fork (largest, last).
