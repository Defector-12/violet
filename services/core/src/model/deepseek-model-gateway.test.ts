import { describe, expect, it } from "vitest";

import { DeepSeekModelGateway } from "./deepseek-model-gateway.js";

describe("DeepSeekModelGateway", () => {
  it("assembles fragmented recall calls and sends matching tool results back to the provider", async () => {
    const bodies: Record<string, unknown>[] = [];
    const gateway = new DeepSeekModelGateway({
      apiKey: "test-key",
      baseUrl: "https://example.invalid",
      model: "deepseek-flash",
      userId: "test",
      fetch: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        const chunks =
          bodies.length === 1
            ? [
                {
                  choices: [
                    {
                      delta: {
                        tool_calls: [
                          {
                            index: 0,
                            id: "call-1",
                            function: { name: "recall_memory", arguments: '{"query":' },
                          },
                        ],
                      },
                    },
                  ],
                },
                {
                  choices: [
                    {
                      delta: { tool_calls: [{ index: 0, function: { arguments: '"紫色"}' } }] },
                      finish_reason: "tool_calls",
                    },
                  ],
                },
              ]
            : [{ choices: [{ delta: { content: "你喜欢紫色。" }, finish_reason: "stop" }] }];
        return new Response(
          `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    const request = {
      requestId: "recall",
      messages: [{ role: "user" as const, content: "我喜欢什么颜色" }],
      tools: [{ name: "recall_memory", description: "Recall", parameters: { type: "object" } }],
    };
    const events = [];
    for await (const event of gateway.stream(request)) events.push(event);
    const complete = events.at(-1);
    expect(complete).toMatchObject({
      type: "complete",
      toolCalls: [{ id: "call-1", name: "recall_memory", arguments: '{"query":"紫色"}' }],
    });
    if (complete?.type !== "complete" || !complete.toolCalls) throw new Error("Expected complete");
    for await (const _event of gateway.stream({
      ...request,
      messages: [
        ...request.messages,
        { role: "assistant", content: "", toolCalls: complete.toolCalls },
        { role: "tool", content: '{"status":"found"}', toolCallId: "call-1" },
      ],
      thinking: false,
    })) {
      /* consume provider reply */
    }
    expect(bodies[1]).toMatchObject({
      messages: [
        { role: "user" },
        { role: "assistant", tool_calls: [{ id: "call-1", type: "function" }] },
        { role: "tool", tool_call_id: "call-1", content: '{"status":"found"}' },
      ],
      thinking: { type: "disabled" },
    });
  });

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
