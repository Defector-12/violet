import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createRun, reportRun } from "./test-run.mjs";

const root = resolve(".");
const core = join(root, "services/core/dist");
const load = (path) => import(pathToFileURL(join(core, path)));
const require = createRequire(pathToFileURL(join(core, "main.js")));
const WebSocket = require("ws");
const { buildCoreApp } = await load("http/app.js");
const { DeviceAuthenticator, hashDeviceToken } = await load("auth/device-authenticator.js");
const { ContextService } = await load("context/context-service.js");
const { DeepSeekVisionUnderstandingPort } = await load("context/deepseek-vision-understanding.js");
const { InMemoryContextArtifactStore } = await load("context/in-memory-context-artifact-store.js");
const { InMemoryContextSessionRepository } = await load(
  "context/in-memory-context-session-repository.js",
);
const { InMemoryConversationLedger } = await load("conversation/in-memory-conversation-ledger.js");
const { ChatService } = await load("conversation/chat-service.js");
const { ContextAssembler } = await load("conversation/context-assembler.js");
const { ContextEpochManager } = await load("conversation/context-epoch-manager.js");
const { InMemoryContextCheckpointRepository } = await load(
  "conversation/in-memory-context-checkpoint-repository.js",
);
const { DeterministicModelGateway } = await load("model/deterministic-model-gateway.js");
const { QwenAudioRealtimeConversationPort } = await load(
  "realtime/qwen-audio-realtime-conversation.js",
);
const { TestTraceStore } = await load("realtime/test-trace.js");

const directory = await createRun(
  join(root, ".local-acceptance/test-runs"),
  "agent",
  "trace-pipeline-controlled-smoke",
);
const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
const ledger = new InMemoryConversationLedger();
const modelGateway = new DeterministicModelGateway();
const contextAssembler = new ContextAssembler({
  checkpoints: new InMemoryContextCheckpointRepository(),
  ledger,
  model: modelGateway,
});
const contextEpochManager = new ContextEpochManager({ generateId: randomUUID });
const token = randomUUID();
const store = new TestTraceStore(join(directory, "server"));
let visionCalls = 0;
let toolResult;
const queue = [];
let waiter;
const push = (event) => {
  if (waiter) {
    const next = waiter;
    waiter = undefined;
    next(event);
  } else queue.push(event);
};
const transport = {
  async connect() {
    push({ type: "session.created" });
  },
  async receive() {
    return queue.length
      ? queue.shift()
      : new Promise((resolve) => {
          waiter = resolve;
        });
  },
  close() {
    push({ type: "closed" });
  },
  async send(event) {
    if (event.type === "session.update") {
      push({ type: "session.updated" });
      return;
    }
    if (event.item?.type === "function_call_output") {
      toolResult = event.item.output;
      return;
    }
    if (event.type !== "response.create") return;
    const id = randomUUID();
    push({ type: "response.created", response: { id } });
    if (!toolResult) {
      push({
        type: "response.function_call_arguments.done",
        response_id: id,
        call_id: randomUUID(),
        name: "inspect_current_view",
        arguments: '{"question":"Read the synthetic fixture."}',
      });
    } else {
      const text =
        JSON.parse(toolResult).status === "ready"
          ? "Synthetic answer: eastern gate."
          : "Synthetic answer: unavailable.";
      push({ type: "response.text.delta", response_id: id, delta: text });
      toolResult = undefined;
    }
    push({
      type: "response.done",
      response: { id, status: "completed", usage: { input_tokens: 1, output_tokens: 1 } },
    });
  },
};
const app = buildCoreApp({
  authenticator: new DeviceAuthenticator({
    expectedHashHex: hashDeviceToken(token),
    expiresAt: new Date(Date.now() + 60_000),
  }),
  chatService: new ChatService({
    contextAssembler,
    epochManager: contextEpochManager,
    generateId: randomUUID,
    ledger,
    modelGateway,
  }),
  conversationEndIntent: {
    async shouldEnd() {
      return false;
    },
  },
  contextAssembler,
  contextEpochManager,
  contextService: new ContextService({
    artifactStore: new InMemoryContextArtifactStore(),
    repository: new InMemoryContextSessionRepository(),
    understanding: new DeepSeekVisionUnderstandingPort({
      apiKey: "synthetic-not-a-credential",
      baseUrl: "https://example.invalid",
      model: "synthetic-vision",
      fetch: async () => {
        visionCalls++;
        return Response.json({
          choices: [
            {
              message: {
                content:
                  visionCalls === 1
                    ? JSON.stringify({
                        answer: "Eastern gate.",
                        confidence: 0.9,
                      })
                    : "malformed synthetic model JSON",
              },
            },
          ],
        });
      },
    }),
  }),
  realtimeConversationPort: new QwenAudioRealtimeConversationPort({
    apiKey: "synthetic-not-a-credential",
    model: "synthetic-qwen",
    voice: "fixture",
    workspaceId: "ws-fixture",
    generateId: randomUUID,
    createTransport: () => transport,
  }),
  realtimeLedger: ledger,
  sealed: false,
  version: "trace-smoke-only",
  testTraces: store,
});
let socket;
try {
  const base = await app.listen({ host: "127.0.0.1", port: 0 });
  assert.equal(
    (await app.inject({ method: "POST", url: "/v1/test-traces", payload: manifest })).statusCode,
    403,
  );
  const prepared = await app.inject({
    method: "POST",
    url: "/v1/test-traces",
    headers: { authorization: `Bearer ${token}` },
    payload: { runId: manifest.runId, activeUntil: manifest.activeUntil },
  });
  assert.equal(prepared.statusCode, 200);
  const sessionId = randomUUID();
  let sequence = 1;
  let turn = 0;
  const answers = [];
  socket = new WebSocket(`${base.replace("http:", "ws:")}/v1/realtime`, {
    headers: {
      authorization: `Bearer ${token}`,
      "x-violet-test-run": manifest.runId,
      "x-violet-test-until": manifest.activeUntil,
    },
  });
  const send = (event) =>
    socket.send(
      JSON.stringify({ ...event, sequence: sequence++, eventId: randomUUID(), sessionId }),
    );
  const completed = new Promise((resolve, reject) => {
    socket.on("error", reject);
    socket.on("message", (raw) => {
      try {
        const event = JSON.parse(raw.toString());
        if (event.type === "error") throw new Error(event.code);
        if (event.type === "session.ready")
          send({ type: "input.text", turnId: randomUUID(), text: "Read fixture one." });
        if (event.type === "response.text") answers.push(event.text);
        if (event.type === "context.capture.requested") {
          const common = { requestId: event.requestId, turnId: event.turnId };
          if (turn === 1)
            send({ ...common, type: "context.capture.failed", reason: "unavailable" });
          else {
            const data = Buffer.from("controlled image fixture, not actual scene evidence");
            send({
              ...common,
              type: "context.capture.succeeded",
              context: {
                protocolVersion: "1",
                eventId: randomUUID(),
                sessionId: event.requestId,
                sequence: 1,
                capturedAt: new Date().toISOString(),
                expiresAt: new Date(Date.now() + 60_000).toISOString(),
                authorization: {
                  controlledSensitiveAllowed: false,
                  grantId: randomUUID(),
                  mode: "explicit",
                  purpose: "conversation",
                  retention: "ephemeral",
                },
                completeness: 1,
                confidence: 1,
                sensitivity: "personal",
                redactions: [],
                source: {
                  deviceId: randomUUID(),
                  modality: "screen",
                  appBundleId: "fixture.trace",
                },
                payload: {
                  type: "screen.snapshot",
                  focusPoint: { x: 0.5, y: 0.5 },
                  image: {
                    data: data.toString("base64"),
                    width: 1,
                    height: 1,
                    mediaType: "image/png",
                    sha256: createHash("sha256").update(data).digest("hex"),
                  },
                },
              },
            });
          }
        }
        if (event.type === "response.completed") {
          turn++;
          if (turn === 3) resolve();
          else
            send({ type: "input.text", turnId: randomUUID(), text: `Read fixture ${turn + 1}.` });
        }
      } catch (error) {
        reject(error);
      }
    });
  });
  await once(socket, "open");
  send({
    type: "session.configure",
    configuration: {
      inputModalities: ["text", "audio"],
      outputModalities: ["text", "audio"],
      protocolVersion: "1",
      onDemandContext: true,
      turnDetection: "manual",
    },
  });
  let timeout;
  try {
    await Promise.race([
      completed,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error("SMOKE_TIMEOUT")), 15_000);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
  const closed = once(socket, "close");
  send({ type: "session.close" });
  await closed;
  const snapshot = await app.inject({
    method: "GET",
    url: `/v1/test-traces/${manifest.runId}`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(snapshot.statusCode, 200);
  assert.equal(
    (await app.inject({ method: "GET", url: `/v1/test-traces/${manifest.runId}` })).statusCode,
    403,
  );
  await writeFile(join(directory, "core.ndjson"), snapshot.body, { flag: "wx", mode: 0o600 });
  for (const type of [
    "qwen.send",
    "qwen.receive",
    "vision.send",
    "vision.receive",
    "context.stage.failed",
    "grounding.result",
    "answer.completed",
    "trace.closed",
  ]) {
    assert.ok(snapshot.body.includes(`"type":"${type}"`), `Missing ${type}`);
  }
  assert.equal(visionCalls, 2);
  assert.equal(answers.length, 3);
  assert.ok(answers[0].includes("eastern gate"));
  assert.ok(answers.slice(1).every((answer) => answer.includes("unavailable")));
  assert.ok(!snapshot.body.includes(token));
  const result = {
    scope: "controlled transport integration, NOT visual acceptance",
    visionCalls,
    answers,
    status: "passed",
  };
  await writeFile(join(directory, "result.json"), JSON.stringify(result, null, 2), {
    flag: "wx",
    mode: 0o600,
  });
  console.log(JSON.stringify({ ...result, report: await reportRun(directory) }));
} catch (error) {
  await writeFile(join(directory, "failure.json"), JSON.stringify({ error: String(error) }), {
    flag: "wx",
    mode: 0o600,
  });
  await reportRun(directory);
  console.error(`Trace integration failed; evidence: ${directory}`);
  process.exitCode = 1;
} finally {
  socket?.terminate();
  await app.close();
}
