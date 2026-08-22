import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  assertChatRequest,
  assertChatStreamEvent,
  assertRealtimeClientEvent,
  assertRealtimeServerEvent,
  ProtocolValidationError,
} from "./index.js";

describe("protocol validation", () => {
  it("accepts a valid chat request", () => {
    expect(() =>
      assertChatRequest({
        message: "Hello",
        requestId: randomUUID(),
      }),
    ).not.toThrow();
  });

  it("rejects undeclared fields", () => {
    expect(() =>
      assertChatRequest({
        message: "Hello",
        requestId: randomUUID(),
        secret: "must not cross the protocol boundary",
      }),
    ).toThrow(ProtocolValidationError);
  });

  it("accepts every stream event shape", () => {
    const requestId = randomUUID();

    const events = [
      { eventId: randomUUID(), requestId, type: "start" },
      { content: "Hi", eventId: randomUUID(), requestId, type: "delta" },
      {
        eventId: randomUUID(),
        messageId: randomUUID(),
        requestId,
        type: "complete",
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    ];

    for (const event of events) {
      expect(() => assertChatStreamEvent(event)).not.toThrow();
    }
  });

  it("accepts provider-neutral realtime events", () => {
    const sessionId = randomUUID();
    const turnId = randomUUID();
    const responseId = randomUUID();

    expect(() =>
      assertRealtimeClientEvent({
        configuration: {
          inputModalities: ["audio", "text"],
          outputModalities: ["audio", "text"],
          protocolVersion: "1",
        },
        eventId: randomUUID(),
        sequence: 1,
        sessionId,
        type: "session.configure",
      }),
    ).not.toThrow();
    expect(() =>
      assertRealtimeClientEvent({
        eventId: randomUUID(),
        sequence: 2,
        sessionId,
        text: "Hello",
        turnId,
        type: "input.text",
      }),
    ).not.toThrow();
    expect(() =>
      assertRealtimeServerEvent({
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
        },
        eventId: randomUUID(),
        sequence: 1,
        sessionId,
        type: "session.ready",
      }),
    ).not.toThrow();
    expect(() =>
      assertRealtimeServerEvent({
        eventId: randomUUID(),
        sequence: 2,
        sessionId,
        turnId,
        type: "input.speech.started",
      }),
    ).not.toThrow();
    expect(() =>
      assertRealtimeServerEvent({
        eventId: randomUUID(),
        responseId,
        sequence: 3,
        sessionId,
        turnId,
        type: "response.completed",
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    ).not.toThrow();
  });

  it("rejects unknown realtime events and invalid sequence numbers", () => {
    const sessionId = randomUUID();

    expect(() =>
      assertRealtimeClientEvent({
        eventId: randomUUID(),
        sequence: 1,
        sessionId,
        type: "provider.magic",
      }),
    ).toThrow(ProtocolValidationError);
    expect(() =>
      assertRealtimeClientEvent({
        eventId: randomUUID(),
        sequence: 0,
        sessionId,
        type: "session.close",
      }),
    ).toThrow(ProtocolValidationError);
  });
});
