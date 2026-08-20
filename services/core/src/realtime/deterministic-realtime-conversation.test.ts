import { describe, expect, it } from "vitest";

import { DeterministicRealtimeConversationPort } from "./deterministic-realtime-conversation.js";

describe("DeterministicRealtimeConversationPort", () => {
  it("streams a deterministic text response and advertises only supported capabilities", async () => {
    let id = 0;
    const port = new DeterministicRealtimeConversationPort({
      generateId: () => `id-${++id}`,
    });
    const conversation = await port.open({
      inputModalities: ["audio", "text"],
      outputModalities: ["audio", "text"],
    });
    const events = [];

    for await (const event of conversation.send({
      text: "Hello",
      turnId: "turn-1",
      type: "text",
    })) {
      events.push(event);
    }

    expect(conversation.capabilities).toEqual({
      inputModalities: ["text"],
      interruption: true,
      outputModalities: ["text"],
      runtimeKind: "deterministic",
      transcription: false,
      voiceKind: "none",
    });
    expect(events).toEqual([
      {
        responseId: "id-1",
        turnId: "turn-1",
        type: "response-started",
      },
      {
        responseId: "id-1",
        text: "Violet realtime test response: Hello",
        turnId: "turn-1",
        type: "response-text",
      },
      {
        inputTokens: 5,
        outputTokens: 36,
        responseId: "id-1",
        turnId: "turn-1",
        type: "response-completed",
      },
    ]);
  });

  it("rejects audio without pretending to transcribe it", async () => {
    const port = new DeterministicRealtimeConversationPort({
      generateId: () => "unused",
    });
    const conversation = await port.open({
      inputModalities: ["audio"],
      outputModalities: ["text"],
    });
    const events = [];

    for await (const event of conversation.send({
      audio: Uint8Array.from([0, 1]),
      turnId: "turn-1",
      type: "audio",
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      {
        code: "UNSUPPORTED_REALTIME_INPUT",
        message: "The deterministic realtime adapter accepts text input only",
        retryable: false,
        type: "error",
      },
    ]);
  });
});
