import { describe, expect, it } from "vitest";

import { DeepSeekVisionUnderstandingPort } from "./deepseek-vision-understanding.js";

describe("DeepSeekVisionUnderstandingPort", () => {
  it("uses the OpenAI-compatible vision model without persisting image content", async () => {
    let body: Record<string, unknown> | undefined;
    const fetch = async (_input: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({
        choices: [
          {
            finish_reason: "stop",
            index: 0,
            message: {
              content: "A diagram with two connected services.",
              role: "assistant",
            },
          },
        ],
        created: 1,
        id: "chatcmpl-test",
        model: "deepseek-v4-flash-vision-exp",
        object: "chat.completion",
        usage: {
          completion_tokens: 8,
          prompt_tokens: 12,
          total_tokens: 20,
        },
      });
    };
    const adapter = new DeepSeekVisionUnderstandingPort({
      apiKey: "test-key",
      baseUrl: "https://api.deepseek.com",
      fetch: fetch as typeof globalThis.fetch,
      model: "deepseek-v4-flash-vision-exp",
    });

    await expect(
      adapter.understand({
        localText: "Service A Service B",
        payload: {
          focusPoint: { x: 0.25, y: 0.75 },
          image: {
            bytes: Buffer.from("image"),
            height: 100,
            mediaType: "image/png",
            sha256: "0".repeat(64),
            width: 200,
          },
          localText: "Service A Service B",
          type: "screen.snapshot",
        },
        requestId: "00000000-0000-4000-8000-000000000001",
      }),
    ).resolves.toEqual({
      confidence: 0.85,
      model: "deepseek-v4-flash-vision-exp",
      provider: "deepseek",
      summary: "A diagram with two connected services.",
    });
    expect(body).toMatchObject({
      model: "deepseek-v4-flash-vision-exp",
    });
    expect(JSON.stringify(body)).toContain("locate its arrowhead");
    expect(JSON.stringify(body)).toContain("x increases from left to right");
    expect(JSON.stringify(body)).toContain("separate evidence");
    expect(JSON.stringify(body)).toContain("complete contiguous selection");
    expect(JSON.stringify(body)).toContain("not proof of selection");
    expect(JSON.stringify(body)).toContain("x=0.250, y=0.750");
    expect(JSON.stringify(body)).toContain("white and magenta ring");
    expect(JSON.stringify(body)).toContain("data:image/png;base64,aW1hZ2U=");
  });
});
