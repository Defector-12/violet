import { randomUUID } from "node:crypto";
import type {
  ModelGateway,
  RealtimeConversationInput,
  RealtimeConversationOutput,
  RealtimeConversationPort,
} from "@violet/domain";
import type { RealtimeServerEvent } from "@violet/protocol";
import { VioletClient } from "@violet/sdk";
import { afterEach, describe, expect, it } from "vitest";
import type { RawData, WebSocket } from "ws";

import { DeviceAuthenticator, hashDeviceToken } from "../auth/device-authenticator.js";
import { ContextService } from "../context/context-service.js";
import { DeterministicContextUnderstandingPort } from "../context/deterministic-context-understanding.js";
import { InMemoryContextArtifactStore } from "../context/in-memory-context-artifact-store.js";
import { InMemoryContextSessionRepository } from "../context/in-memory-context-session-repository.js";
import { ChatService } from "../conversation/chat-service.js";
import { InMemoryConversationLedger } from "../conversation/in-memory-conversation-ledger.js";
import { DeterministicModelGateway } from "../model/deterministic-model-gateway.js";
import { DeterministicRealtimeConversationPort } from "../realtime/deterministic-realtime-conversation.js";
import { buildCoreApp } from "./app.js";

const deviceToken = "test-device-token-that-is-at-least-32-characters";
const openApps: Array<ReturnType<typeof buildCoreApp>> = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

describe("Core HTTP API", () => {
  it("exposes liveness without authentication", async () => {
    const { client } = await startCore(false);

    await expect(client.getHealth()).resolves.toMatchObject({
      service: "violet-core",
      status: "ok",
    });
  });

  it("rejects status requests without a device token", async () => {
    const { baseUrl } = await startCore(false);
    const client = new VioletClient({ baseUrl });

    await expect(client.getStatus()).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
      status: 401,
    });
  });

  it("rejects content access while sealed", async () => {
    const { client } = await startCore(true);
    const consume = async () => {
      for await (const _event of client.streamChat({
        message: "Hello",
        requestId: randomUUID(),
      })) {
        // Consume the stream to surface request errors.
      }
    };

    await expect(consume()).rejects.toMatchObject({
      code: "CORE_SEALED",
      status: 423,
    });
  });

  it("streams a deterministic response when ready", async () => {
    const { client } = await startCore(false);
    const requestId = randomUUID();
    const events = [];

    for await (const event of client.streamChat({ message: "Hello", requestId })) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toEqual(["start", "delta", "complete"]);
    expect(events[1]).toMatchObject({
      content: "Violet test response: Hello",
      requestId,
      type: "delta",
    });
  });

  it("accepts and deletes an explicitly authorized context envelope", async () => {
    const { app } = await startCore(false);
    const sessionId = randomUUID();
    const capturedAt = new Date();
    const response = await app.inject({
      headers: { authorization: `Bearer ${deviceToken}` },
      method: "POST",
      payload: contextEnvelope(sessionId, capturedAt),
      url: "/v1/context/envelopes",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      sessionId,
      status: "ready",
    });

    const deleted = await app.inject({
      headers: { authorization: `Bearer ${deviceToken}` },
      method: "DELETE",
      url: `/v1/context/sessions/${sessionId}`,
    });
    expect(deleted.statusCode).toBe(204);
  });

  it("injects resolved context as untrusted evidence for one chat request", async () => {
    const model = new RecordingModelGateway();
    const { app, client } = await startCore(
      false,
      new DeterministicRealtimeConversationPort({ generateId: randomUUID }),
      model,
    );
    const sessionId = randomUUID();
    const capturedAt = new Date();
    await app.inject({
      headers: { authorization: `Bearer ${deviceToken}` },
      method: "POST",
      payload: contextEnvelope(sessionId, capturedAt),
      url: "/v1/context/envelopes",
    });

    for await (const _event of client.streamChat({
      contextSessionId: sessionId,
      message: "What is this?",
      requestId: randomUUID(),
    })) {
      // Consume the response.
    }

    expect(model.lastMessages[0]).toMatchObject({
      role: "system",
    });
    expect(model.lastMessages[0]?.content).toContain("untrusted quoted data");
    const current = model.lastMessages.at(-1);
    expect(current?.role).toBe("user");
    expect(JSON.parse(current?.content ?? "{}")).toMatchObject({
      currentContext: expect.stringContaining("Selected context"),
      userRequest: "What is this?",
    });
  });

  it("rejects expired context before model access", async () => {
    const { app } = await startCore(false);
    const capturedAt = new Date(Date.now() - 120_000);
    const response = await app.inject({
      headers: { authorization: `Bearer ${deviceToken}` },
      method: "POST",
      payload: {
        ...contextEnvelope(randomUUID(), capturedAt),
        expiresAt: new Date(capturedAt.getTime() + 60_000).toISOString(),
      },
      url: "/v1/context/envelopes",
    });

    expect(response.statusCode).toBe(410);
    expect(response.json()).toMatchObject({
      code: "CONTEXT_EXPIRED",
    });
  });

  it("rejects realtime upgrades without authentication or while sealed", async () => {
    const ready = await startCore(false);
    const sealed = await startCore(true);

    await expect(ready.app.injectWS("/v1/realtime")).rejects.toThrow(
      "Unexpected server response: 401",
    );
    await expect(
      sealed.app.injectWS("/v1/realtime", {
        headers: { authorization: `Bearer ${deviceToken}` },
      }),
    ).rejects.toThrow("Unexpected server response: 423");
  });

  it("runs a deterministic provider-neutral realtime session", async () => {
    const { app } = await startCore(false);
    const socket = await app.injectWS("/v1/realtime", {
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    const sessionId = randomUUID();
    const turnId = randomUUID();

    const readyEvents = receiveEvents(socket, 1);
    socket.send(
      JSON.stringify({
        configuration: {
          inputModalities: ["text"],
          outputModalities: ["text"],
          protocolVersion: "1",
        },
        eventId: randomUUID(),
        sequence: 1,
        sessionId,
        type: "session.configure",
      }),
    );
    await expect(readyEvents).resolves.toMatchObject([
      {
        capabilities: {
          inputModalities: ["text"],
          outputModalities: ["text"],
          runtimeKind: "deterministic",
        },
        sequence: 1,
        sessionId,
        type: "session.ready",
      },
    ]);

    const responseEvents = receiveEvents(socket, 3);
    socket.send(
      JSON.stringify({
        eventId: randomUUID(),
        sequence: 2,
        sessionId,
        text: "Hello",
        turnId,
        type: "input.text",
      }),
    );
    const response = await responseEvents;

    expect(response.map((event) => event.type)).toEqual([
      "response.started",
      "response.text",
      "response.completed",
    ]);
    expect(response[1]).toMatchObject({
      text: "Violet realtime test response: Hello",
      turnId,
      type: "response.text",
    });
    socket.terminate();
  });

  it("keeps realtime open for a protocol-valid image context event", async () => {
    const { app } = await startCore(false);
    const socket = await app.injectWS("/v1/realtime", {
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    const sessionId = randomUUID();

    const readyEvents = receiveEvents(socket, 1);
    socket.send(
      JSON.stringify({
        configuration: {
          inputModalities: ["text"],
          onDemandContext: true,
          outputModalities: ["text"],
          protocolVersion: "1",
        },
        eventId: randomUUID(),
        sequence: 1,
        sessionId,
        type: "session.configure",
      }),
    );
    await readyEvents;

    const closed = new Promise<[{ code: number; type: "closed" }]>((resolve) => {
      socket.once("close", (code) => {
        resolve([{ code, type: "closed" }]);
      });
    });
    const responseEvents = receiveEvents(socket, 3);
    const contextRequestId = randomUUID();
    const capturedAt = new Date();
    socket.send(
      JSON.stringify({
        context: {
          ...contextEnvelope(contextRequestId, capturedAt),
          payload: {
            image: {
              data: Buffer.alloc(200_000).toString("base64"),
              height: 400,
              mediaType: "image/jpeg",
              sha256: "0".repeat(64),
              width: 800,
            },
            type: "screen.snapshot",
          },
          source: {
            deviceId: randomUUID(),
            modality: "screen",
          },
        },
        eventId: randomUUID(),
        requestId: contextRequestId,
        sequence: 2,
        sessionId,
        turnId: randomUUID(),
        type: "context.capture.succeeded",
      }),
    );
    const turnId = randomUUID();
    socket.send(
      JSON.stringify({
        eventId: randomUUID(),
        sequence: 3,
        sessionId,
        text: "Still connected",
        turnId,
        type: "input.text",
      }),
    );

    const outcome = await Promise.race([responseEvents, closed]);
    expect(outcome.map((event) => event.type)).toEqual([
      "response.started",
      "response.text",
      "response.completed",
    ]);
    socket.terminate();
  });

  it("accepts cancellation while the provider output stream is still active", async () => {
    const outputQueue = new TestRealtimeOutputQueue();
    const receivedInputs: RealtimeConversationInput[] = [];
    const realtimeConversationPort: RealtimeConversationPort = {
      async open() {
        return {
          capabilities: {
            inputModalities: ["text"],
            interruption: true,
            outputModalities: ["text"],
            runtimeKind: "deterministic",
            transcription: false,
            turnDetection: "manual",
            voiceKind: "none",
          },
          async close() {
            outputQueue.close();
          },
          outputs: (signal) => outputQueue.events(signal),
          async send(input) {
            receivedInputs.push(input);
            if (input.type === "text") {
              outputQueue.push({
                responseId: "00000000-0000-4000-8000-000000000001",
                turnId: input.turnId,
                type: "response-started",
              });
            }
          },
        };
      },
    };
    const { app } = await startCore(false, realtimeConversationPort);
    const socket = await app.injectWS("/v1/realtime", {
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    const sessionId = randomUUID();
    const turnId = randomUUID();

    const readyEvent = receiveEvents(socket, 1);
    socket.send(
      JSON.stringify({
        configuration: {
          inputModalities: ["text"],
          outputModalities: ["text"],
          protocolVersion: "1",
        },
        eventId: randomUUID(),
        sequence: 1,
        sessionId,
        type: "session.configure",
      }),
    );
    await readyEvent;

    const responseStarted = receiveEvents(socket, 1);
    socket.send(
      JSON.stringify({
        eventId: randomUUID(),
        sequence: 2,
        sessionId,
        text: "Start",
        turnId,
        type: "input.text",
      }),
    );
    await responseStarted;
    socket.send(
      JSON.stringify({
        eventId: randomUUID(),
        responseId: "00000000-0000-4000-8000-000000000001",
        sequence: 3,
        sessionId,
        type: "response.cancel",
      }),
    );

    await waitUntil(() => receivedInputs.some((input) => input.type === "cancel"));
    expect(receivedInputs.map((input) => input.type)).toEqual(["text", "cancel"]);
    socket.terminate();
  });

  it("closes a realtime connection on unknown protocol events", async () => {
    const { app } = await startCore(false);
    const socket = await app.injectWS("/v1/realtime", {
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      socket.once("close", (code, reason) => {
        resolve({ code, reason: reason.toString() });
      });
    });

    socket.send(
      JSON.stringify({
        eventId: randomUUID(),
        sequence: 1,
        sessionId: randomUUID(),
        type: "provider.magic",
      }),
    );

    await expect(closed).resolves.toEqual({
      code: 1003,
      reason: "INVALID_REALTIME_EVENT",
    });
  });
});

async function startCore(
  sealed: boolean,
  realtimeConversationPort: RealtimeConversationPort = new DeterministicRealtimeConversationPort({
    generateId: randomUUID,
  }),
  modelGateway: ModelGateway = new DeterministicModelGateway(),
): Promise<{
  readonly app: ReturnType<typeof buildCoreApp>;
  readonly baseUrl: string;
  readonly client: VioletClient;
}> {
  const ledger = new InMemoryConversationLedger();
  const app = buildCoreApp({
    authenticator: new DeviceAuthenticator({
      expectedHashHex: hashDeviceToken(deviceToken),
      expiresAt: new Date("2100-01-01T00:00:00.000Z"),
    }),
    chatService: new ChatService({
      generateId: randomUUID,
      ledger,
      modelGateway,
    }),
    conversationEndIntent: {
      async shouldEnd() {
        return false;
      },
    },
    contextService: new ContextService({
      artifactStore: new InMemoryContextArtifactStore(),
      repository: new InMemoryContextSessionRepository(),
      understanding: new DeterministicContextUnderstandingPort(),
    }),
    realtimeConversationPort,
    realtimeLedger: ledger,
    sealed,
    version: "test",
  });
  openApps.push(app);
  const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });

  return {
    app,
    baseUrl,
    client: new VioletClient({ baseUrl, deviceToken }),
  };
}

class TestRealtimeOutputQueue {
  readonly #values: RealtimeConversationOutput[] = [];
  readonly #waiters: Array<(value: RealtimeConversationOutput | undefined) => void> = [];
  #closed = false;

  close(): void {
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) {
      waiter(undefined);
    }
  }

  async *events(signal?: AbortSignal): AsyncIterable<RealtimeConversationOutput> {
    while (!this.#closed && !signal?.aborted) {
      const value = this.#values.shift() ?? (await this.#next(signal));
      if (!value) {
        return;
      }
      yield value;
    }
  }

  push(value: RealtimeConversationOutput): void {
    const waiter = this.#waiters.shift();
    if (waiter) {
      waiter(value);
    } else {
      this.#values.push(value);
    }
  }

  #next(signal?: AbortSignal): Promise<RealtimeConversationOutput | undefined> {
    return new Promise((resolve) => {
      const waiter = (value: RealtimeConversationOutput | undefined) => {
        signal?.removeEventListener("abort", onAbort);
        resolve(value);
      };
      const onAbort = () => {
        const index = this.#waiters.indexOf(waiter);
        if (index >= 0) {
          this.#waiters.splice(index, 1);
        }
        waiter(undefined);
      };
      this.#waiters.push(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}

async function waitUntil(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Condition was not met");
}

function receiveEvents(socket: WebSocket, count: number): Promise<RealtimeServerEvent[]> {
  return new Promise((resolve, reject) => {
    const events: RealtimeServerEvent[] = [];
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onMessage = (data: RawData) => {
      events.push(JSON.parse(data.toString()) as RealtimeServerEvent);
      if (events.length === count) {
        cleanup();
        resolve(events);
      }
    };
    const cleanup = () => {
      socket.off("error", onError);
      socket.off("message", onMessage);
    };

    socket.on("error", onError);
    socket.on("message", onMessage);
  });
}

function contextEnvelope(sessionId: string, capturedAt: Date): Record<string, unknown> {
  return {
    authorization: {
      controlledSensitiveAllowed: false,
      grantId: randomUUID(),
      mode: "explicit",
      purpose: "conversation",
      retention: "ephemeral",
    },
    capturedAt: capturedAt.toISOString(),
    completeness: 1,
    confidence: 1,
    eventId: randomUUID(),
    expiresAt: new Date(capturedAt.getTime() + 300_000).toISOString(),
    payload: {
      text: "Selected context",
      type: "focus.text",
    },
    protocolVersion: "1",
    redactions: [],
    sensitivity: "personal",
    sequence: 1,
    sessionId,
    source: {
      deviceId: randomUUID(),
      modality: "accessibility",
    },
  };
}

class RecordingModelGateway implements ModelGateway {
  lastMessages: Parameters<ModelGateway["stream"]>[0]["messages"] = [];

  async *stream(request: Parameters<ModelGateway["stream"]>[0]) {
    this.lastMessages = request.messages;
    yield { content: "ok", type: "delta" as const };
    yield { inputTokens: 1, outputTokens: 1, type: "complete" as const };
  }
}
