import { describe, expect, it } from "vitest";

import { DeepSeekVisionUnderstandingPort } from "./deepseek-vision-understanding.js";

const image = {
  bytes: Uint8Array.from([1, 2, 3]),
  height: 900,
  mediaType: "image/png" as const,
  sha256: "synthetic",
  width: 1400,
};

function fixture(result: unknown) {
  let body: Record<string, unknown> | undefined;
  const port = new DeepSeekVisionUnderstandingPort({
    apiKey: "test-key",
    baseUrl: "https://example.invalid",
    model: "test-vision",
    fetch: async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return Response.json({
        choices: [{ message: { content: JSON.stringify(result) } }],
      });
    },
  });
  return { port, body: () => body };
}

describe("DeepSeekVisionUnderstandingPort", () => {
  it("sends one full image with the question and pointer", async () => {
    const f = fixture({ answer: "The label is EMBER.", confidence: 0.95 });
    const result = await f.port.understand({
      payload: {
        focusPoint: { x: 0.22, y: 0.35 },
        image,
        type: "screen.snapshot",
      },
      question: "What is the pointed shape's label?",
      requestId: "request",
    });
    const body = f.body();
    if (!body) throw new Error("Expected a provider request");
    const content = (
      body["messages"] as Array<{
        readonly content: Array<{ readonly image_url?: unknown; readonly text?: string }>;
      }>
    )[1]?.content;

    expect(result).toEqual({
      answer: "The label is EMBER.",
      confidence: 0.95,
      model: "test-vision",
      provider: "deepseek",
      summary: "The label is EMBER.",
    });
    expect(content?.filter((part) => part.image_url)).toHaveLength(1);
    expect(content?.[0]?.text).toContain("x=0.220, y=0.350");
    expect(content?.[0]?.text).toContain("pixel x=308, y=315");
    expect(JSON.stringify(body)).toContain("do not substitute a nearby object");
    expect(JSON.stringify(body)).not.toContain("target.bounds");
    expect(JSON.stringify(body)).not.toContain("Image 2");
  });

  it("returns an ungrounded summary when no question is supplied", async () => {
    const f = fixture({ answer: "A synthetic dashboard.", confidence: 0.8 });
    await expect(
      f.port.understand({
        payload: { image, type: "screen.snapshot" },
        requestId: "request",
      }),
    ).resolves.toEqual({
      confidence: 0.8,
      model: "test-vision",
      provider: "deepseek",
      summary: "A synthetic dashboard.",
    });
  });

  it.each([
    "not json",
    JSON.stringify({ answer: "", confidence: 0.9 }),
    JSON.stringify({ answer: "visible", confidence: 2 }),
  ])("rejects malformed provider output: %s", async (content) => {
    const port = new DeepSeekVisionUnderstandingPort({
      apiKey: "test-key",
      baseUrl: "https://example.invalid",
      model: "test-vision",
      fetch: async () =>
        Response.json({
          choices: [{ message: { content } }],
        }),
    });
    await expect(
      port.understand({
        payload: { image, type: "screen.snapshot" },
        question: "What is visible?",
        requestId: "request",
      }),
    ).rejects.toThrow();
  });

  it("rejects a non-image payload", async () => {
    const f = fixture({ answer: "unused", confidence: 1 });
    await expect(
      f.port.understand({
        payload: { text: "not an image", type: "focus.text" },
        requestId: "request",
      }),
    ).rejects.toThrow("requires an image");
  });
});
