import { describe, expect, it } from "vitest";

import { DeterministicModelGateway } from "./deterministic-model-gateway.js";

describe("DeterministicModelGateway", () => {
  it("honors the requested output-token limit", async () => {
    const events = [];
    for await (const event of new DeterministicModelGateway().stream({
      maximumOutputTokens: 4,
      messages: [{ content: "A long deterministic input", role: "user" }],
      requestId: "request-1",
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      { content: "Violet test resp", type: "delta" },
      { inputTokens: 7, outputTokens: 4, type: "complete" },
    ]);
  });
});
