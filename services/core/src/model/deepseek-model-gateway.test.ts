import { describe, expect, it } from "vitest";

import { DeepSeekModelGateway } from "./deepseek-model-gateway.js";

describe("DeepSeekModelGateway", () => {
  it("forwards checkpoint output limits and explicitly disables thinking", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const gateway = new DeepSeekModelGateway({
      apiKey: "test-key",
      baseUrl: "https://example.invalid",
      fetch: async (_input, init) => {
        requestBody = JSON.parse(String(init?.body));
        return new Response(
          [
            'data: {"choices":[{"delta":{"content":"checkpoint"}}]}\n\n',
            'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2}}\n\n',
            "data: [DONE]\n\n",
          ].join(""),
          {
            headers: { "content-type": "text/event-stream" },
            status: 200,
          },
        );
      },
      model: "deepseek-flash",
      thinking: true,
      userId: "test-user",
    });

    const events = [];
    for await (const event of gateway.stream({
      maximumOutputTokens: 1_024,
      messages: [{ content: "Summarize", role: "user" }],
      requestId: "test-request",
      thinking: false,
    })) {
      events.push(event);
    }

    expect(requestBody).toMatchObject({
      max_tokens: 1_024,
      model: "deepseek-flash",
      thinking: { type: "disabled" },
    });
    expect(events).toEqual([
      { content: "checkpoint", type: "delta" },
      { inputTokens: 10, outputTokens: 2, type: "complete" },
    ]);
  });

  it("rejects output truncated by the provider token limit", async () => {
    const gateway = new DeepSeekModelGateway({
      apiKey: "test-key",
      baseUrl: "https://example.invalid",
      fetch: async () =>
        new Response(
          [
            'data: {"choices":[{"delta":{"content":"partial checkpoint"}}]}\n\n',
            'data: {"choices":[{"delta":{},"finish_reason":"length"}],"usage":{"prompt_tokens":10,"completion_tokens":1024}}\n\n',
            "data: [DONE]\n\n",
          ].join(""),
          {
            headers: { "content-type": "text/event-stream" },
            status: 200,
          },
        ),
      model: "deepseek-flash",
      userId: "test-user",
    });

    await expect(
      (async () => {
        for await (const _event of gateway.stream({
          maximumOutputTokens: 1_024,
          messages: [{ content: "Summarize", role: "user" }],
          requestId: "truncated-request",
          thinking: false,
        })) {
          // Consume the stream so the terminal provider status is checked.
        }
      })(),
    ).rejects.toThrow("finish_reason=length");
  });
});
