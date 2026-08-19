import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { VioletClient } from "./index.js";

function streamingResponse(lines: readonly string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const line of lines) {
          const bytes = encoder.encode(line);
          const split = Math.max(1, Math.floor(bytes.length / 2));
          controller.enqueue(bytes.slice(0, split));
          controller.enqueue(bytes.slice(split));
        }
        controller.close();
      },
    }),
    {
      headers: { "content-type": "application/x-ndjson" },
      status: 200,
    },
  );
}

describe("VioletClient", () => {
  it("parses fragmented NDJSON events", async () => {
    const requestId = randomUUID();
    const events = [
      { eventId: randomUUID(), requestId, type: "start" },
      { content: "Hello", eventId: randomUUID(), requestId, type: "delta" },
      {
        eventId: randomUUID(),
        messageId: randomUUID(),
        requestId,
        type: "complete",
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    ] as const;
    const fetch = () =>
      Promise.resolve(streamingResponse(events.map((event) => `${JSON.stringify(event)}\n`)));
    const client = new VioletClient({
      baseUrl: "http://127.0.0.1:4310",
      deviceToken: "test-token",
      fetch: fetch as typeof globalThis.fetch,
    });

    const received = [];
    for await (const event of client.streamChat({ message: "Hi", requestId })) {
      received.push(event);
    }

    expect(received).toEqual(events);
  });

  it("turns API errors into a stable error type", async () => {
    const requestId = randomUUID();
    const fetch = () =>
      Promise.resolve(
        Response.json(
          {
            code: "CORE_SEALED",
            message: "Core is sealed",
            requestId,
            retryable: true,
          },
          { status: 423 },
        ),
      );
    const client = new VioletClient({
      baseUrl: "http://127.0.0.1:4310",
      deviceToken: "test-token",
      fetch: fetch as typeof globalThis.fetch,
    });

    const consume = async () => {
      for await (const _event of client.streamChat({ message: "Hi", requestId })) {
        // Consume the stream to surface request errors.
      }
    };

    await expect(consume()).rejects.toMatchObject({
      code: "CORE_SEALED",
      requestId,
      retryable: true,
      status: 423,
    });
  });
});
