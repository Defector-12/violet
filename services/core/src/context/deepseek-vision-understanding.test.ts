import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { DeepSeekVisionUnderstandingPort } from "./deepseek-vision-understanding.js";

describe("DeepSeekVisionUnderstandingPort", () => {
  it("preserves indentation and trailing whitespace in text evidence", async () => {
    const selected = "  first line  \n    second line\n";
    const adapter = new DeepSeekVisionUnderstandingPort({
      apiKey: "test-key",
      baseUrl: "https://api.deepseek.com",
      model: "vision",
      fetch: async () =>
        Response.json({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  answer: "Two selected lines.",
                  confidence: 0.9,
                  target: { kind: "text-selection", text: selected },
                }),
              },
            },
          ],
        }),
    });
    const result = await adapter.understand({
      payload: {
        type: "screen.snapshot",
        image: {
          bytes: Buffer.from("image"),
          width: 100,
          height: 100,
          mediaType: "image/png",
          sha256: "0".repeat(64),
        },
      },
      question: "Explain the selected code.",
      requestId: "whitespace-test",
    });
    expect(result.target?.text).toBe(selected);
  });

  it.each([Number.NaN, -0.01, 1.01])(
    "rejects an invalid pointer before sending even a small image (%s)",
    async (x) => {
      let calls = 0;
      const adapter = new DeepSeekVisionUnderstandingPort({
        apiKey: "test-key",
        baseUrl: "https://api.deepseek.com",
        model: "vision",
        fetch: async () => {
          calls += 1;
          return Response.json({ choices: [] });
        },
      });
      await expect(
        adapter.understand({
          payload: {
            type: "screen.snapshot",
            focusPoint: { x, y: 0.5 },
            image: {
              bytes: Buffer.from("image"),
              width: 100,
              height: 100,
              mediaType: "image/png",
              sha256: "0".repeat(64),
            },
          },
          question: "Explain the selected code.",
          requestId: "invalid-pointer-test",
        }),
      ).rejects.toThrow("Invalid captured pointer");
      expect(calls).toBe(0);
    },
  );

  it("maps pointer-detail evidence back to the unchanged full image in one model call", async () => {
    const bytes = await sharp({
      create: { background: "#333333", channels: 3, height: 1200, width: 2000 },
    })
      .png()
      .toBuffer();
    const bodies: Record<string, unknown>[] = [];
    const adapter = new DeepSeekVisionUnderstandingPort({
      apiKey: "test-key",
      baseUrl: "https://api.deepseek.com",
      model: "vision",
      fetch: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return Response.json({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  answer: "Run the selected test.",
                  confidence: 0.9,
                  target: {
                    bounds: { x: 0.1, y: 0.5, width: 0.2, height: 0.25 },
                    kind: "text-selection",
                    text: "pnpm --filter @violet/core test \\\n  -- realtime-session.test.ts",
                  },
                }),
              },
            },
          ],
        });
      },
    });
    const result = await adapter.understand({
      payload: {
        type: "screen.snapshot",
        focusPoint: { x: 0.1, y: 0.9 },
        image: { bytes, width: 2000, height: 1200, mediaType: "image/png", sha256: "0".repeat(64) },
      },
      question: "What does my selected code mean?",
      requestId: "detail-test",
    });
    expect(bodies).toHaveLength(1);
    const messages = bodies[0]?.["messages"] as Array<{
      content: Array<{ image_url?: { url: string } }>;
    }>;
    const urls =
      messages[1]?.content.flatMap((part) => (part.image_url ? [part.image_url.url] : [])) ?? [];
    expect(urls).toHaveLength(2);
    expect(urls[0]).toBe(`data:image/png;base64,${bytes.toString("base64")}`);
    const detail = Buffer.from(urls[1]?.split(",")[1] ?? "", "base64");
    expect(await sharp(detail).metadata()).toMatchObject({ width: 1200, height: 320 });
    expect(result.target?.bounds?.x).toBeCloseTo(0.06);
    expect(result.target?.bounds?.y).toBeCloseTo(0.8666666667);
    expect(result.target?.bounds?.width).toBeCloseTo(0.12);
    expect(result.target?.bounds?.height).toBeCloseTo(0.0666666667);
    expect(result.target?.text).toBe(
      "pnpm --filter @violet/core test \\\n  -- realtime-session.test.ts",
    );
  });

  it("uses a connected blue selection as the text evidence bounds", async () => {
    const bytes = await sharp({
      create: { background: "#1a1b1d", channels: 3, height: 1200, width: 2000 },
    })
      .composite([
        {
          input: {
            create: { background: "#23365d", channels: 3, height: 40, width: 700 },
          },
          left: 300,
          top: 800,
        },
        {
          input: {
            create: { background: "#23365d", channels: 3, height: 40, width: 400 },
          },
          left: 300,
          top: 840,
        },
        {
          input: {
            create: { background: "#d0d0d0", channels: 3, height: 18, width: 140 },
          },
          left: 350,
          top: 811,
        },
      ])
      .jpeg({ quality: 90 })
      .toBuffer();
    const bodies: Record<string, unknown>[] = [];
    const adapter = new DeepSeekVisionUnderstandingPort({
      apiKey: "test-key",
      baseUrl: "https://api.deepseek.com",
      model: "vision",
      fetch: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return Response.json({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  answer: "Selected command.",
                  confidence: 0.95,
                  target: {
                    bounds: { x: 0.4, y: 0.4, width: 0.05, height: 0.05 },
                    kind: "text-selection",
                    lines: [
                      { content: "pnpm test \\", leadingWhitespace: "" },
                      { content: "-- selected.test.ts", leadingWhitespace: "  " },
                    ],
                    text: "incorrect fallback",
                  },
                }),
              },
            },
          ],
        });
      },
    });

    const result = await adapter.understand({
      payload: {
        type: "screen.snapshot",
        focusPoint: { x: 0.2, y: 0.69 },
        image: {
          bytes,
          width: 2000,
          height: 1200,
          mediaType: "image/jpeg",
          sha256: "0".repeat(64),
        },
      },
      question: "What does my selected code mean?",
      requestId: "selection-detail-test",
    });

    const messages = bodies[0]?.["messages"] as Array<{
      content: Array<{ image_url?: { url: string } }>;
    }>;
    const urls =
      messages[1]?.content.flatMap((part) => (part.image_url ? [part.image_url.url] : [])) ?? [];
    const detail = Buffer.from(urls[1]?.split(",")[1] ?? "", "base64");
    expect(await sharp(detail).metadata()).toMatchObject({ width: 733, height: 112 });
    expect(result.target?.bounds?.x).toBeCloseTo(0.15, 2);
    expect(result.target?.bounds?.y).toBeCloseTo(2 / 3, 2);
    expect(result.target?.bounds?.width).toBeCloseTo(0.35, 2);
    expect(result.target?.bounds?.height).toBeCloseTo(1 / 15, 2);
    expect(result.target?.text).toBe("pnpm test \\\n  -- selected.test.ts");
  });

  it("does not treat a compact blue control as a text selection", async () => {
    const bytes = await sharp({
      create: { background: "#333333", channels: 3, height: 1200, width: 2000 },
    })
      .composite([
        {
          input: {
            create: { background: "#23365d", channels: 3, height: 80, width: 80 },
          },
          left: 300,
          top: 800,
        },
      ])
      .png()
      .toBuffer();
    let body: Record<string, unknown> | undefined;
    const adapter = new DeepSeekVisionUnderstandingPort({
      apiKey: "test-key",
      baseUrl: "https://api.deepseek.com",
      model: "vision",
      fetch: async (_input, init) => {
        body = JSON.parse(String(init?.body));
        return Response.json({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  answer: "Not selected text.",
                  confidence: 0.5,
                }),
              },
            },
          ],
        });
      },
    });

    await adapter.understand({
      payload: {
        type: "screen.snapshot",
        focusPoint: { x: 0.17, y: 0.7 },
        image: { bytes, width: 2000, height: 1200, mediaType: "image/png", sha256: "0".repeat(64) },
      },
      question: "What does my selected code mean?",
      requestId: "blue-control-test",
    });

    const messages = body?.["messages"] as Array<{
      content: Array<{ image_url?: { url: string } }>;
    }>;
    const urls =
      messages[1]?.content.flatMap((part) => (part.image_url ? [part.image_url.url] : [])) ?? [];
    const detail = Buffer.from(urls[1]?.split(",")[1] ?? "", "base64");
    expect(await sharp(detail).metadata()).toMatchObject({ width: 1200, height: 320 });
  });

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
      temperature: 0,
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

  it("uses the full image once and treats the pointer as an attention anchor", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetch = async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const content = JSON.stringify({
        answer: "选中的命令会终止正在运行的 Violet 进程。",
        confidence: 0.91,
        target: {
          bounds: { height: 0.08, width: 0.4, x: 0.1, y: 0.7 },
          kind: "text-selection",
          text: "pkill -x Violet",
        },
      });
      return Response.json({
        choices: [{ finish_reason: "stop", index: 0, message: { content, role: "assistant" } }],
        created: 1,
        id: "chatcmpl-selection",
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
          focusPoint: { x: 0.25, y: 0.75 },
          image: {
            bytes: Buffer.from("image"),
            height: 100,
            mediaType: "image/png",
            sha256: "0".repeat(64),
            width: 100,
          },
          type: "screen.snapshot",
        },
        question: "我选中的代码是什么意思？",
        requestId: "00000000-0000-4000-8000-000000000003",
      }),
    ).resolves.toMatchObject({
      answer: "选中的命令会终止正在运行的 Violet 进程。",
      confidence: 0.91,
      target: {
        bounds: { height: 0.08, width: 0.4, x: 0.1, y: 0.7 },
        kind: "text-selection",
        text: "pkill -x Violet",
      },
    });
    const request = JSON.stringify(bodies[0]);
    expect(bodies).toHaveLength(1);
    expect(request).toContain("classify the user's task");
    expect(request).toContain("attention anchor");
    expect(request).toContain("must never be the target");
    expect(request).toContain("rank candidate");
    expect(request).toContain("supporting signals only");
    expect(request).toContain("complete contiguous selection");
    expect(request).toContain("A text target without target.text is invalid");
    expect(request).toContain("copy the exact complete visible text into target.text");
    expect(bodies[0]).toMatchObject({ response_format: { type: "json_object" }, temperature: 0 });
    expect(request).toContain('"detail":"high"');
  });
});
