import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { assertChatRequest, assertChatStreamEvent, ProtocolValidationError } from "./index.js";

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
});
