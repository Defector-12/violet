import type { ModelGateway, ModelRequest, ModelStreamEvent } from "@violet/domain";
import { describe, expect, it } from "vitest";

import {
  type DashScopeRealtimeMessage,
  type DashScopeRealtimeTransport,
  PipelineRealtimeConversationPort,
} from "./pipeline-realtime-conversation.js";

describe("PipelineRealtimeConversationPort", () => {
  it("opens Paraformer on the Beijing workspace endpoint", async () => {
    const asr = new FakeTransport([jsonEvent("task-started", "asr-task")]);
    let observedUrl: URL | undefined;
    let observedHeaders: Readonly<Record<string, string>> | undefined;
    const port = new PipelineRealtimeConversationPort({
      apiKey: "test-dashscope-key",
      asrModel: "paraformer-realtime-v2",
      createAsrTransport: (url, headers) => {
        observedUrl = url;
        observedHeaders = headers;
        return asr;
      },
      createTtsTransport: () => new FakeTransport([]),
      generateId: () => "asr-task",
      modelGateway: new StreamingModelGateway(),
      ttsModel: "cosyvoice-v3-flash",
      voice: "longanyang",
      workspaceId: "ws-testworkspace",
    });

    const conversation = await port.open(configuration());

    expect(observedUrl?.toString()).toBe(
      "wss://ws-testworkspace.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference",
    );
    expect(observedHeaders).toEqual({
      Authorization: "Bearer test-dashscope-key",
      "User-Agent": "violet-core/0.1",
      "X-DashScope-WorkSpace": "ws-testworkspace",
    });
    expect(asr.sentJson[0]).toMatchObject({
      header: {
        action: "run-task",
        streaming: "duplex",
        task_id: "asr-task",
      },
      payload: {
        function: "recognition",
        model: "paraformer-realtime-v2",
        parameters: {
          format: "pcm",
          heartbeat: true,
          max_sentence_silence: 600,
          sample_rate: 16000,
        },
        task: "asr",
      },
    });
    expect(conversation.capabilities).toEqual({
      inputAudio: {
        channels: 1,
        encoding: "pcm_s16le",
        sampleRate: 16000,
      },
      inputModalities: ["audio", "text"],
      interruption: true,
      outputAudio: {
        channels: 1,
        encoding: "pcm_s16le",
        sampleRate: 24000,
      },
      outputModalities: ["audio", "text"],
      runtimeKind: "pipeline",
      transcription: true,
      turnDetection: "server_vad",
      voiceKind: "preset",
    });

    await conversation.close();
  });

  it("streams Paraformer through DeepSeek and CosyVoice", async () => {
    const asr = new FakeTransport([jsonEvent("task-started", "asr-task")]);
    const tts = new FakeTransport([
      jsonEvent("task-started", "tts-task"),
      {
        data: Uint8Array.from([1, 2, 3, 4]),
        type: "binary",
      },
      jsonEvent("task-finished", "tts-task"),
    ]);
    const model = new StreamingModelGateway();
    const generatedIds = ["asr-task", "turn-1", "response-1", "tts-task"];
    const port = new PipelineRealtimeConversationPort({
      apiKey: "test-dashscope-key",
      asrModel: "paraformer-realtime-v2",
      createAsrTransport: () => asr,
      createTtsTransport: () => tts,
      generateId: () => generatedIds.shift() ?? "unexpected-id",
      modelGateway: model,
      ttsModel: "cosyvoice-v3-flash",
      voice: "longanyang",
      workspaceId: "ws-testworkspace",
    });
    const conversation = await port.open({
      ...configuration(),
      history: [
        { content: "Earlier question", role: "user" },
        { content: "Earlier answer", role: "assistant" },
      ],
    });
    const outputPromise = take(conversation.outputs(), 8);

    await conversation.send({
      audio: Uint8Array.from([9, 8, 7, 6]),
      turnId: "continuous-stream",
      type: "audio",
    });
    asr.push(asrResult("Hello Vio", false));
    asr.push(asrResult("Hello Violet", true));
    const output = await outputPromise;

    expect(asr.sentBinary).toEqual([Uint8Array.from([9, 8, 7, 6])]);
    expect(output).toEqual([
      { turnId: "turn-1", type: "speech-started" },
      {
        final: false,
        text: "Hello Vio",
        turnId: "turn-1",
        type: "transcript",
      },
      { turnId: "turn-1", type: "speech-stopped" },
      {
        final: true,
        text: "Hello Violet",
        turnId: "turn-1",
        type: "transcript",
      },
      {
        responseId: "response-1",
        turnId: "turn-1",
        type: "response-started",
      },
      {
        responseId: "response-1",
        text: "Hello from Violet.",
        turnId: "turn-1",
        type: "response-text",
      },
      {
        audio: Uint8Array.from([1, 2, 3, 4]),
        responseId: "response-1",
        turnId: "turn-1",
        type: "response-audio",
      },
      {
        inputTokens: 14,
        outputTokens: 6,
        responseId: "response-1",
        turnId: "turn-1",
        type: "response-completed",
      },
    ]);
    expect(model.requests[0]?.messages.slice(-3)).toEqual([
      { content: "Earlier question", role: "user" },
      { content: "Earlier answer", role: "assistant" },
      { content: "Hello Violet", role: "user" },
    ]);
    expect(tts.sentJson.map(actionOf)).toEqual(["run-task", "continue-task", "finish-task"]);
    expect(tts.sentJson[0]).toMatchObject({
      payload: {
        model: "cosyvoice-v3-flash",
        parameters: {
          format: "pcm",
          sample_rate: 24000,
          voice: "longanyang",
        },
      },
    });

    await conversation.close();
  });

  it("cancels the active model and CosyVoice task", async () => {
    const asr = new FakeTransport([jsonEvent("task-started", "asr-task")]);
    const tts = new FakeTransport([jsonEvent("task-started", "tts-task")]);
    const model = new BlockingModelGateway();
    const generatedIds = ["asr-task", "response-1", "tts-task"];
    const port = new PipelineRealtimeConversationPort({
      apiKey: "test-dashscope-key",
      asrModel: "paraformer-realtime-v2",
      createAsrTransport: () => asr,
      createTtsTransport: () => tts,
      generateId: () => generatedIds.shift() ?? "unexpected-id",
      modelGateway: model,
      ttsModel: "cosyvoice-v3-flash",
      voice: "longanyang",
      workspaceId: "ws-testworkspace",
    });
    const conversation = await port.open(configuration());
    const iterator = conversation.outputs()[Symbol.asyncIterator]();

    await conversation.send({
      text: "Tell me a long story",
      turnId: "turn-1",
      type: "text",
    });
    expect((await iterator.next()).value).toMatchObject({
      responseId: "response-1",
      type: "response-started",
    });
    expect((await iterator.next()).value).toMatchObject({
      responseId: "response-1",
      type: "response-text",
    });
    await waitFor(() => tts.sentJson.some((event) => actionOf(event) === "run-task"));

    await conversation.send({
      responseId: "response-1",
      type: "cancel",
    });

    expect((await iterator.next()).value).toEqual({
      responseId: "response-1",
      type: "response-cancelled",
    });
    expect(tts.sentJson.at(-1)).toMatchObject({
      header: { action: "finish-task" },
      payload: { input: { directive: "cancel" } },
    });
    expect(model.aborted).toBe(true);

    await conversation.close();
  });
});

class StreamingModelGateway implements ModelGateway {
  readonly requests: ModelRequest[] = [];

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request);
    yield { content: "Hello from Violet.", type: "delta" };
    yield {
      inputTokens: 14,
      outputTokens: 6,
      type: "complete",
    };
  }
}

class BlockingModelGateway implements ModelGateway {
  aborted = false;

  async *stream(_request: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelStreamEvent> {
    yield { content: "A long answer begins.", type: "delta" };
    await new Promise<void>((resolve) => {
      const onAbort = () => {
        this.aborted = true;
        resolve();
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
      }
    });
  }
}

class FakeTransport implements DashScopeRealtimeTransport {
  readonly sentBinary: Uint8Array[] = [];
  readonly sentJson: Array<Readonly<Record<string, unknown>>> = [];
  readonly #messages: DashScopeRealtimeMessage[];
  readonly #waiters: Array<{
    readonly reject: (error: unknown) => void;
    readonly resolve: (message: DashScopeRealtimeMessage) => void;
  }> = [];
  closed = false;
  connected = false;

  constructor(messages: DashScopeRealtimeMessage[]) {
    this.#messages = [...messages];
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.#waiters.splice(0)) {
      waiter.reject(new Error("Fake transport closed"));
    }
  }

  async connect(): Promise<void> {
    this.connected = true;
  }

  push(message: DashScopeRealtimeMessage): void {
    const waiter = this.#waiters.shift();
    if (waiter) {
      waiter.resolve(message);
    } else {
      this.#messages.push(message);
    }
  }

  receive(signal?: AbortSignal): Promise<DashScopeRealtimeMessage> {
    const message = this.#messages.shift();
    if (message) {
      return Promise.resolve(message);
    }
    return new Promise((resolve, reject) => {
      const waiter = { reject, resolve };
      const onAbort = () => {
        const index = this.#waiters.indexOf(waiter);
        if (index >= 0) {
          this.#waiters.splice(index, 1);
        }
        reject(new Error("Fake transport aborted"));
      };
      this.#waiters.push(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  async sendBinary(data: Uint8Array): Promise<void> {
    this.sentBinary.push(data);
  }

  async sendJson(event: Readonly<Record<string, unknown>>): Promise<void> {
    this.sentJson.push(event);
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
    turnDetection: "smart_turn" as const,
  };
}

function jsonEvent(event: string, taskId: string): DashScopeRealtimeMessage {
  return {
    type: "json",
    value: {
      header: {
        event,
        task_id: taskId,
      },
      payload: {},
    },
  };
}

function asrResult(text: string, sentenceEnd: boolean): DashScopeRealtimeMessage {
  return {
    type: "json",
    value: {
      header: {
        event: "result-generated",
        task_id: "asr-task",
      },
      payload: {
        output: {
          sentence: {
            heartbeat: false,
            sentence_end: sentenceEnd,
            text,
          },
        },
      },
    },
  };
}

function actionOf(event: Readonly<Record<string, unknown>>): unknown {
  const header = event["header"] as Readonly<Record<string, unknown>> | undefined;
  return header?.["action"];
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

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
