import sharp from "sharp";
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

  it("answers the original question with structured target evidence", async () => {
    let body: Record<string, unknown> | undefined;
    const fetch = async (_input: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({
        choices: [
          {
            finish_reason: "stop",
            index: 0,
            message: {
              content: JSON.stringify({
                answer: "右下角绿色上箭头是发送按钮。",
                confidence: 0.94,
                target: {
                  bounds: { height: 0.3, width: 0.3, x: 0.65, y: 0.65 },
                  color: "green",
                  kind: "button",
                },
              }),
              role: "assistant",
            },
          },
        ],
        created: 1,
        id: "chatcmpl-test",
        model: "deepseek-v4-flash-vision-exp",
        object: "chat.completion",
        usage: {
          completion_tokens: 20,
          prompt_tokens: 30,
          total_tokens: 50,
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
        payload: {
          image: {
            bytes: Buffer.from("image"),
            height: 100,
            mediaType: "image/png",
            sha256: "0".repeat(64),
            width: 200,
          },
          type: "screen.snapshot",
        },
        question: "右下角绿色按钮有什么作用？",
        requestId: "00000000-0000-4000-8000-000000000002",
      }),
    ).resolves.toEqual({
      answer: "右下角绿色上箭头是发送按钮。",
      confidence: 0.94,
      model: "deepseek-v4-flash-vision-exp",
      provider: "deepseek",
      summary: "右下角绿色上箭头是发送按钮。",
      target: {
        bounds: { height: 0.3, width: 0.3, x: 0.65, y: 0.65 },
        color: "green",
        kind: "button",
      },
    });
    expect(JSON.stringify(body)).toContain("User question");
    expect(JSON.stringify(body)).toContain("右下角绿色按钮有什么作用");
  });

  it("rechecks a small target using a cropped image", async () => {
    const source = await sharp({
      create: {
        background: { alpha: 1, b: 0, g: 255, r: 0 },
        channels: 4,
        height: 100,
        width: 100,
      },
    })
      .png()
      .toBuffer();
    const responses = [
      {
        answer: "右下角是一个绿色按钮。",
        confidence: 0.91,
        target: {
          bounds: { height: 0.05, width: 0.05, x: 0.9, y: 0.9 },
          color: "green",
          kind: "button",
        },
      },
      {
        answer: "右下角绿色上箭头按钮用于发送消息。",
        confidence: 0.96,
        target: {
          bounds: { height: 0.5, width: 0.5, x: 0.25, y: 0.25 },
          color: "green",
          kind: "send button",
        },
      },
    ];
    const bodies: Record<string, unknown>[] = [];
    const fetch = async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const content = JSON.stringify(responses[bodies.length - 1]);
      return Response.json({
        choices: [{ finish_reason: "stop", index: 0, message: { content, role: "assistant" } }],
        created: 1,
        id: `chatcmpl-${bodies.length}`,
        model: "deepseek-v4-flash-vision-exp",
        object: "chat.completion",
        usage: { completion_tokens: 20, prompt_tokens: 30, total_tokens: 50 },
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
        payload: {
          image: {
            bytes: source,
            height: 100,
            mediaType: "image/png",
            sha256: "0".repeat(64),
            width: 100,
          },
          type: "screen.snapshot",
        },
        question: "右下角绿色按钮有什么作用？",
        requestId: "00000000-0000-4000-8000-000000000003",
      }),
    ).resolves.toMatchObject({
      answer: "右下角绿色上箭头按钮用于发送消息。",
      confidence: 0.91,
      target: {
        bounds: { height: 0.05, width: 0.05, x: 0.9, y: 0.9 },
        color: "green",
        kind: "send button",
      },
    });
    expect(bodies).toHaveLength(2);
    expect(JSON.stringify(bodies[1])).toContain("close crop");
    expect(JSON.stringify(bodies[1])).toContain("data:image/jpeg;base64");
  });
});
