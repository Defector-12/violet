import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  assertChatRequest,
  assertChatStreamEvent,
  assertContextEnvelope,
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

  it("accepts an explicitly authorized context envelope", () => {
    const capturedAt = new Date("2026-08-24T00:00:00.000Z");

    expect(() =>
      assertContextEnvelope({
        authorization: {
          controlledSensitiveAllowed: false,
          grantId: randomUUID(),
          mode: "explicit",
          purpose: "conversation",
          retention: "ephemeral",
        },
        capturedAt: capturedAt.toISOString(),
        completeness: 1,
        confidence: 0.98,
        eventId: randomUUID(),
        expiresAt: new Date(capturedAt.getTime() + 300_000).toISOString(),
        payload: {
          text: "Selected local text",
          type: "focus.text",
        },
        protocolVersion: "1",
        redactions: [{ category: "secure_field", count: 1 }],
        sensitivity: "personal",
        sequence: 1,
        sessionId: randomUUID(),
        source: {
          appBundleId: "com.apple.Preview",
          deviceId: randomUUID(),
          modality: "accessibility",
        },
      }),
    ).not.toThrow();
  });

  it("rejects context payloads with undeclared raw content", () => {
    const capturedAt = new Date("2026-08-24T00:00:00.000Z");

    expect(() =>
      assertContextEnvelope({
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
          rawPassword: "must never cross the device boundary",
          text: "safe text",
          type: "focus.text",
        },
        protocolVersion: "1",
        redactions: [],
        sensitivity: "personal",
        sequence: 1,
        sessionId: randomUUID(),
        source: {
          deviceId: randomUUID(),
          modality: "accessibility",
        },
      }),
    ).toThrow(ProtocolValidationError);
  });

  it("accepts a normalized pointer location on image context", () => {
    const capturedAt = new Date("2026-08-24T00:00:00.000Z");

    expect(() =>
      assertContextEnvelope({
        authorization: {
          controlledSensitiveAllowed: false,
          grantId: randomUUID(),
          mode: "explicit",
          purpose: "conversation",
          retention: "ephemeral",
        },
        capturedAt: capturedAt.toISOString(),
        completeness: 1,
        confidence: 0.8,
        eventId: randomUUID(),
        expiresAt: new Date(capturedAt.getTime() + 300_000).toISOString(),
        payload: {
          focusPoint: { x: 0.25, y: 0.75 },
          image: {
            data: Buffer.from("image").toString("base64"),
            height: 100,
            mediaType: "image/jpeg",
            sha256: "0".repeat(64),
            width: 200,
          },
          type: "screen.snapshot",
        },
        protocolVersion: "1",
        redactions: [],
        sensitivity: "personal",
        sequence: 1,
        sessionId: randomUUID(),
        source: {
          deviceId: randomUUID(),
          modality: "screen",
        },
      }),
    ).not.toThrow();
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
    expect(() =>
      assertRealtimeServerEvent({
        eventId: randomUUID(),
        reason: "user_intent",
        sequence: 4,
        sessionId,
        turnId,
        type: "session.end_requested",
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
