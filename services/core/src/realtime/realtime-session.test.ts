import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

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
    const response = await collect(
      session.handle({
        eventId: randomUUID(),
        sequence: 2,
        sessionId,
        text: "Hello",
        turnId: randomUUID(),
        type: "input.text",
      }),
    );

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
              voiceKind: "preset",
            } as const,
            async close() {},
            async *send() {},
          };
        },
      },
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
      },
      type: "session.ready",
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
    expect(accepted.map((event) => event.type)).toEqual([
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
      generateId,
      ledger,
    }),
  };
}

async function collect<T>(events: AsyncIterable<T>): Promise<T[]> {
  const collected = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}
