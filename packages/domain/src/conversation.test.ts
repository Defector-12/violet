import { describe, expect, it } from "vitest";

import { Conversation } from "./index.js";

describe("Conversation", () => {
  it("assigns a contiguous sequence", () => {
    const conversation = new Conversation({
      id: "conversation-1",
      identityId: "violet-1",
    });

    const first = conversation.append({
      content: "Hello",
      id: "message-1",
      occurredAt: new Date("2026-08-19T00:00:00Z"),
      requestId: "request-1",
      role: "user",
    });
    const second = conversation.append({
      content: "I am here.",
      id: "message-2",
      occurredAt: new Date("2026-08-19T00:00:01Z"),
      requestId: "request-1",
      role: "assistant",
    });

    expect(first.sequence).toBe(1);
    expect(second.sequence).toBe(2);
    expect(conversation.messages).toHaveLength(2);
  });

  it("rejects non-contiguous restored messages", () => {
    expect(
      () =>
        new Conversation({
          id: "conversation-1",
          identityId: "violet-1",
          messages: [
            {
              content: "Hello",
              id: "message-1",
              occurredAt: new Date(),
              requestId: "request-1",
              role: "user",
              sequence: 2,
            },
          ],
        }),
    ).toThrow("contiguous sequence");
  });
});
