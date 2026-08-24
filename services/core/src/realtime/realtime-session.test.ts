import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ContextService } from "../context/context-service.js";
import { DeterministicContextUnderstandingPort } from "../context/deterministic-context-understanding.js";
import { InMemoryContextArtifactStore } from "../context/in-memory-context-artifact-store.js";
import { InMemoryContextSessionRepository } from "../context/in-memory-context-session-repository.js";
import { InMemoryConversationLedger } from "../conversation/in-memory-conversation-ledger.js";
import { DeterministicRealtimeConversationPort } from "./deterministic-realtime-conversation.js";
import { RealtimeSession } from "./realtime-session.js";

describe("RealtimeSession", () => {
  it("configures once and preserves independent client and server sequences", async () => {
    const sessionId = randomUUID();
    const { ledger, session } = createSession();

    const ready = await collect(
      session.handle({
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
    const responsePromise = take(session.outputs(), 3);
    const immediate = await collect(
      session.handle({
        eventId: randomUUID(),
        sequence: 2,
        sessionId,
        text: "Hello",
        turnId: randomUUID(),
        type: "input.text",
      }),
    );
    const response = await responsePromise;

    expect(ready).toMatchObject([
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
    expect(response.map((event) => [event.sequence, event.type])).toEqual([
      [2, "response.started"],
      [3, "response.text"],
      [4, "response.completed"],
    ]);
    expect(immediate).toEqual([]);
    await expect(ledger.list()).resolves.toMatchObject([
      {
        content: "Hello",
        role: "user",
      },
      {
        content: "Violet realtime test response: Hello",
        role: "assistant",
      },
    ]);
  });

  it("returns the audio formats negotiated by the adapter", async () => {
    const sessionId = randomUUID();
    const ledger = new InMemoryConversationLedger();
    const session = new RealtimeSession({
      conversationPort: {
        async open() {
          return {
            capabilities: {
              inputAudio: {
                channels: 1,
                encoding: "pcm_s16le",
                sampleRate: 16000,
              },
              inputModalities: ["audio", "text"],
              interruption: false,
              outputAudio: {
                channels: 1,
                encoding: "pcm_s16le",
                sampleRate: 24000,
              },
              outputModalities: ["audio", "text"],
              runtimeKind: "integrated",
              transcription: true,
              turnDetection: "smart_turn",
              voiceKind: "preset",
            } as const,
            async close() {},
            async *outputs() {},
            async send() {},
          };
        },
      },
      contextService: createContextService(),
      generateId: randomUUID,
      ledger,
    });

    const ready = await collect(
      session.handle({
        configuration: {
          inputAudio: {
            channels: 1,
            encoding: "pcm_s16le",
            sampleRate: 16000,
          },
          inputModalities: ["audio", "text"],
          outputAudio: {
            channels: 1,
            encoding: "pcm_s16le",
            sampleRate: 24000,
          },
          outputModalities: ["audio", "text"],
          protocolVersion: "1",
        },
        eventId: randomUUID(),
        sequence: 1,
        sessionId,
        type: "session.configure",
      }),
    );

    expect(ready[0]).toMatchObject({
      capabilities: {
        inputAudio: { sampleRate: 16000 },
        outputAudio: { sampleRate: 24000 },
        turnDetection: "smart_turn",
      },
      type: "session.ready",
    });
  });

  it("seeds a new realtime runtime with recent ledger history", async () => {
    const sessionId = randomUUID();
    const ledger = new InMemoryConversationLedger();
    await ledger.append({
      content: "Earlier question",
      id: randomUUID(),
      occurredAt: new Date("2026-08-22T00:00:00.000Z"),
      requestId: randomUUID(),
      role: "user",
    });
    await ledger.append({
      content: "Earlier answer",
      id: randomUUID(),
      occurredAt: new Date("2026-08-22T00:00:01.000Z"),
      requestId: randomUUID(),
      role: "assistant",
    });
    let observedConfiguration: Parameters<DeterministicRealtimeConversationPort["open"]>[0] | null =
      null;
    const deterministic = new DeterministicRealtimeConversationPort({
      generateId: randomUUID,
    });
    const session = new RealtimeSession({
      conversationPort: {
        async open(configuration, signal) {
          observedConfiguration = configuration;
          return deterministic.open(configuration, signal);
        },
      },
      contextService: createContextService(),
      generateId: randomUUID,
      ledger,
    });

    await collect(
      session.handle({
        configuration: {
          inputModalities: ["audio", "text"],
          outputModalities: ["audio", "text"],
          protocolVersion: "1",
          turnDetection: "smart_turn",
        },
        eventId: randomUUID(),
        sequence: 1,
        sessionId,
        type: "session.configure",
      }),
    );

    expect(observedConfiguration).toMatchObject({
      history: [
        { content: "Earlier question", role: "user" },
        { content: "Earlier answer", role: "assistant" },
      ],
      turnDetection: "smart_turn",
    });
  });

  it("resolves an active context before opening the realtime provider", async () => {
    const sessionId = randomUUID();
    const contextSessionId = randomUUID();
    const contextService = createContextService();
    const capturedAt = new Date();
    await contextService.submit({
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
        text: "Current selected evidence",
        type: "focus.text",
      },
      protocolVersion: "1",
      redactions: [],
      sensitivity: "personal",
      sequence: 1,
      sessionId: contextSessionId,
      source: {
        deviceId: randomUUID(),
        modality: "accessibility",
      },
    });
    let observedConfiguration: Parameters<DeterministicRealtimeConversationPort["open"]>[0] | null =
      null;
    const deterministic = new DeterministicRealtimeConversationPort({
      generateId: randomUUID,
    });
    const session = new RealtimeSession({
      contextService,
      conversationPort: {
        async open(configuration, signal) {
          observedConfiguration = configuration;
          return deterministic.open(configuration, signal);
        },
      },
      generateId: randomUUID,
      ledger: new InMemoryConversationLedger(),
    });

    await collect(
      session.handle({
        configuration: {
          contextSessionId,
          inputModalities: ["audio", "text"],
          outputModalities: ["audio", "text"],
          protocolVersion: "1",
        },
        eventId: randomUUID(),
        sequence: 1,
        sessionId,
        type: "session.configure",
      }),
    );

    expect(observedConfiguration).toMatchObject({
      contextEvidence: expect.stringContaining("Current selected evidence"),
    });
  });

  it("rejects out-of-order and mismatched events without advancing client state", async () => {
    const sessionId = randomUUID();
    const { session } = createSession();
    await collect(
      session.handle({
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

    const outOfOrder = await collect(
      session.handle({
        eventId: randomUUID(),
        sequence: 3,
        sessionId,
        text: "Skipped sequence two",
        turnId: randomUUID(),
        type: "input.text",
      }),
    );
    const wrongSession = await collect(
      session.handle({
        eventId: randomUUID(),
        sequence: 2,
        sessionId: randomUUID(),
        text: "Wrong session",
        turnId: randomUUID(),
        type: "input.text",
      }),
    );
    const acceptedEventId = randomUUID();
    const responsePromise = take(session.outputs(), 3);
    const accepted = await collect(
      session.handle({
        eventId: acceptedEventId,
        sequence: 2,
        sessionId,
        text: "Correct",
        turnId: randomUUID(),
        type: "input.text",
      }),
    );
    const response = await responsePromise;
    const duplicate = await collect(
      session.handle({
        eventId: acceptedEventId,
        sequence: 3,
        sessionId,
        text: "Replay",
        turnId: randomUUID(),
        type: "input.text",
      }),
    );

    expect(outOfOrder[0]).toMatchObject({
      code: "INVALID_EVENT_SEQUENCE",
      type: "error",
    });
    expect(wrongSession[0]).toMatchObject({
      code: "SESSION_ID_MISMATCH",
      type: "error",
    });
    expect(accepted).toEqual([]);
    expect(response.map((event) => event.type)).toEqual([
      "response.started",
      "response.text",
      "response.completed",
    ]);
    expect(duplicate[0]).toMatchObject({
      code: "DUPLICATE_EVENT",
      type: "error",
    });
  });

  it("requires configuration before input and closes without provider output", async () => {
    const sessionId = randomUUID();
    const { session } = createSession();
    const beforeConfiguration = await collect(
      session.handle({
        eventId: randomUUID(),
        sequence: 1,
        sessionId,
        text: "Too early",
        turnId: randomUUID(),
        type: "input.text",
      }),
    );

    expect(beforeConfiguration[0]).toMatchObject({
      code: "SESSION_NOT_CONFIGURED",
      type: "error",
    });

    await collect(
      session.handle({
        configuration: {
          inputModalities: ["text"],
          outputModalities: ["text"],
          protocolVersion: "1",
        },
        eventId: randomUUID(),
        sequence: 2,
        sessionId,
        type: "session.configure",
      }),
    );
    const closeEvents = await collect(
      session.handle({
        eventId: randomUUID(),
        sequence: 3,
        sessionId,
        type: "session.close",
      }),
    );

    expect(closeEvents).toEqual([]);
    expect(session.closed).toBe(true);
  });
});

function createSession(): {
  readonly ledger: InMemoryConversationLedger;
  readonly session: RealtimeSession;
} {
  let id = 0;
  const generateId = () => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`;
  const ledger = new InMemoryConversationLedger();
  return {
    ledger,
    session: new RealtimeSession({
      conversationPort: new DeterministicRealtimeConversationPort({ generateId }),
      contextService: createContextService(),
      generateId,
      ledger,
    }),
  };
}

function createContextService(): ContextService {
  return new ContextService({
    artifactStore: new InMemoryContextArtifactStore(),
    repository: new InMemoryContextSessionRepository(),
    understanding: new DeterministicContextUnderstandingPort(),
  });
}

async function collect<T>(events: AsyncIterable<T>): Promise<T[]> {
  const collected = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}

async function take<T>(events: AsyncIterable<T>, count: number): Promise<T[]> {
  const collected = [];
  for await (const event of events) {
    collected.push(event);
    if (collected.length === count) {
      break;
    }
  }
  return collected;
}
