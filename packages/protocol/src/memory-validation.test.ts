import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  assertChatStreamEvent,
  assertMemoryCorrection,
  assertMemoryDeletionConfirmation,
  assertMemoryDeletionPreviewRequest,
  assertRealtimeServerEvent,
  ProtocolValidationError,
} from "./validation.js";

describe("memory protocol", () => {
  it("requires explicit versioned correction and preview before confirmation", () => {
    expect(() =>
      assertMemoryCorrection({
        requestId: randomUUID(),
        expectedVersion: 1,
        content: "新的用户原话",
      }),
    ).not.toThrow();
    expect(() =>
      assertMemoryCorrection({
        requestId: randomUUID(),
        content: "缺少版本",
      }),
    ).toThrow(ProtocolValidationError);
    expect(() =>
      assertMemoryDeletionPreviewRequest({
        id: randomUUID(),
        target: { kind: "all" },
      }),
    ).not.toThrow();
    expect(() =>
      assertMemoryDeletionPreviewRequest({
        id: randomUUID(),
        target: { kind: "memory", id: randomUUID() },
      }),
    ).toThrow(ProtocolValidationError);
    expect(() =>
      assertMemoryDeletionConfirmation({
        instanceId: randomUUID(),
        minimumRestoreEpoch: 0,
      }),
    ).toThrow(ProtocolValidationError);
    expect(() =>
      assertMemoryDeletionConfirmation({
        instanceId: randomUUID(),
        minimumRestoreEpoch: 1,
        target: "delete everything",
      }),
    ).toThrow(ProtocolValidationError);
  });

  it("carries only IDs in completion feedback on both modalities", () => {
    const metadata = {
      memoryChanges: [{ id: randomUUID(), kind: "corrected", version: 2 }],
      memoryDeletionPreviewId: randomUUID(),
    };
    const text = {
      eventId: randomUUID(),
      requestId: randomUUID(),
      messageId: randomUUID(),
      type: "complete",
      usage: { inputTokens: 1, outputTokens: 1 },
      ...metadata,
    };
    const voice = {
      eventId: randomUUID(),
      sessionId: randomUUID(),
      turnId: randomUUID(),
      responseId: randomUUID(),
      sequence: 1,
      type: "response.completed",
      usage: { inputTokens: 1, outputTokens: 1 },
      ...metadata,
    };
    expect(() => assertChatStreamEvent(text)).not.toThrow();
    expect(() => assertRealtimeServerEvent(voice)).not.toThrow();
    expect(() =>
      assertChatStreamEvent({
        ...text,
        memoryChanges: [{ ...metadata.memoryChanges[0], content: "正文不属于变化通知" }],
      }),
    ).toThrow(ProtocolValidationError);
  });
});
