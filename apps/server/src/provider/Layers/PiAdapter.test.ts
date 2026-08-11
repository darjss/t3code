// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ApprovalRequestId,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as NodeAssert from "node:assert/strict";

import {
  PiRpcCommandError,
  type PiRpcClient,
  type PiRpcImage,
  PiRpcProtocolError,
  type PiRpcSpawnOptions,
} from "../pi/PiRpcClient.ts";
import type { PiRpcEvent, PiRpcSessionStats, PiThinkingLevel } from "../pi/PiRpcSchema.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import { makePiAdapter, type PiRpcClientFactory } from "./PiAdapter.ts";

const assert: typeof NodeAssert = NodeAssert;
const fs = NodeFS;
const os = NodeOS;
const path = NodePath;
const instanceId = ProviderInstanceId.make("pi-test");
const modelSelection = createModelSelection(instanceId, "openai/gpt-5", [
  { id: "thinkingLevel", value: "max" },
]);
type Adapter = ProviderAdapterShape<ProviderAdapterError>;

class FakeClient implements PiRpcClient {
  // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- The synchronous fake exposes its queue through the PiRpcClient stream interface.
  input = Effect.runSync(Queue.unbounded<PiRpcEvent>());
  events: Stream.Stream<PiRpcEvent> = Stream.fromQueue(this.input);
  readonly calls = {
    close: 0,
    abort: 0,
    prompt: 0,
    prompts: [] as Array<{
      message: string;
      images: ReadonlyArray<PiRpcImage> | undefined;
      streamingBehavior?: "steer" | "followUp";
    }>,
    thinking: [] as PiThinkingLevel[],
    sessionStats: 0,
    compact: 0,
    extensionUiResponses: [] as Array<Record<string, unknown>>,
  };
  state: { sessionFile?: string; sessionId?: string; isStreaming?: boolean } = {};
  getStateResults: Array<typeof this.state> = [];
  sessionStats: PiRpcSessionStats = {};
  failPrompt = false;
  fatalPrompt = false;
  abortBeforeSettle = false;
  getStateEntered: Deferred.Deferred<void> | undefined;
  getStateGate: Deferred.Deferred<void> | undefined;
  getAvailableModelsEntered: Deferred.Deferred<void> | undefined;
  getAvailableModelsGate: Deferred.Deferred<void> | undefined;
  promptEntered: Deferred.Deferred<void> | undefined;
  promptGate: Deferred.Deferred<void> | undefined;
  closeEntered: Deferred.Deferred<void> | undefined;
  closeGate: Deferred.Deferred<void> | undefined;

  getState = () => {
    const self = this;
    return Effect.gen(function* () {
      if (self.getStateEntered) yield* Deferred.succeed(self.getStateEntered, undefined);
      if (self.getStateGate) yield* Deferred.await(self.getStateGate);
      return self.getStateResults.shift() ?? self.state;
    });
  };
  getSessionStats = () =>
    Effect.sync(() => {
      this.calls.sessionStats += 1;
      return this.sessionStats;
    });
  cycleModel = () => Effect.die("unused");
  cycleThinkingLevel = () => Effect.die("unused");
  getAvailableThinkingLevels = () => Effect.die("unused");
  compact = () =>
    Effect.sync(() => {
      this.calls.compact += 1;
    });
  abortRetry = () => Effect.die("unused");
  steer = () => Effect.die("unused");
  followUp = () => Effect.die("unused");
  getAvailableModels = () => {
    const self = this;
    return Effect.gen(function* () {
      if (self.getAvailableModelsEntered)
        yield* Deferred.succeed(self.getAvailableModelsEntered, undefined);
      if (self.getAvailableModelsGate) yield* Deferred.await(self.getAvailableModelsGate);
      return { models: [{ provider: "openai", id: "gpt-5", reasoning: true }] };
    });
  };
  getCommands = () => Effect.succeed({ commands: [] });
  setModel = (provider: string, id: string) => Effect.succeed({ provider, id });
  setThinkingLevel = (level: PiThinkingLevel) =>
    Effect.sync(() => {
      this.calls.thinking.push(level);
    });
  prompt = (
    message: string,
    images?: ReadonlyArray<PiRpcImage>,
    streamingBehavior?: "steer" | "followUp",
  ) => {
    const self = this;
    return Effect.gen(function* () {
      self.calls.prompt += 1;
      self.calls.prompts.push({
        message,
        images,
        ...(streamingBehavior ? { streamingBehavior } : {}),
      });
      if (self.promptEntered) yield* Deferred.succeed(self.promptEntered, undefined);
      if (self.promptGate) yield* Deferred.await(self.promptGate);
      if (self.failPrompt)
        return yield* new PiRpcCommandError({
          command: "prompt",
          requestId: "test",
          detail: "prompt failed",
        });
      if (self.fatalPrompt)
        return yield* new PiRpcProtocolError({ detail: "prompt transport failed" });
    });
  };
  abort = () => {
    const self = this;
    return Effect.gen(function* () {
      self.calls.abort += 1;
      if (self.abortBeforeSettle) yield* Queue.offer(self.input, { type: "agent_settled" });
    });
  };
  respondToExtensionUi = (response: Record<string, unknown>) =>
    Effect.sync(() => {
      this.calls.extensionUiResponses.push(response);
    });
  close = () => {
    const self = this;
    return Effect.gen(function* () {
      self.calls.close += 1;
      if (self.closeEntered) yield* Deferred.succeed(self.closeEntered, undefined);
      if (self.closeGate) yield* Deferred.await(self.closeGate);
    });
  };
}

interface Harness {
  readonly client: FakeClient;
  readonly spawns: PiRpcSpawnOptions[];
  readonly stateDir: string;
  readonly attachmentsDir: string;
  readonly makeClient: PiRpcClientFactory;
}

const collectThroughSentinel = Effect.fn("PiAdapterTest.collectThroughSentinel")(function* (
  adapter: Adapter,
) {
  let sentinelTurnId: string | undefined;
  const collected = yield* adapter.streamEvents.pipe(
    Stream.takeUntil((event) => event.type === "turn.completed" && event.turnId === sentinelTurnId),
    Stream.runCollect,
    Effect.forkChild,
  );
  return {
    collected,
    setSentinel: (turnId: string) => {
      sentinelTurnId = turnId;
    },
  };
});

const makeHarness = (harnessOptions: { readonly failStart?: boolean } = {}): Harness => {
  const client = new FakeClient();
  const spawns: PiRpcSpawnOptions[] = [];
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-pi-adapter-"));
  const attachmentsDir = path.join(stateDir, "attachments");
  fs.mkdirSync(attachmentsDir, { recursive: true });
  const makeClient: PiRpcClientFactory = (spawnOptions) =>
    Effect.gen(function* () {
      spawns.push(spawnOptions);
      if (harnessOptions.failStart) {
        return yield* new PiRpcCommandError({
          command: "spawn",
          requestId: "test",
          detail: "spawn failed",
        });
      }
      const sessionIndex = spawnOptions.args?.indexOf("--session") ?? -1;
      const sessionFile = spawnOptions.args?.[sessionIndex + 1];
      assert.ok(sessionFile);
      const sessionId = "pi-generated-session-id";
      fs.writeFileSync(
        sessionFile,
        `{"type":"session","id":"${sessionId}","cwd":"${spawnOptions.cwd}"}\n`,
      );
      client.state = { sessionFile, sessionId };
      return client;
    });
  return { client, spawns, stateDir, attachmentsDir, makeClient };
};

const withAdapter = <A>(
  harness: Harness,
  use: (adapter: Adapter) => Effect.Effect<A, ProviderAdapterError>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const adapter = yield* makePiAdapter({
        binaryPath: "pi",
        providerInstanceId: instanceId,
        stateDir: harness.stateDir,
        attachmentsDir: harness.attachmentsDir,
        makeRpcClient: harness.makeClient,
      });
      return yield* use(adapter);
    }),
  ).pipe(Effect.provide(NodeServices.layer));

const start = (adapter: Adapter, id = "thread") =>
  adapter.startSession({
    provider: ProviderDriverKind.make("pi"),
    providerInstanceId: instanceId,
    threadId: ThreadId.make(id),
    cwd: process.cwd(),
    runtimeMode: "full-access",
  });

describe("PiAdapter", () => {
  it.effect("allocates an exact durable session and rejects non-full-access before spawn", () => {
    const h = makeHarness();
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        const rejected = yield* adapter
          .startSession({
            threadId: ThreadId.make("rejected"),
            runtimeMode: "approval-required",
          })
          .pipe(Effect.result);
        assert.equal(rejected._tag, "Failure");
        if (rejected._tag === "Failure")
          assert.equal(rejected.failure._tag, "ProviderAdapterValidationError");
        assert.equal(h.spawns.length, 0);

        const session = yield* start(adapter);
        const cursor = session.resumeCursor as {
          schemaVersion: number;
          sessionFile: string;
          sessionId: string;
        };
        assert.equal(cursor.schemaVersion, 1);
        assert.equal(h.client.state.sessionFile, cursor.sessionFile);
        assert.equal(h.client.state.sessionId, cursor.sessionId);
        const args = h.spawns[0]?.args ?? [];
        assert.deepEqual(args.slice(args.indexOf("--session"), args.indexOf("--session") + 2), [
          "--session",
          cursor.sessionFile,
        ]);
        assert.equal(args.includes("--no-session"), false);
        assert.equal(args.includes("--offline"), true);
        for (const arg of [
          "--no-context-files",
          "--no-extensions",
          "--no-skills",
          "--no-prompt-templates",
        ])
          assert.equal(args.includes(arg), false);
      }),
    );
  });

  it.effect("passes the thread-scoped browser credential to Pi extensions", () => {
    const h = makeHarness();
    const threadId = ThreadId.make("thread");
    McpProviderSession.setMcpProviderSession({
      environmentId: EnvironmentId.make("environment"),
      threadId,
      providerSessionId: "provider-session",
      providerInstanceId: instanceId,
      endpoint: "http://127.0.0.1:13773/mcp",
      authorizationHeader: "Bearer browser-secret",
    });
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        yield* start(adapter);
        assert.deepEqual(h.spawns[0]?.env, {
          T3_BROWSER_MCP_ENDPOINT: "http://127.0.0.1:13773/mcp",
          T3_BROWSER_MCP_BEARER_TOKEN: "browser-secret",
        });
      }),
    ).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          McpProviderSession.clearMcpProviderSession(threadId);
        }),
      ),
    );
  });

  it.effect("sends persisted image attachments through Pi RPC", () => {
    const h = makeHarness();
    const attachmentId = "thread-image";
    fs.writeFileSync(path.join(h.attachmentsDir, `${attachmentId}.png`), Buffer.from("image"));
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        yield* start(adapter);
        yield* adapter.sendTurn({
          threadId: ThreadId.make("thread"),
          attachments: [
            {
              type: "image",
              id: attachmentId,
              name: "screenshot.png",
              mimeType: "image/png",
              sizeBytes: 5,
            },
          ],
          modelSelection,
        });
        assert.deepEqual(h.client.calls.prompts, [
          {
            message: "",
            images: [
              {
                type: "image",
                data: Buffer.from("image").toString("base64"),
                mimeType: "image/png",
              },
            ],
          },
        ]);
        yield* Queue.offer(h.client.input, { type: "agent_settled" });
      }),
    );
  });

  it.effect("settles extension slash commands that do not start an agent", () => {
    const h = makeHarness();
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        yield* start(adapter);
        const collected = yield* Stream.take(adapter.streamEvents, 2).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );
        const turn = yield* adapter.sendTurn({
          threadId: ThreadId.make("thread"),
          input: "/workflows",
          modelSelection,
        });
        const events = Array.from(yield* Fiber.join(collected));
        assert.deepEqual(
          events.map((event) => event.type),
          ["turn.started", "turn.completed"],
        );
        assert.equal(events[1]?.turnId, turn.turnId);
      }),
    );
  });

  it.effect("answers extension UI requests while prompt preflight is waiting", () => {
    const h = makeHarness();
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        yield* start(adapter);
        h.client.promptEntered = yield* Deferred.make<void>();
        h.client.promptGate = yield* Deferred.make<void>();
        const requestedFiber = yield* adapter.streamEvents.pipe(
          Stream.filter(
            (event): event is Extract<ProviderRuntimeEvent, { type: "user-input.requested" }> =>
              event.type === "user-input.requested",
          ),
          Stream.runHead,
          Effect.forkChild,
        );
        const sendFiber = yield* adapter
          .sendTurn({
            threadId: ThreadId.make("thread"),
            input: "ask first",
            modelSelection,
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(h.client.promptEntered);
        yield* Queue.offer(h.client.input, {
          type: "extension_ui_request",
          id: "confirm-1",
          method: "confirm",
          title: "Approve command",
          message: "Run the command?",
        });
        const requested = yield* Fiber.join(requestedFiber);
        assert.equal(Option.isSome(requested), true);
        if (Option.isNone(requested)) return;
        const question = requested.value.payload.questions[0];
        assert.equal(question?.question, "Run the command?");
        assert.deepEqual(
          question?.options.map((option) => option.label),
          ["Yes", "No"],
        );
        yield* adapter.respondToUserInput(
          ThreadId.make("thread"),
          ApprovalRequestId.make(String(requested.value.requestId)),
          { [question!.id]: "Yes" },
        );
        assert.deepEqual(h.client.calls.extensionUiResponses, [
          { id: "confirm-1", confirmed: true },
        ]);
        yield* Deferred.succeed(h.client.promptGate, undefined);
        yield* Fiber.join(sendFiber);
        yield* Queue.offer(h.client.input, { type: "agent_settled" });
      }),
    );
  });

  it.effect("projects Pi built-in tools into useful canonical tool call details", () => {
    const h = makeHarness();
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        yield* start(adapter);
        const collected = yield* Stream.take(adapter.streamEvents, 5).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* adapter.sendTurn({
          threadId: ThreadId.make("thread"),
          input: "inspect and edit",
          modelSelection,
        });
        yield* Queue.offerAll(h.client.input, [
          {
            type: "tool_execution_start",
            toolCallId: "bash-1",
            toolName: "bash",
            args: { command: "git status --short" },
          },
          {
            type: "tool_execution_update",
            toolCallId: "bash-1",
            toolName: "bash",
            args: { command: "git status --short" },
            partialResult: {
              content: [{ type: "text", text: " M apps/server/src/provider/Layers/PiAdapter.ts" }],
              details: { truncation: null },
            },
          },
          {
            type: "tool_execution_end",
            toolCallId: "bash-1",
            toolName: "bash",
            result: {
              content: [{ type: "text", text: " M apps/server/src/provider/Layers/PiAdapter.ts" }],
              details: { truncation: null },
            },
            isError: false,
          },
          {
            type: "tool_execution_start",
            toolCallId: "edit-1",
            toolName: "edit",
            args: { path: "src/app.ts", oldText: "old", newText: "new" },
          },
          {
            type: "tool_execution_update",
            toolCallId: "edit-1",
            toolName: "edit",
            args: { path: "src/app.ts", oldText: "old", newText: "new" },
            partialResult: { content: [{ type: "text", text: "Editing src/app.ts" }] },
          },
          {
            type: "tool_execution_end",
            toolCallId: "edit-1",
            toolName: "edit",
            result: {
              content: [{ type: "text", text: "Successfully replaced text in src/app.ts" }],
              details: { diff: "-old\n+new" },
            },
            isError: false,
          },
        ]);

        const events = Array.from(yield* Fiber.join(collected));
        const tools = events.filter(
          (
            event,
          ): event is Extract<
            ProviderRuntimeEvent,
            { type: "item.started" | "item.updated" | "item.completed" }
          > =>
            event.type === "item.started" ||
            event.type === "item.updated" ||
            event.type === "item.completed",
        );
        assert.equal(tools.length, 4);
        assert.deepEqual(tools[1]?.payload, {
          itemType: "command_execution",
          title: "Ran command",
          status: "completed",
          data: {
            toolCallId: "bash-1",
            toolName: "bash",
            kind: "execute",
            command: "git status --short",
            rawInput: { command: "git status --short" },
            rawOutput: {
              content: "M apps/server/src/provider/Layers/PiAdapter.ts",
              truncation: null,
            },
            item: { input: { command: "git status --short" } },
          },
        });
        assert.deepEqual(tools[3]?.payload, {
          itemType: "file_change",
          title: "Edited file",
          detail: "src/app.ts",
          status: "completed",
          data: {
            toolCallId: "edit-1",
            toolName: "edit",
            kind: "edit",
            rawInput: { path: "src/app.ts", oldText: "old", newText: "new" },
            rawOutput: {
              content: "Successfully replaced text in src/app.ts",
              diff: "-old\n+new",
            },
            item: {
              input: { path: "src/app.ts", oldText: "old", newText: "new" },
              changes: [{ path: "src/app.ts" }],
            },
          },
        });
      }),
    );
  });

  it.effect("classifies Pi agent-backed tools as collaboration work", () => {
    const h = makeHarness();
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        yield* start(adapter);
        const collected = yield* Stream.take(adapter.streamEvents, 3).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* adapter.sendTurn({
          threadId: ThreadId.make("thread"),
          input: "delegate this",
          modelSelection,
        });
        yield* Queue.offerAll(h.client.input, [
          {
            type: "tool_execution_start",
            toolCallId: "agent-1",
            toolName: "security_scout",
            args: { query: "Locate the authentication flow" },
          },
          {
            type: "tool_execution_update",
            toolCallId: "agent-1",
            toolName: "security_scout",
            partialResult: {
              content: [{ type: "text", text: "Searching" }],
              details: { agent: "security_scout", task: "Locate the authentication flow" },
            },
          },
          {
            type: "tool_execution_end",
            toolCallId: "agent-1",
            toolName: "security_scout",
            result: {
              content: [{ type: "text", text: "Found the flow" }],
              details: { agent: "security_scout", task: "Locate the authentication flow" },
            },
            isError: false,
          },
        ]);

        const events = Array.from(yield* Fiber.join(collected));
        const tools = events.filter(
          (
            event,
          ): event is Extract<
            ProviderRuntimeEvent,
            { type: "item.started" | "item.updated" | "item.completed" }
          > =>
            event.type === "item.started" ||
            event.type === "item.updated" ||
            event.type === "item.completed",
        );
        assert.equal(tools.length, 2);
        assert.equal(tools[0]?.payload.itemType, "dynamic_tool_call");
        for (const event of tools.slice(1)) {
          assert.equal(event.payload.itemType, "collab_agent_tool_call");
          assert.equal(event.payload.title, "Security scout agent");
          assert.equal(event.payload.detail, "Locate the authentication flow");
          assert.equal(
            (event.payload.data as Record<string, unknown> | undefined)?.toolName,
            "security_scout",
          );
        }
      }),
    );
  });

  it.effect("projects background subagents into task lifecycle events and a follow-up turn", () => {
    const h = makeHarness();
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        yield* start(adapter);
        let completedTurns = 0;
        const collected = yield* adapter.streamEvents.pipe(
          Stream.takeUntil((event) => {
            if (event.type !== "turn.completed") return false;
            completedTurns += 1;
            return completedTurns === 2;
          }),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* adapter.sendTurn({
          threadId: ThreadId.make("thread"),
          input: "delegate this",
          modelSelection,
        });
        yield* Queue.offerAll(h.client.input, [
          {
            type: "tool_execution_start",
            toolCallId: "spawn-1",
            toolName: "subagent_spawn",
            args: {
              name: "Security review",
              harness: "pi",
              model: "openai/gpt-5",
              reasoning_effort: "high",
            },
          },
          {
            type: "tool_execution_end",
            toolCallId: "spawn-1",
            toolName: "subagent_spawn",
            result: {
              content: [{ type: "text", text: "Spawned sa-1" }],
              details: {
                id: "sa-1",
                title: "Security review",
                harness: "pi",
                model: "openai/gpt-5",
              },
            },
            isError: false,
          },
          { type: "agent_settled" },
          { type: "agent_start" },
          {
            type: "message_end",
            message: {
              role: "custom",
              customType: "subagent-result",
              content: "Subagent sa-1 finished.",
              details: { id: "sa-1", title: "Security review", status: "done" },
            },
          },
          {
            type: "message_update",
            assistantMessageEvent: { type: "text_delta", delta: "Review complete" },
          },
          { type: "agent_settled" },
        ]);

        const events = Array.from(yield* Fiber.join(collected));
        const tasks = events.filter(
          (
            event,
          ): event is Extract<
            ProviderRuntimeEvent,
            { type: "task.started" | "task.progress" | "task.completed" }
          > =>
            event.type === "task.started" ||
            event.type === "task.progress" ||
            event.type === "task.completed",
        );
        assert.deepEqual(
          tasks.map((event) => event.type),
          ["task.started", "task.progress", "task.completed"],
        );
        assert.equal(new Set(tasks.map((event) => event.payload.taskId)).size, 1);
        const started = tasks.find((event) => event.type === "task.started");
        const completed = tasks.find((event) => event.type === "task.completed");
        assert.equal(started?.payload.title, "Security review");
        assert.equal(started?.payload.role, "pi");
        assert.equal(completed?.payload.status, "completed");
        assert.equal(events.filter((event) => event.type === "turn.started").length, 2);
        assert.equal(
          events.some(
            (event) => event.type === "content.delta" && event.payload.delta === "Review complete",
          ),
          true,
        );
      }),
    );
  });

  it.effect("projects workflow agent progress into the Agents panel lifecycle", () => {
    const h = makeHarness();
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        yield* start(adapter);
        const stream = yield* collectThroughSentinel(adapter);
        const turn = yield* adapter.sendTurn({
          threadId: ThreadId.make("thread"),
          input: "run workflow",
          modelSelection,
        });
        stream.setSentinel(turn.turnId);
        const runningDetails = {
          runId: "wf-1",
          name: "Audit",
          phases: [{ title: "Scan" }],
          agents: [
            {
              index: 0,
              label: "Security scan",
              phase: "Scan",
              state: "running",
              model: "openai/gpt-5",
              startedAt: 100,
              preview: "Checking auth",
              usage: { input: 10, output: 2, cacheRead: 3 },
            },
          ],
        };
        yield* Queue.offerAll(h.client.input, [
          {
            type: "tool_execution_start",
            toolCallId: "workflow-1",
            toolName: "workflow",
            args: { script: "return {}" },
          },
          {
            type: "tool_execution_update",
            toolCallId: "workflow-1",
            toolName: "workflow",
            partialResult: {
              content: [{ type: "text", text: "starting" }],
              details: { ...runningDetails, agents: [] },
            },
          },
          {
            type: "tool_execution_update",
            toolCallId: "workflow-1",
            toolName: "workflow",
            partialResult: {
              content: [{ type: "text", text: "running" }],
              details: runningDetails,
            },
          },
          {
            type: "tool_execution_end",
            toolCallId: "workflow-1",
            toolName: "workflow",
            result: {
              content: [{ type: "text", text: "done" }],
              details: {
                ...runningDetails,
                agents: [
                  {
                    ...runningDetails.agents[0],
                    state: "done",
                    finishedAt: 250,
                    preview: "Auth checked",
                    usage: { input: 20, output: 5, cacheRead: 4 },
                  },
                ],
              },
            },
            isError: false,
          },
          { type: "agent_settled" },
        ]);

        const events = Array.from(yield* Fiber.join(stream.collected));
        const tasks = events.filter(
          (
            event,
          ): event is Extract<
            ProviderRuntimeEvent,
            { type: "task.started" | "task.progress" | "task.completed" }
          > =>
            event.type === "task.started" ||
            event.type === "task.progress" ||
            event.type === "task.completed",
        );
        assert.deepEqual(
          tasks.map((event) => event.type),
          ["task.started", "task.started", "task.progress", "task.completed", "task.completed"],
        );
        const coordinator = tasks.find(
          (event) => event.type === "task.started" && event.payload.taskType === "local_workflow",
        );
        const started = tasks.find(
          (event) => event.type === "task.started" && event.payload.taskType === "workflow-agent",
        );
        const progress = tasks.find((event) => event.type === "task.progress");
        const completed = tasks.find(
          (event): event is Extract<ProviderRuntimeEvent, { type: "task.completed" }> =>
            event.type === "task.completed" && event.payload.taskType === "workflow-agent",
        );
        assert.equal(coordinator?.payload.title, "Audit");
        assert.equal(started?.payload.parentAgentId, coordinator?.payload.taskId);
        assert.equal(started?.payload.workflowName, "Audit");
        assert.equal(started?.payload.phaseTitle, "Scan");
        assert.equal(progress?.payload.typedUsage?.totalTokens, 12);
        assert.equal(completed?.payload.typedUsage?.durationMs, 150);
        assert.equal(completed?.payload.status, "completed");
      }),
    );
  });

  it.effect("keeps one T3 turn across native cycles and settles only at agent_settled", () => {
    const h = makeHarness();
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        yield* start(adapter);
        const collected = yield* Stream.take(adapter.streamEvents, 5).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );
        const turn = yield* adapter.sendTurn({
          threadId: ThreadId.make("thread"),
          input: "hello",
          modelSelection,
        });
        yield* Queue.offerAll(h.client.input, [
          { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hi" } },
          { type: "agent_end" },
          { type: "turn_end" },
          { type: "turn_start" },
          { type: "agent_settled" },
        ]);
        const events = Array.from(yield* Fiber.join(collected));
        assert.deepEqual(
          events.map((event) => event.type),
          ["turn.started", "item.started", "content.delta", "item.completed", "turn.completed"],
        );
        assert.equal(
          events.every((event) => event.turnId === turn.turnId),
          true,
        );
        assert.equal(events[1]?.itemId, events[2]?.itemId);
        assert.equal(events[2]?.itemId, events[3]?.itemId);
        assert.deepEqual(h.client.calls.thinking, ["max"]);
      }),
    );
  });

  it.effect(
    "suppresses blank assistant items and records interruption before abort settles",
    () => {
      const h = makeHarness();
      h.client.abortBeforeSettle = true;
      return withAdapter(h, (adapter) =>
        Effect.gen(function* () {
          yield* start(adapter);
          const collected = yield* Stream.take(adapter.streamEvents, 2).pipe(
            Stream.runCollect,
            Effect.forkChild,
          );
          const turn = yield* adapter.sendTurn({
            threadId: ThreadId.make("thread"),
            input: "hello",
            modelSelection,
          });
          yield* adapter.interruptTurn(ThreadId.make("thread"), turn.turnId);
          const events = Array.from(yield* Fiber.join(collected));
          assert.deepEqual(
            events.map((event) => event.type),
            ["turn.started", "turn.completed"],
          );
          const terminal = events[1] as Extract<ProviderRuntimeEvent, { type: "turn.completed" }>;
          assert.equal(terminal.payload.state, "interrupted");
        }),
      );
    },
  );

  it.effect("re-aborts a pi run that keeps streaming after an interrupt", () => {
    const h = makeHarness();
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        yield* start(adapter);
        const fence = yield* collectThroughSentinel(adapter);
        const accepted = yield* adapter.sendTurn({
          threadId: ThreadId.make("thread"),
          input: "hello",
          modelSelection,
        });
        fence.setSentinel(accepted.turnId);
        yield* adapter.interruptTurn(ThreadId.make("thread"), accepted.turnId);
        while (h.client.calls.abort < 1) yield* Effect.yieldNow;
        h.client.getStateResults = [{ ...h.client.state, isStreaming: true }, h.client.state];
        yield* Queue.offerAll(h.client.input, [
          { type: "agent_settled" },
          { type: "agent_settled" },
        ]);
        const events = Array.from(yield* Fiber.join(fence.collected));
        while (h.client.calls.abort < 2) yield* Effect.yieldNow;
        assert.equal(h.client.calls.abort, 2);
        const terminal = events.filter(
          (event) => event.type === "turn.completed" && event.turnId === accepted.turnId,
        );
        assert.equal(terminal.length, 1);
        assert.equal(
          (terminal[0] as Extract<ProviderRuntimeEvent, { type: "turn.completed" }>).payload.state,
          "interrupted",
        );
      }),
    );
  });

  it.effect("aborts a steer continuation that starts after an interrupt", () => {
    const h = makeHarness();
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        yield* start(adapter);
        const fence = yield* collectThroughSentinel(adapter);
        const accepted = yield* adapter.sendTurn({
          threadId: ThreadId.make("thread"),
          input: "hello",
          modelSelection,
        });
        fence.setSentinel(accepted.turnId);
        yield* Queue.offer(h.client.input, { type: "agent_start" });
        const steer = yield* adapter.sendTurn({
          threadId: ThreadId.make("thread"),
          input: "instead do this",
          modelSelection,
        });
        yield* adapter.interruptTurn(ThreadId.make("thread"), accepted.turnId);
        yield* Queue.offer(h.client.input, { type: "agent_start" });
        yield* Queue.offer(h.client.input, { type: "agent_settled" });
        const events = Array.from(yield* Fiber.join(fence.collected));
        assert.equal(h.client.calls.abort, 2);
        const terminal = events.filter(
          (event) => event.type === "turn.completed" && event.turnId === accepted.turnId,
        );
        assert.equal(terminal.length, 1);
        assert.equal(
          (terminal[0] as Extract<ProviderRuntimeEvent, { type: "turn.completed" }>).payload.state,
          "interrupted",
        );
        assert.equal(steer.turnId, accepted.turnId);
      }),
    );
  });

  it.effect("terminalizes an accepted turn before explicit stop closes its session", () => {
    const h = makeHarness();
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        yield* start(adapter);
        const fence = yield* collectThroughSentinel(adapter);
        const accepted = yield* adapter.sendTurn({
          threadId: ThreadId.make("thread"),
          input: "hello",
          modelSelection,
        });
        yield* adapter.stopSession(ThreadId.make("thread"));
        yield* start(adapter);
        const sentinel = yield* adapter.sendTurn({
          threadId: ThreadId.make("thread"),
          input: "sentinel",
          modelSelection,
        });
        fence.setSentinel(sentinel.turnId);
        yield* Queue.offer(h.client.input, { type: "agent_settled" });
        const events = Array.from(yield* Fiber.join(fence.collected));
        const acceptedEvents = events.filter((event) => event.turnId === accepted.turnId);
        assert.deepEqual(
          acceptedEvents.map((event) => event.type),
          ["turn.started", "turn.completed"],
        );
        const completed = acceptedEvents[1] as Extract<
          ProviderRuntimeEvent,
          { type: "turn.completed" }
        >;
        assert.equal(completed.turnId, accepted.turnId);
        assert.equal(completed.payload.state, "interrupted");
        assert.equal(completed.payload.stopReason, "abort");
      }),
    );
  });

  it.effect("stop wins settlement blocked in get_state without duplicate completion", () => {
    const h = makeHarness();
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        const session = yield* start(adapter);
        h.client.getStateEntered = yield* Deferred.make<void>();
        h.client.getStateGate = yield* Deferred.make<void>();
        let sentinelTurnId: string | undefined;
        const collected = yield* adapter.streamEvents.pipe(
          Stream.takeUntil(
            (event) => event.type === "turn.completed" && event.turnId === sentinelTurnId,
          ),
          Stream.runCollect,
          Effect.forkChild,
        );
        const first = yield* adapter.sendTurn({
          threadId: ThreadId.make("thread"),
          input: "hello",
          modelSelection,
        });
        yield* Queue.offer(h.client.input, { type: "agent_settled" });
        yield* Deferred.await(h.client.getStateEntered);
        yield* adapter.stopSession(ThreadId.make("thread"));
        yield* Deferred.succeed(h.client.getStateGate, undefined);
        h.client.getStateEntered = undefined;
        h.client.getStateGate = undefined;
        yield* adapter.startSession({
          provider: ProviderDriverKind.make("pi"),
          providerInstanceId: instanceId,
          threadId: ThreadId.make("thread"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
          resumeCursor: session.resumeCursor,
        });
        const sentinel = yield* adapter.sendTurn({
          threadId: ThreadId.make("thread"),
          input: "sentinel",
          modelSelection,
        });
        sentinelTurnId = sentinel.turnId;
        yield* Queue.offer(h.client.input, { type: "agent_settled" });
        const events = Array.from(yield* Fiber.join(collected));
        const completed = events.filter(
          (event) => event.type === "turn.completed" && event.turnId === first.turnId,
        );
        assert.equal(completed.length, 1);
        assert.equal(
          (completed[0] as Extract<ProviderRuntimeEvent, { type: "turn.completed" }>).payload.state,
          "interrupted",
        );
      }),
    );
  });

  it.effect("terminalizes an accepted turn when its blocked prompt fiber is interrupted", () =>
    Effect.gen(function* () {
      const h = makeHarness();
      h.client.promptEntered = yield* Deferred.make<void>();
      h.client.promptGate = yield* Deferred.make<void>();
      yield* withAdapter(h, (adapter) =>
        Effect.gen(function* () {
          yield* start(adapter);
          const fence = yield* collectThroughSentinel(adapter);
          const sending = yield* adapter
            .sendTurn({
              threadId: ThreadId.make("thread"),
              input: "hello",
              modelSelection,
            })
            .pipe(Effect.forkChild);
          yield* Deferred.await(h.client.promptEntered!);
          yield* Fiber.interrupt(sending);
          h.client.promptGate = undefined;
          yield* start(adapter);
          const sentinel = yield* adapter.sendTurn({
            threadId: ThreadId.make("thread"),
            input: "sentinel",
            modelSelection,
          });
          fence.setSentinel(sentinel.turnId);
          yield* Queue.offer(h.client.input, { type: "agent_settled" });
          const events = Array.from(yield* Fiber.join(fence.collected));
          const interruptedTurnId = events[0]?.turnId;
          const interruptedEvents = events.filter((event) => event.turnId === interruptedTurnId);
          assert.deepEqual(
            interruptedEvents.map((event) => event.type),
            ["turn.started", "turn.completed"],
          );
          assert.equal(
            (interruptedEvents[1] as Extract<ProviderRuntimeEvent, { type: "turn.completed" }>)
              .payload.state,
            "interrupted",
          );
        }),
      );
    }),
  );

  it.effect("fails an accepted turn when the transport event stream shuts down", () => {
    const h = makeHarness();
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        yield* start(adapter);
        const fence = yield* collectThroughSentinel(adapter);
        const accepted = yield* adapter.sendTurn({
          threadId: ThreadId.make("thread"),
          input: "hello",
          modelSelection,
        });
        yield* Queue.shutdown(h.client.input);
        while (yield* adapter.hasSession(ThreadId.make("thread"))) yield* Effect.yieldNow;
        h.client.input = yield* Queue.unbounded<PiRpcEvent>();
        h.client.events = Stream.fromQueue(h.client.input);
        yield* start(adapter);
        const sentinel = yield* adapter.sendTurn({
          threadId: ThreadId.make("thread"),
          input: "sentinel",
          modelSelection,
        });
        fence.setSentinel(sentinel.turnId);
        yield* Queue.offer(h.client.input, { type: "agent_settled" });
        const events = Array.from(yield* Fiber.join(fence.collected));
        const acceptedEvents = events.filter((event) => event.turnId === accepted.turnId);
        assert.deepEqual(
          acceptedEvents.map((event) => event.type),
          ["turn.started", "runtime.error", "turn.completed"],
        );
        const completed = acceptedEvents.filter((event) => event.type === "turn.completed");
        assert.equal(completed.length, 1);
        assert.equal(completed[0]?.turnId, accepted.turnId);
        assert.equal(completed[0]?.payload.state, "failed");
      }),
    );
  });

  it.effect("settles a failed assistant run as a failed turn with the pi error message", () => {
    const h = makeHarness();
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        yield* start(adapter);
        const fence = yield* collectThroughSentinel(adapter);
        const accepted = yield* adapter.sendTurn({
          threadId: ThreadId.make("thread"),
          input: "hello",
          modelSelection,
        });
        fence.setSentinel(accepted.turnId);
        yield* Queue.offerAll(h.client.input, [
          {
            type: "message_update",
            assistantMessageEvent: { type: "thinking_delta", delta: "reasoning..." },
          },
          {
            type: "message_end",
            message: {
              role: "assistant",
              stopReason: "error",
              errorMessage: "Rate limit exceeded",
              content: "",
            },
          },
          { type: "agent_settled" },
        ]);
        const events = Array.from(yield* Fiber.join(fence.collected));
        const turnEvents = events.filter((event) => event.turnId === accepted.turnId);
        assert.deepEqual(
          turnEvents.map((event) => event.type),
          ["turn.started", "item.started", "content.delta", "runtime.error", "turn.completed"],
        );
        const error = turnEvents.find((event) => event.type === "runtime.error");
        assert.equal(
          (error as Extract<ProviderRuntimeEvent, { type: "runtime.error" }>).payload.message,
          "Rate limit exceeded",
        );
        const completed = turnEvents.find((event) => event.type === "turn.completed");
        assert.equal(
          (completed as Extract<ProviderRuntimeEvent, { type: "turn.completed" }>).payload.state,
          "failed",
        );
      }),
    );
  });

  it.effect("does not fail a turn when a later assistant message succeeds after a retry", () => {
    const h = makeHarness();
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        yield* start(adapter);
        const fence = yield* collectThroughSentinel(adapter);
        const accepted = yield* adapter.sendTurn({
          threadId: ThreadId.make("thread"),
          input: "hello",
          modelSelection,
        });
        fence.setSentinel(accepted.turnId);
        yield* Queue.offerAll(h.client.input, [
          {
            type: "message_end",
            message: {
              role: "assistant",
              stopReason: "error",
              errorMessage: "transient failure",
              content: "",
            },
          },
          {
            type: "message_end",
            message: { role: "assistant", stopReason: "end_turn", content: "Recovered." },
          },
          { type: "agent_settled" },
        ]);
        const events = Array.from(yield* Fiber.join(fence.collected));
        const turnEvents = events.filter((event) => event.turnId === accepted.turnId);
        assert.equal(
          turnEvents.some((event) => event.type === "runtime.error"),
          false,
        );
        const completed = turnEvents.find((event) => event.type === "turn.completed");
        assert.equal(
          (completed as Extract<ProviderRuntimeEvent, { type: "turn.completed" }>).payload.state,
          "completed",
        );
      }),
    );
  });

  it.effect("emits thread token usage from pi session stats at settlement", () => {
    const h = makeHarness();
    h.client.sessionStats = {
      tokens: { input: 100, output: 50, cacheRead: 25, cacheWrite: 5, total: 180 },
      contextUsage: { tokens: 120, contextWindow: 1000, percent: 12 },
      cost: 0.01,
    };
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        yield* start(adapter);
        const collected = yield* Stream.takeUntil(
          adapter.streamEvents,
          (event) => event.type === "thread.token-usage.updated",
        ).pipe(Stream.runCollect, Effect.forkChild);
        const accepted = yield* adapter.sendTurn({
          threadId: ThreadId.make("thread"),
          input: "hello",
          modelSelection,
        });
        yield* Queue.offer(h.client.input, { type: "agent_settled" });
        const events = Array.from(yield* Fiber.join(collected));
        assert.deepEqual(
          events.map((event) => event.type),
          ["turn.started", "turn.completed", "thread.token-usage.updated"],
        );
        assert.equal(h.client.calls.sessionStats, 1);
        const usage = events[2] as Extract<
          ProviderRuntimeEvent,
          { type: "thread.token-usage.updated" }
        >;
        assert.equal(usage.turnId, accepted.turnId);
        assert.equal(usage.payload.usage.usedTokens, 120);
        assert.equal(usage.payload.usage.maxTokens, 1000);
        assert.equal(usage.payload.usage.inputTokens, 100);
        assert.equal(usage.payload.usage.outputTokens, 50);
        assert.equal(usage.payload.usage.cachedInputTokens, 25);
      }),
    );
  });

  it.effect("compacts the pi session on compactThread", () => {
    const h = makeHarness();
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        yield* start(adapter);
        const compact = adapter.compactThread;
        if (compact) yield* compact(ThreadId.make("thread"));
        assert.equal(h.client.calls.compact, 1);
      }),
    );
  });

  it.effect("projects compaction, retry, session-name, and extension-error events", () => {
    const h = makeHarness();
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        yield* start(adapter);
        const collected = yield* Stream.take(adapter.streamEvents, 7).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );
        const accepted = yield* adapter.sendTurn({
          threadId: ThreadId.make("thread"),
          input: "hello",
          modelSelection,
        });
        yield* Queue.offerAll(h.client.input, [
          { type: "extension_error", extensionPath: "/x/ext.ts", error: { message: "boom" } },
          { type: "session_info_changed", name: "New thread name" },
          { type: "compaction_start", reason: "threshold" },
          { type: "compaction_end", reason: "threshold", aborted: false },
          { type: "auto_retry_start", attempt: 1, maxAttempts: 3, errorMessage: "rate limited" },
          { type: "auto_retry_end", success: false, attempt: 3, finalError: "still failing" },
          { type: "agent_settled" },
        ]);
        const events = Array.from(yield* Fiber.join(collected));
        assert.deepEqual(
          events.map((event) => event.type),
          [
            "turn.started",
            "runtime.warning",
            "thread.metadata.updated",
            "item.started",
            "item.completed",
            "runtime.warning",
            "runtime.warning",
          ],
        );
        const extensionWarning = events[1] as Extract<
          ProviderRuntimeEvent,
          { type: "runtime.warning" }
        >;
        assert.equal(extensionWarning.payload.message, "Pi extension /x/ext.ts: boom");
        const metadata = events[2] as Extract<
          ProviderRuntimeEvent,
          { type: "thread.metadata.updated" }
        >;
        assert.equal(metadata.payload.name, "New thread name");
        const compaction = events[3] as Extract<ProviderRuntimeEvent, { type: "item.started" }>;
        assert.equal(compaction.payload.itemType, "context_compaction");
        assert.equal(compaction.payload.status, "inProgress");
        const compactionEnd = events[4] as Extract<
          ProviderRuntimeEvent,
          { type: "item.completed" }
        >;
        assert.equal(compactionEnd.payload.status, "completed");
        const retryStart = events[5] as Extract<ProviderRuntimeEvent, { type: "runtime.warning" }>;
        assert.equal(retryStart.payload.message, "Pi retrying (1/3): rate limited");
        const retryEnd = events[6] as Extract<ProviderRuntimeEvent, { type: "runtime.warning" }>;
        assert.equal(retryEnd.payload.message, "Pi retry failed: still failing");
        assert.equal(events[0]?.turnId, accepted.turnId);
      }),
    );
  });

  it.effect("rejects startup when the transport event stream is already closed", () => {
    const h = makeHarness();
    h.client.events = Stream.empty;
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        const result = yield* start(adapter).pipe(Effect.result);
        assert.equal(result._tag, "Failure");
        assert.equal(yield* adapter.hasSession(ThreadId.make("thread")), false);
        assert.equal(h.client.calls.close, 1);
        const files = fs
          .readdirSync(h.stateDir, { recursive: true })
          .filter((entry) => String(entry).endsWith(".jsonl"));
        assert.deepEqual(files, []);
      }),
    );
  });

  it.effect("rejects startup while an ended event stream is blocked closing", () =>
    Effect.gen(function* () {
      const h = makeHarness();
      h.client.events = Stream.empty;
      h.client.closeEntered = yield* Deferred.make<void>();
      h.client.closeGate = yield* Deferred.make<void>();
      yield* withAdapter(h, (adapter) =>
        Effect.gen(function* () {
          const startupCompleted = yield* Deferred.make<void>();
          const starting = yield* start(adapter).pipe(
            Effect.result,
            Effect.ensuring(Deferred.succeed(startupCompleted, undefined)),
            Effect.forkChild,
          );
          yield* Deferred.await(h.client.closeEntered!);
          yield* Effect.yieldNow;
          assert.equal(Option.isNone(yield* Deferred.poll(startupCompleted)), true);
          yield* Deferred.succeed(h.client.closeGate!, undefined);
          const result = yield* Fiber.join(starting);
          assert.equal(result._tag, "Failure");
          assert.equal(yield* adapter.hasSession(ThreadId.make("thread")), false);
        }),
      );
    }),
  );

  it.effect("rejects a send whose preflight races the event stream closing", () =>
    Effect.gen(function* () {
      const h = makeHarness();
      h.client.getAvailableModelsEntered = yield* Deferred.make<void>();
      h.client.getAvailableModelsGate = yield* Deferred.make<void>();
      yield* withAdapter(h, (adapter) =>
        Effect.gen(function* () {
          yield* start(adapter);
          const observed: ProviderRuntimeEvent[] = [];
          const events = yield* adapter.streamEvents.pipe(
            Stream.runForEach((event) =>
              Effect.sync(() => {
                observed.push(event);
              }),
            ),
            Effect.forkChild,
          );
          const sending = yield* adapter
            .sendTurn({
              threadId: ThreadId.make("thread"),
              input: "hello",
              modelSelection,
            })
            .pipe(Effect.result, Effect.forkChild);
          yield* Deferred.await(h.client.getAvailableModelsEntered!);
          yield* Queue.shutdown(h.client.input);
          while (yield* adapter.hasSession(ThreadId.make("thread"))) yield* Effect.yieldNow;
          yield* Deferred.succeed(h.client.getAvailableModelsGate!, undefined);
          const result = yield* Fiber.join(sending);
          assert.equal(result._tag, "Failure");
          if (result._tag === "Failure")
            assert.equal(result.failure._tag, "ProviderAdapterSessionNotFoundError");
          assert.equal(h.client.calls.prompt, 0);
          yield* Effect.yieldNow;
          yield* Fiber.interrupt(events);
          assert.equal(
            observed.some((event) => event.type === "turn.started"),
            false,
          );
        }),
      );
    }),
  );

  it.effect("serializes concurrent sends into one turn with a steering message", () => {
    const h = makeHarness();
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        yield* start(adapter);
        let sentinelTurnId: string | undefined;
        const firstTerminalSeen = yield* Deferred.make<void>();
        const collected = yield* adapter.streamEvents.pipe(
          Stream.tap((event) =>
            event.type === "turn.completed"
              ? Deferred.succeed(firstTerminalSeen, undefined)
              : Effect.void,
          ),
          Stream.takeUntil(
            (event) => event.type === "turn.completed" && event.turnId === sentinelTurnId,
          ),
          Stream.runCollect,
          Effect.forkChild,
        );
        const send = (input: string) =>
          adapter
            .sendTurn({ threadId: ThreadId.make("thread"), input, modelSelection })
            .pipe(Effect.result);
        const results = yield* Effect.all([send("one"), send("two")], {
          concurrency: "unbounded",
        });
        assert.equal(results.filter((result) => result._tag === "Success").length, 2);
        assert.equal(
          new Set(
            results.flatMap((result) =>
              result._tag === "Success" ? [String(result.success.turnId)] : [],
            ),
          ).size,
          1,
        );
        assert.equal(h.client.calls.prompt, 2);
        assert.deepEqual(
          h.client.calls.prompts.map(({ streamingBehavior }) => streamingBehavior),
          [undefined, "steer"],
        );
        yield* Queue.offer(h.client.input, { type: "agent_settled" });
        yield* Deferred.await(firstTerminalSeen);
        const sentinel = yield* adapter.sendTurn({
          threadId: ThreadId.make("thread"),
          input: "sentinel",
          modelSelection,
        });
        sentinelTurnId = sentinel.turnId;
        yield* Queue.offer(h.client.input, { type: "agent_settled" });
        const events = Array.from(yield* Fiber.join(collected));
        const firstTurnId = results.find((result) => result._tag === "Success")!.success.turnId;
        const firstEvents = events.filter((event) => event.turnId === firstTurnId);
        assert.deepEqual(
          firstEvents.map((event) => event.type),
          ["turn.started", "turn.completed"],
        );
      }),
    );
  });

  it.effect("defers settlement until a steering prompt is accepted", () =>
    Effect.gen(function* () {
      const h = makeHarness();
      h.client.promptEntered = yield* Deferred.make<void>();
      h.client.promptGate = yield* Deferred.make<void>();
      yield* withAdapter(h, (adapter) =>
        Effect.gen(function* () {
          yield* start(adapter);
          yield* Deferred.succeed(h.client.promptGate!, undefined);
          const first = yield* adapter.sendTurn({
            threadId: ThreadId.make("thread"),
            input: "first",
            modelSelection,
          });

          h.client.promptEntered = yield* Deferred.make<void>();
          h.client.promptGate = yield* Deferred.make<void>();
          const steering = yield* adapter
            .sendTurn({
              threadId: ThreadId.make("thread"),
              input: "steer",
              modelSelection,
            })
            .pipe(Effect.forkChild);
          yield* Deferred.await(h.client.promptEntered!);
          yield* Queue.offer(h.client.input, { type: "agent_settled" });
          yield* Effect.yieldNow;
          assert.equal((yield* adapter.listSessions())[0]?.status, "running");
          yield* Deferred.succeed(h.client.promptGate!, undefined);

          const steered = yield* Fiber.join(steering);
          assert.equal(steered.turnId, first.turnId);
          while ((yield* adapter.listSessions())[0]?.status === "running") yield* Effect.yieldNow;
          assert.equal((yield* adapter.listSessions())[0]?.status, "ready");
        }),
      );
    }),
  );

  it.effect("rechecks a settlement snapshot when steering starts during get_state", () =>
    Effect.gen(function* () {
      const h = makeHarness();
      yield* withAdapter(h, (adapter) =>
        Effect.gen(function* () {
          yield* start(adapter);
          const first = yield* adapter.sendTurn({
            threadId: ThreadId.make("thread"),
            input: "first",
            modelSelection,
          });
          h.client.getStateEntered = yield* Deferred.make<void>();
          h.client.getStateGate = yield* Deferred.make<void>();
          h.client.getStateResults.push(
            { ...h.client.state, isStreaming: false },
            { ...h.client.state, isStreaming: true },
          );

          yield* Queue.offer(h.client.input, { type: "agent_settled" });
          yield* Deferred.await(h.client.getStateEntered!);
          const steered = yield* adapter.sendTurn({
            threadId: ThreadId.make("thread"),
            input: "steer",
            modelSelection,
          });
          yield* Deferred.succeed(h.client.getStateGate!, undefined);
          while (h.client.getStateResults.length > 0) yield* Effect.yieldNow;

          assert.equal(steered.turnId, first.turnId);
          const running = (yield* adapter.listSessions())[0];
          assert.equal(running?.status, "running");
          assert.equal(running?.activeTurnId, first.turnId);

          h.client.getStateEntered = undefined;
          h.client.getStateGate = undefined;
          h.client.state.isStreaming = false;
          yield* Queue.offer(h.client.input, { type: "agent_settled" });
        }),
      );
    }),
  );

  it.effect("does not let a blocked steering prompt prevent interruption", () =>
    Effect.gen(function* () {
      const h = makeHarness();
      yield* withAdapter(h, (adapter) =>
        Effect.gen(function* () {
          yield* start(adapter);
          const first = yield* adapter.sendTurn({
            threadId: ThreadId.make("thread"),
            input: "first",
            modelSelection,
          });

          h.client.promptEntered = yield* Deferred.make<void>();
          h.client.promptGate = yield* Deferred.make<void>();
          const steering = yield* adapter
            .sendTurn({
              threadId: ThreadId.make("thread"),
              input: "steer",
              modelSelection,
            })
            .pipe(Effect.forkChild);
          yield* Deferred.await(h.client.promptEntered!);

          yield* adapter.interruptTurn(ThreadId.make("thread"), first.turnId);
          while (h.client.calls.abort < 1) yield* Effect.yieldNow;
          assert.equal(h.client.calls.abort, 1);
          const interruptingSteer = yield* Fiber.interrupt(steering).pipe(Effect.forkChild);
          yield* Deferred.succeed(h.client.promptGate!, undefined);
          yield* Fiber.join(interruptingSteer);
          const running = (yield* adapter.listSessions())[0];
          assert.equal(running?.status, "running");
          assert.equal(running?.activeTurnId, first.turnId);
          assert.equal(h.client.calls.close, 0);
          while (h.client.calls.abort < 2) yield* Effect.yieldNow;
          assert.equal(h.client.calls.abort, 2);

          yield* Queue.offer(h.client.input, { type: "agent_settled" });
        }),
      );
    }),
  );

  it.effect("leaves the active turn running when a steering prompt fails", () => {
    const h = makeHarness();
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        yield* start(adapter);
        const first = yield* adapter.sendTurn({
          threadId: ThreadId.make("thread"),
          input: "first",
          modelSelection,
        });
        h.client.failPrompt = true;

        const failed = yield* adapter
          .sendTurn({
            threadId: ThreadId.make("thread"),
            input: "steer",
            modelSelection,
          })
          .pipe(Effect.result);
        assert.equal(failed._tag, "Failure");
        const running = (yield* adapter.listSessions())[0];
        assert.equal(running?.status, "running");
        assert.equal(running?.activeTurnId, first.turnId);

        h.client.failPrompt = false;
        yield* Queue.offer(h.client.input, { type: "agent_settled" });
      }),
    );
  });

  it.effect("resumes only an exact persisted cursor", () => {
    const h = makeHarness();
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        const first = yield* start(adapter);
        yield* adapter.stopSession(ThreadId.make("thread"));
        const resumed = yield* adapter.startSession({
          provider: ProviderDriverKind.make("pi"),
          providerInstanceId: instanceId,
          threadId: ThreadId.make("thread"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
          resumeCursor: first.resumeCursor,
        });
        assert.deepEqual(resumed.resumeCursor, first.resumeCursor);
        assert.equal(h.spawns.length, 2);
        yield* adapter.stopSession(ThreadId.make("thread"));

        const invalid = yield* adapter
          .startSession({
            provider: ProviderDriverKind.make("pi"),
            providerInstanceId: instanceId,
            threadId: ThreadId.make("thread"),
            cwd: process.cwd(),
            runtimeMode: "full-access",
            resumeCursor: {
              ...(first.resumeCursor as Record<string, unknown>),
              sessionId: "wrong-session",
            },
          })
          .pipe(Effect.result);
        assert.equal(invalid._tag, "Failure");
        assert.equal(h.spawns.length, 2);
      }),
    );
  });

  it.effect("removes a fresh placeholder after startup fails", () => {
    const h = makeHarness({ failStart: true });
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        assert.equal((yield* start(adapter).pipe(Effect.result))._tag, "Failure");
        const files = fs
          .readdirSync(h.stateDir, { recursive: true })
          .filter((entry) => String(entry).endsWith(".jsonl"));
        assert.deepEqual(files, []);
        assert.equal(yield* adapter.hasSession(ThreadId.make("thread")), false);
      }),
    );
  });

  it.effect("serializes concurrent starts for one thread", () => {
    const h = makeHarness();
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        const results = yield* Effect.all(
          [start(adapter).pipe(Effect.result), start(adapter).pipe(Effect.result)],
          { concurrency: "unbounded" },
        );
        assert.equal(results.filter((result) => result._tag === "Success").length, 1);
        assert.equal(results.filter((result) => result._tag === "Failure").length, 1);
        assert.equal(h.spawns.length, 1);
      }),
    );
  });

  it.effect("cleans an interrupted startup before publishing ownership", () =>
    Effect.gen(function* () {
      const spawnEntered = yield* Deferred.make<void>();
      const h = makeHarness();
      const interruptedHarness: Harness = {
        ...h,
        makeClient: () =>
          Deferred.succeed(spawnEntered, undefined).pipe(Effect.andThen(Effect.never)),
      };
      yield* withAdapter(interruptedHarness, (adapter) =>
        Effect.gen(function* () {
          const starting = yield* Effect.forkChild(start(adapter));
          yield* Deferred.await(spawnEntered);
          yield* Fiber.interrupt(starting);
          assert.equal(yield* adapter.hasSession(ThreadId.make("thread")), false);
          const files = fs
            .readdirSync(h.stateDir, { recursive: true })
            .filter((entry) => String(entry).endsWith(".jsonl"));
          assert.deepEqual(files, []);
        }),
      );
    }),
  );

  it.effect("releases published startup ownership when interrupted before transfer", () =>
    Effect.gen(function* () {
      const published = yield* Deferred.make<void>();
      const releasePublication = yield* Deferred.make<void>();
      const h = makeHarness();
      let blockPublication = false;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const adapter = yield* makePiAdapter({
            binaryPath: "pi",
            providerInstanceId: instanceId,
            stateDir: h.stateDir,
            attachmentsDir: h.attachmentsDir,
            makeRpcClient: h.makeClient,
            onSessionPublished: () =>
              blockPublication
                ? Deferred.succeed(published, undefined).pipe(
                    Effect.andThen(Deferred.await(releasePublication)),
                  )
                : Effect.void,
          });
          const durable = yield* start(adapter, "durable");
          yield* adapter.stopSession(ThreadId.make("durable"));
          blockPublication = true;
          const starting = yield* Effect.forkChild(
            adapter.startSession({
              provider: ProviderDriverKind.make("pi"),
              providerInstanceId: instanceId,
              threadId: ThreadId.make("thread"),
              cwd: process.cwd(),
              runtimeMode: "full-access",
              resumeCursor: durable.resumeCursor,
            }),
          );
          yield* Deferred.await(published);
          assert.equal(yield* adapter.hasSession(ThreadId.make("thread")), true);
          yield* Fiber.interrupt(starting);
          assert.equal(yield* adapter.hasSession(ThreadId.make("thread")), false);

          blockPublication = false;
          const reacquired = yield* adapter.startSession({
            provider: ProviderDriverKind.make("pi"),
            providerInstanceId: instanceId,
            threadId: ThreadId.make("replacement"),
            cwd: process.cwd(),
            runtimeMode: "full-access",
            resumeCursor: durable.resumeCursor,
          });
          assert.equal(reacquired.threadId, ThreadId.make("replacement"));
        }),
      ).pipe(Effect.provide(NodeServices.layer));
    }),
  );

  it.effect("leases a durable session file to one live thread", () => {
    const h = makeHarness();
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        const first = yield* start(adapter, "thread-one");
        const second = yield* adapter
          .startSession({
            provider: ProviderDriverKind.make("pi"),
            providerInstanceId: instanceId,
            threadId: ThreadId.make("thread-two"),
            cwd: process.cwd(),
            runtimeMode: "full-access",
            resumeCursor: first.resumeCursor,
          })
          .pipe(Effect.result);
        assert.equal(second._tag, "Failure");
        assert.equal(h.spawns.length, 1);
      }),
    );
  });

  it.effect("fails a rejected prompt and allows the next turn", () => {
    const h = makeHarness();
    h.client.failPrompt = true;
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        yield* start(adapter);
        const collected = yield* Stream.take(adapter.streamEvents, 3).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );
        const failed = yield* adapter
          .sendTurn({
            threadId: ThreadId.make("thread"),
            input: "first",
            modelSelection,
          })
          .pipe(Effect.result);
        assert.equal(failed._tag, "Failure");
        assert.deepEqual(
          Array.from(yield* Fiber.join(collected)).map((event) => event.type),
          ["turn.started", "runtime.error", "turn.completed"],
        );

        h.client.failPrompt = false;
        const next = yield* adapter.sendTurn({
          threadId: ThreadId.make("thread"),
          input: "second",
          modelSelection,
        });
        assert.equal(next.threadId, ThreadId.make("thread"));
        yield* Queue.offer(h.client.input, { type: "agent_settled" });
      }),
    );
  });

  it.effect("closes the session after an ambiguous prompt transport failure", () => {
    const h = makeHarness();
    h.client.fatalPrompt = true;
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        yield* start(adapter);
        const failed = yield* adapter
          .sendTurn({
            threadId: ThreadId.make("thread"),
            input: "ambiguous",
            modelSelection,
          })
          .pipe(Effect.result);
        assert.equal(failed._tag, "Failure");
        assert.equal(yield* adapter.hasSession(ThreadId.make("thread")), false);
        assert.equal(h.client.calls.close, 1);
      }),
    );
  });

  it.effect("fails identity drift, closes once, and makes stop idempotent", () => {
    const h = makeHarness();
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        yield* start(adapter);
        const collected = yield* Stream.take(adapter.streamEvents, 3).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* adapter.sendTurn({
          threadId: ThreadId.make("thread"),
          input: "hello",
          modelSelection,
        });
        h.client.state = { ...h.client.state, sessionId: "drift" };
        yield* Queue.offer(h.client.input, { type: "agent_settled" });
        const events = Array.from(yield* Fiber.join(collected));
        assert.deepEqual(
          events.map((event) => event.type),
          ["turn.started", "runtime.error", "turn.completed"],
        );
        yield* adapter.stopSession(ThreadId.make("thread"));
        yield* adapter.stopSession(ThreadId.make("thread"));
        assert.equal(h.client.calls.close, 1);
        assert.equal(yield* adapter.hasSession(ThreadId.make("thread")), false);
      }),
    );
  });
});
