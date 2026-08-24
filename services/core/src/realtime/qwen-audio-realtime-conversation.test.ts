import { describe, expect, it } from "vitest";

import {
  QwenAudioRealtimeConversationPort,
  type QwenRealtimeTransport,
} from "./qwen-audio-realtime-conversation.js";

describe("QwenAudioRealtimeConversationPort", () => {
  it("opens the Beijing workspace endpoint without registering provider tools", async () => {
    const transport = new FakeTransport([{ type: "session.created" }, { type: "session.updated" }]);
    let observedUrl: URL | undefined;
    let observedHeaders: Readonly<Record<string, string>> | undefined;
    const port = new QwenAudioRealtimeConversationPort({
      apiKey: "test-qwen-api-key",
      createTransport: (url, headers) => {
        observedUrl = url;
        observedHeaders = headers;
        return transport;
      },
      generateId: () => "00000000-0000-4000-8000-000000000001",
      model: "qwen-audio-3.0-realtime-plus",
      voice: "longanqian",
      workspaceId: "ws-jvh4fvlcktrjvtbj",
    });

    const conversation = await port.open(configuration());

    expect(observedUrl?.toString()).toBe(
      "wss://ws-jvh4fvlcktrjvtbj.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime?model=qwen-audio-3.0-realtime-plus",
    );
    expect(observedHeaders).toEqual({
      Authorization: "Bearer test-qwen-api-key",
      "User-Agent": "violet-core/0.1",
      "X-DashScope-WorkSpace": "ws-jvh4fvlcktrjvtbj",
    });
    expect(transport.sent).toEqual([
      {
        session: {
          enable_speech_emotion: true,
          input_audio_format: "pcm",
          instructions:
            "You are Violet, the user's private AI assistant. Reply naturally and concisely in the user's language. Never claim an action completed without a Core-confirmed tool result.",
          max_history_turns: 20,
          modalities: ["audio", "text"],
          output_audio_format: "pcm",
          turn_detection: null,
          voice: "longanqian",
        },
        type: "session.update",
      },
    ]);
    expect(conversation.capabilities).toEqual({
      inputAudio: {
        channels: 1,
        encoding: "pcm_s16le",
        sampleRate: 16000,
      },
      inputModalities: ["audio", "text"],
      interruption: false,
      outputAudio: {
        channels: 1,
        encoding: "pcm_s16le",
        sampleRate: 24000,
      },
      outputModalities: ["audio", "text"],
      runtimeKind: "integrated",
      transcription: true,
      turnDetection: "manual",
      voiceKind: "preset",
    });
  });

  it("maps a push-to-talk audio turn into provider-neutral output", async () => {
    const transport = new FakeTransport([
      { type: "session.created" },
      { type: "session.updated" },
      {
        stash: "Violet",
        text: "Hello ",
        type: "conversation.item.input_audio_transcription.delta",
      },
      {
        transcript: "Hello Violet",
        type: "conversation.item.input_audio_transcription.completed",
      },
      {
        response: { id: "resp_qwen_123", status: "in_progress" },
        type: "response.created",
      },
      {
        delta: "Hello",
        response_id: "resp_qwen_123",
        type: "response.audio_transcript.delta",
      },
      {
        delta: Buffer.from([1, 2, 3, 4]).toString("base64"),
        response_id: "resp_qwen_123",
        type: "response.audio.delta",
      },
      {
        response: {
          id: "resp_qwen_123",
          status: "completed",
          usage: { input_tokens: 12, output_tokens: 7 },
        },
        type: "response.done",
      },
    ]);
    const localResponseId = "00000000-0000-4000-8000-000000000009";
    const port = new QwenAudioRealtimeConversationPort({
      apiKey: "test-qwen-api-key",
      createTransport: () => transport,
      generateId: () => localResponseId,
      model: "qwen-audio-3.0-realtime-plus",
      voice: "longanqian",
      workspaceId: "ws-jvh4fvlcktrjvtbj",
    });
    const conversation = await port.open(configuration());

    await conversation.send({
      audio: Uint8Array.from([4, 5, 6, 7]),
      turnId: "turn-1",
      type: "audio",
    });
    await conversation.send({
      turnId: "turn-1",
      type: "commit",
    });
    const outputPromise = take(conversation.outputs(), 6);
    const output = await outputPromise;

    expect(transport.sent.slice(1)).toEqual([
      {
        audio: Buffer.from([4, 5, 6, 7]).toString("base64"),
        type: "input_audio_buffer.append",
      },
      { type: "input_audio_buffer.commit" },
      { type: "response.create" },
    ]);
    expect(output).toEqual([
      {
        final: false,
        text: "Hello Violet",
        turnId: "turn-1",
        type: "transcript",
      },
      {
        final: true,
        text: "Hello Violet",
        turnId: "turn-1",
        type: "transcript",
      },
      {
        responseId: localResponseId,
        turnId: "turn-1",
        type: "response-started",
      },
      {
        responseId: localResponseId,
        text: "Hello",
        turnId: "turn-1",
        type: "response-text",
      },
      {
        audio: Uint8Array.from([1, 2, 3, 4]),
        responseId: localResponseId,
        turnId: "turn-1",
        type: "response-audio",
      },
      {
        inputTokens: 12,
        outputTokens: 7,
        responseId: localResponseId,
        turnId: "turn-1",
        type: "response-completed",
      },
    ]);
  });

  it("keeps a smart-turn session open, seeds history, and cancels on barge-in", async () => {
    const transport = new FakeTransport([
      { type: "session.created" },
      { type: "session.updated" },
      { type: "input_audio_buffer.speech_started" },
      { type: "input_audio_buffer.speech_stopped" },
      {
        transcript: "First turn",
        type: "conversation.item.input_audio_transcription.completed",
      },
      {
        response: { id: "resp-qwen-1", status: "in_progress" },
        type: "response.created",
      },
      {
        delta: "First answer",
        response_id: "resp-qwen-1",
        type: "response.audio_transcript.delta",
      },
      {
        delta: Buffer.from([1, 2]).toString("base64"),
        response_id: "resp-qwen-1",
        type: "response.audio.delta",
      },
      { type: "input_audio_buffer.speech_started" },
      {
        response: { id: "resp-qwen-1", status: "cancelled" },
        type: "response.done",
      },
    ]);
    let id = 0;
    const port = new QwenAudioRealtimeConversationPort({
      apiKey: "test-qwen-api-key",
      createTransport: () => transport,
      generateId: () => `id-${++id}`,
      model: "qwen-audio-3.0-realtime-plus",
      voice: "longanqian",
      workspaceId: "ws-jvh4fvlcktrjvtbj",
    });
    const conversation = await port.open({
      ...configuration(),
      history: [
        { content: "Earlier question", role: "user" },
        { content: "Earlier answer", role: "assistant" },
      ],
      turnDetection: "smart_turn",
    });
    const outputPromise = take(conversation.outputs(), 8);

    await conversation.send({
      audio: Uint8Array.from([4, 5, 6, 7]),
      turnId: "continuous-stream",
      type: "audio",
    });
    const output = await outputPromise;

    expect(conversation.capabilities).toMatchObject({
      interruption: true,
      turnDetection: "smart_turn",
    });
    expect(transport.sent[0]).toMatchObject({
      session: {
        turn_detection: { type: "smart_turn" },
      },
      type: "session.update",
    });
    expect(transport.sent.slice(1, 3)).toEqual([
      {
        item: {
          content: [{ text: "Earlier question", type: "input_text" }],
          role: "user",
          type: "message",
        },
        type: "conversation.item.create",
      },
      {
        item: {
          content: [{ text: "Earlier answer", type: "output_text" }],
          role: "assistant",
          type: "message",
        },
        type: "conversation.item.create",
      },
    ]);
    expect(output.map((event) => event.type)).toEqual([
      "speech-started",
      "speech-stopped",
      "transcript",
      "response-started",
      "response-text",
      "response-audio",
      "speech-started",
      "response-cancelled",
    ]);
    expect(output[0]).toMatchObject({ turnId: "id-1" });
    expect(output[2]).toMatchObject({ text: "First turn", turnId: "id-1" });
    expect(output[3]).toMatchObject({ responseId: "id-2", turnId: "id-1" });
    expect(output[6]).toMatchObject({ turnId: "id-3" });
    expect(transport.sent).toContainEqual({ type: "response.cancel" });
  });

  it("ignores a late cancellation after the provider response is done", async () => {
    const transport = new FakeTransport([
      { type: "session.created" },
      { type: "session.updated" },
      {
        response: { id: "resp-qwen-1", status: "in_progress" },
        type: "response.created",
      },
      {
        response: { id: "resp-qwen-1", status: "completed" },
        type: "response.done",
      },
    ]);
    const generatedIds = ["local-response-1", "turn-1"];
    const port = new QwenAudioRealtimeConversationPort({
      apiKey: "test-qwen-api-key",
      createTransport: () => transport,
      generateId: () => generatedIds.shift() ?? "unexpected-id",
      model: "qwen-audio-3.0-realtime-plus",
      voice: "longanqian",
      workspaceId: "ws-jvh4fvlcktrjvtbj",
    });
    const conversation = await port.open(configuration());
    const output = await take(conversation.outputs(), 2);

    await expect(
      conversation.send({
        responseId: "local-response-1",
        type: "cancel",
      }),
    ).resolves.toBeUndefined();

    expect(output.map((event) => event.type)).toEqual(["response-started", "response-completed"]);
    expect(transport.sent).not.toContainEqual({ type: "response.cancel" });
  });

  it("rejects an output format that Qwen cannot produce", async () => {
    let transportCreated = false;
    const port = new QwenAudioRealtimeConversationPort({
      apiKey: "test-qwen-api-key",
      createTransport: () => {
        transportCreated = true;
        return new FakeTransport([]);
      },
      generateId: () => "unused",
      model: "qwen-audio-3.0-realtime-plus",
      voice: "longanqian",
      workspaceId: "ws-jvh4fvlcktrjvtbj",
    });

    await expect(
      port.open({
        ...configuration(),
        outputAudio: {
          channels: 1,
          encoding: "pcm_s16le",
          sampleRate: 16000,
        },
      }),
    ).rejects.toThrow("24kHz");
    expect(transportCreated).toBe(false);
  });
});

class FakeTransport implements QwenRealtimeTransport {
  readonly sent: Array<Readonly<Record<string, unknown>>> = [];
  readonly #events: unknown[];
  closed = false;
  connected = false;

  constructor(events: unknown[]) {
    this.#events = [...events];
  }

  close(): void {
    this.closed = true;
  }

  async connect(): Promise<void> {
    this.connected = true;
  }

  async receive(): Promise<unknown> {
    if (this.#events.length === 0) {
      throw new Error("No fake Qwen event is available");
    }
    return this.#events.shift();
  }

  async send(event: Readonly<Record<string, unknown>>): Promise<void> {
    this.sent.push(event);
  }
}

function configuration() {
  return {
    inputAudio: {
      channels: 1 as const,
      encoding: "pcm_s16le" as const,
      sampleRate: 16000 as const,
    },
    inputModalities: ["audio", "text"] as const,
    outputAudio: {
      channels: 1 as const,
      encoding: "pcm_s16le" as const,
      sampleRate: 24000 as const,
    },
    outputModalities: ["audio", "text"] as const,
  };
}

async function take<T>(events: AsyncIterable<T>, count: number): Promise<T[]> {
  const collected = [];
  for await (const event of events) {
    collected.push(event);
    if (collected.length === count) {
      break;
    }
  }
  return collected;
}
