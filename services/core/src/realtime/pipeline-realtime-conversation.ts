import type {
  ModelGateway,
  ModelMessage,
  RealtimeCapabilities,
  RealtimeConversation,
  RealtimeConversationInput,
  RealtimeConversationOutput,
  RealtimeConversationPort,
  RealtimeSessionConfiguration,
} from "@violet/domain";
import WebSocket, { type RawData } from "ws";

const inputAudio = {
  channels: 1,
  encoding: "pcm_s16le",
  sampleRate: 16000,
} as const;
const outputAudio = {
  channels: 1,
  encoding: "pcm_s16le",
  sampleRate: 24000,
} as const;
const defaultInstructions =
  "You are Violet, the user's private AI assistant. Reply naturally and concisely in the user's language. Never claim an action completed without a Core-confirmed tool result.";
const maximumHistoryMessages = 40;

export type DashScopeRealtimeMessage =
  | {
      readonly data: Uint8Array;
      readonly type: "binary";
    }
  | {
      readonly type: "json";
      readonly value: unknown;
    };

export interface DashScopeRealtimeTransport {
  close(): void;
  connect(signal?: AbortSignal): Promise<void>;
  receive(signal?: AbortSignal): Promise<DashScopeRealtimeMessage>;
  sendBinary(data: Uint8Array): Promise<void>;
  sendJson(event: Readonly<Record<string, unknown>>): Promise<void>;
}

export type DashScopeRealtimeTransportFactory = (
  url: URL,
  headers: Readonly<Record<string, string>>,
) => DashScopeRealtimeTransport;

export interface PipelineRealtimeConversationPortOptions {
  readonly apiKey: string;
  readonly asrModel: string;
  readonly connectTimeoutMs?: number;
  readonly createAsrTransport?: DashScopeRealtimeTransportFactory;
  readonly createTtsTransport?: DashScopeRealtimeTransportFactory;
  readonly generateId: () => string;
  readonly modelGateway: ModelGateway;
  readonly ttsModel: string;
  readonly voice: string;
  readonly workspaceId: string;
}

export class PipelineRealtimeConversationPort implements RealtimeConversationPort {
  readonly #apiKey: string;
  readonly #asrModel: string;
  readonly #connectTimeoutMs: number;
  readonly #createAsrTransport: DashScopeRealtimeTransportFactory;
  readonly #createTtsTransport: DashScopeRealtimeTransportFactory;
  readonly #generateId: () => string;
  readonly #modelGateway: ModelGateway;
  readonly #ttsModel: string;
  readonly #voice: string;
  readonly #workspaceId: string;

  constructor(options: PipelineRealtimeConversationPortOptions) {
    this.#apiKey = required(options.apiKey, "DashScope API key");
    this.#asrModel = required(options.asrModel, "Pipeline ASR model");
    this.#connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
    this.#createAsrTransport = options.createAsrTransport ?? createWebSocketTransport;
    this.#createTtsTransport = options.createTtsTransport ?? createWebSocketTransport;
    this.#generateId = options.generateId;
    this.#modelGateway = options.modelGateway;
    this.#ttsModel = required(options.ttsModel, "Pipeline TTS model");
    this.#voice = required(options.voice, "Pipeline TTS voice");
    this.#workspaceId = required(options.workspaceId, "DashScope workspace ID");
  }

  async open(
    configuration: RealtimeSessionConfiguration,
    signal?: AbortSignal,
  ): Promise<RealtimeConversation> {
    validateConfiguration(configuration, this.#voice);
    const transport = this.#createAsrTransport(
      dashScopeRealtimeUrl(this.#workspaceId),
      dashScopeHeaders(this.#apiKey, this.#workspaceId),
    );
    const taskId = this.#generateId();
    const setup = createTimeoutSignal(signal, this.#connectTimeoutMs);

    try {
      await transport.connect(setup.signal);
      await transport.sendJson(asrRunTask(taskId, this.#asrModel));
      await waitForJsonEvent(transport, "task-started", taskId, setup.signal);
      return new PipelineRealtimeConversation({
        apiKey: this.#apiKey,
        asrTaskId: taskId,
        asrTransport: transport,
        connectTimeoutMs: this.#connectTimeoutMs,
        createTtsTransport: this.#createTtsTransport,
        generateId: this.#generateId,
        history: configuration.history ?? [],
        modelGateway: this.#modelGateway,
        ttsModel: this.#ttsModel,
        voice: this.#voice,
        workspaceId: this.#workspaceId,
      });
    } catch (error) {
      transport.close();
      throw error;
    } finally {
      setup.dispose();
    }
  }
}

interface ActiveResponse {
  readonly controller: AbortController;
  readonly responseId: string;
  readonly turnId: string;
  ttsTaskId?: string;
  ttsTransport?: DashScopeRealtimeTransport;
}

interface StartedTts {
  readonly pump: Promise<TtsPumpResult>;
  readonly taskId: string;
  readonly transport: DashScopeRealtimeTransport;
}

type TtsPumpResult =
  | {
      readonly ok: true;
    }
  | {
      readonly error: unknown;
      readonly ok: false;
    };

interface PipelineRealtimeConversationOptions {
  readonly apiKey: string;
  readonly asrTaskId: string;
  readonly asrTransport: DashScopeRealtimeTransport;
  readonly connectTimeoutMs: number;
  readonly createTtsTransport: DashScopeRealtimeTransportFactory;
  readonly generateId: () => string;
  readonly history: readonly {
    readonly content: string;
    readonly role: "assistant" | "user";
  }[];
  readonly modelGateway: ModelGateway;
  readonly ttsModel: string;
  readonly voice: string;
  readonly workspaceId: string;
}

class PipelineRealtimeConversation implements RealtimeConversation {
  readonly capabilities: RealtimeCapabilities = {
    inputAudio,
    inputModalities: ["audio", "text"],
    interruption: true,
    outputAudio,
    outputModalities: ["audio", "text"],
    runtimeKind: "pipeline",
    transcription: true,
    turnDetection: "server_vad",
    voiceKind: "preset",
  };
  readonly #apiKey: string;
  readonly #asrTaskId: string;
  readonly #asrTransport: DashScopeRealtimeTransport;
  readonly #connectTimeoutMs: number;
  readonly #createTtsTransport: DashScopeRealtimeTransportFactory;
  readonly #generateId: () => string;
  readonly #history: ModelMessage[];
  readonly #modelGateway: ModelGateway;
  readonly #outputQueue = new AsyncOutputQueue<RealtimeConversationOutput>();
  readonly #ttsModel: string;
  readonly #voice: string;
  readonly #workspaceId: string;
  #activeResponse: ActiveResponse | null = null;
  #closed = false;
  #currentTurnId: string | null = null;

  constructor(options: PipelineRealtimeConversationOptions) {
    this.#apiKey = options.apiKey;
    this.#asrTaskId = options.asrTaskId;
    this.#asrTransport = options.asrTransport;
    this.#connectTimeoutMs = options.connectTimeoutMs;
    this.#createTtsTransport = options.createTtsTransport;
    this.#generateId = options.generateId;
    this.#history = options.history.map((message) => ({ ...message }));
    this.#modelGateway = options.modelGateway;
    this.#ttsModel = options.ttsModel;
    this.#voice = options.voice;
    this.#workspaceId = options.workspaceId;
    void this.#pumpAsr();
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    await this.#cancelActiveResponse(undefined, false);
    try {
      await this.#asrTransport.sendJson(finishTask(this.#asrTaskId));
    } catch {
      // The ASR connection may already be closed after a provider failure.
    }
    this.#asrTransport.close();
    this.#outputQueue.close();
  }

  async *outputs(signal?: AbortSignal): AsyncIterable<RealtimeConversationOutput> {
    while (!this.#closed) {
      const output = await this.#outputQueue.next(signal);
      if (!output) {
        return;
      }
      yield output;
    }
  }

  async send(input: RealtimeConversationInput, signal?: AbortSignal): Promise<void> {
    if (this.#closed) {
      throw new PipelineAdapterError("PIPELINE_CLOSED", "The realtime pipeline is closed", false);
    }
    signal?.throwIfAborted();

    switch (input.type) {
      case "audio":
        if (input.audio.length === 0) {
          throw new PipelineAdapterError(
            "INVALID_AUDIO_FRAME",
            "Realtime audio frames must not be empty",
            false,
          );
        }
        await this.#asrTransport.sendBinary(input.audio);
        break;
      case "cancel":
        await this.#cancelActiveResponse(input.responseId);
        break;
      case "commit":
        throw new PipelineAdapterError(
          "AUTOMATIC_TURN_DETECTION",
          "The realtime pipeline uses server-side turn detection",
          false,
        );
      case "text":
        this.#appendHistory({ content: input.text, role: "user" });
        await this.#startResponse(input.turnId);
        break;
    }
  }

  async #pumpAsr(): Promise<void> {
    try {
      while (!this.#closed) {
        const message = await this.#asrTransport.receive();
        if (message.type === "binary") {
          throw new PipelineAdapterError(
            "INVALID_ASR_EVENT",
            "Paraformer returned unexpected binary output",
            false,
          );
        }
        await this.#handleAsrEvent(providerEvent(message.value));
      }
    } catch (error) {
      if (!this.#closed) {
        this.#outputQueue.push(pipelineErrorOutput(error, "ASR"));
      }
    }
  }

  async #handleAsrEvent(event: Readonly<Record<string, unknown>>): Promise<void> {
    const name = eventName(event);
    if (name === "task-failed") {
      throw providerTaskError(event, "PARAFORMER");
    }
    if (name !== "result-generated") {
      return;
    }

    const payload = record(event["payload"]);
    const output = record(payload?.["output"]);
    const sentence = record(output?.["sentence"]);
    if (!sentence || sentence["heartbeat"] === true) {
      return;
    }
    const text = stringValue(sentence["text"]) ?? "";
    const final = sentence["sentence_end"] === true;
    if (!text && !final) {
      return;
    }

    const turnId = this.#currentTurnId ?? this.#startSpeechTurn();
    if (final) {
      this.#outputQueue.push({ turnId, type: "speech-stopped" });
    }
    if (text) {
      this.#outputQueue.push({
        final,
        text,
        turnId,
        type: "transcript",
      });
    }
    if (!final) {
      return;
    }

    this.#currentTurnId = null;
    if (text.trim()) {
      this.#appendHistory({ content: text, role: "user" });
      await this.#startResponse(turnId);
    }
  }

  #startSpeechTurn(): string {
    const turnId = this.#generateId();
    this.#currentTurnId = turnId;
    this.#outputQueue.push({ turnId, type: "speech-started" });
    void this.#cancelActiveResponse();
    return turnId;
  }

  async #startResponse(turnId: string): Promise<void> {
    await this.#cancelActiveResponse();
    if (this.#closed) {
      return;
    }

    const response: ActiveResponse = {
      controller: new AbortController(),
      responseId: this.#generateId(),
      turnId,
    };
    this.#activeResponse = response;
    this.#outputQueue.push({
      responseId: response.responseId,
      turnId,
      type: "response-started",
    });
    void this.#runResponse(response);
  }

  async #runResponse(response: ActiveResponse): Promise<void> {
    let assistantText = "";
    let inputTokens = 0;
    let outputTokens = 0;
    let tts: StartedTts | undefined;

    try {
      const messages = [
        { content: defaultInstructions, role: "system" as const },
        ...this.#history,
      ];
      for await (const event of this.#modelGateway.stream(
        {
          messages,
          requestId: response.turnId,
        },
        response.controller.signal,
      )) {
        response.controller.signal.throwIfAborted();
        if (event.type === "complete") {
          inputTokens = event.inputTokens;
          outputTokens = event.outputTokens;
          continue;
        }

        assistantText += event.content;
        this.#outputQueue.push({
          responseId: response.responseId,
          text: event.content,
          turnId: response.turnId,
          type: "response-text",
        });
        if (!tts) {
          tts = await this.#startTts(response);
        }
        await tts.transport.sendJson(continueTask(tts.taskId, event.content));
      }

      response.controller.signal.throwIfAborted();
      if (tts) {
        await tts.transport.sendJson(finishTask(tts.taskId));
        const result = await tts.pump;
        if (!result.ok) {
          throw result.error;
        }
      }
      response.controller.signal.throwIfAborted();
      if (this.#activeResponse !== response) {
        return;
      }

      if (assistantText) {
        this.#appendHistory({
          content: assistantText,
          role: "assistant",
        });
      }
      this.#activeResponse = null;
      this.#outputQueue.push({
        inputTokens,
        outputTokens,
        responseId: response.responseId,
        turnId: response.turnId,
        type: "response-completed",
      });
    } catch (error) {
      if (!response.controller.signal.aborted && this.#activeResponse === response) {
        this.#activeResponse = null;
        this.#outputQueue.push(pipelineErrorOutput(error, "RESPONSE"));
      }
    } finally {
      response.ttsTransport?.close();
    }
  }

  async #startTts(response: ActiveResponse): Promise<StartedTts> {
    const transport = this.#createTtsTransport(
      dashScopeRealtimeUrl(this.#workspaceId),
      dashScopeHeaders(this.#apiKey, this.#workspaceId),
    );
    const taskId = this.#generateId();
    response.ttsTaskId = taskId;
    response.ttsTransport = transport;
    const setup = createTimeoutSignal(response.controller.signal, this.#connectTimeoutMs);

    try {
      await transport.connect(setup.signal);
      await transport.sendJson(ttsRunTask(taskId, this.#ttsModel, this.#voice));
      await waitForJsonEvent(transport, "task-started", taskId, setup.signal);
    } finally {
      setup.dispose();
    }
    return {
      pump: this.#pumpTts(response, transport, taskId).then(
        () => ({ ok: true }),
        (error: unknown) => ({ error, ok: false }),
      ),
      taskId,
      transport,
    };
  }

  async #pumpTts(
    response: ActiveResponse,
    transport: DashScopeRealtimeTransport,
    taskId: string,
  ): Promise<void> {
    while (!response.controller.signal.aborted) {
      const message = await transport.receive(response.controller.signal);
      if (message.type === "binary") {
        if (message.data.length > 0 && this.#activeResponse === response) {
          this.#outputQueue.push({
            audio: message.data,
            responseId: response.responseId,
            turnId: response.turnId,
            type: "response-audio",
          });
        }
        continue;
      }

      const event = providerEvent(message.value);
      const name = eventName(event);
      if (name === "task-failed") {
        throw providerTaskError(event, "COSYVOICE");
      }
      if (name === "task-finished" && taskIdOf(event) === taskId) {
        return;
      }
    }
  }

  async #cancelActiveResponse(expectedResponseId?: string, emit = true): Promise<void> {
    const response = this.#activeResponse;
    if (!response || (expectedResponseId && response.responseId !== expectedResponseId)) {
      return;
    }

    this.#activeResponse = null;
    response.controller.abort();
    if (response.ttsTransport && response.ttsTaskId) {
      try {
        await response.ttsTransport.sendJson(finishTask(response.ttsTaskId, true));
      } catch {
        // Closing the socket below is sufficient if cancellation cannot be sent.
      }
      response.ttsTransport.close();
    }
    if (emit) {
      this.#outputQueue.push({
        responseId: response.responseId,
        type: "response-cancelled",
      });
    }
  }

  #appendHistory(message: ModelMessage): void {
    this.#history.push(message);
    if (this.#history.length > maximumHistoryMessages) {
      this.#history.splice(0, this.#history.length - maximumHistoryMessages);
    }
  }
}

class WebSocketDashScopeTransport implements DashScopeRealtimeTransport {
  readonly #events = new AsyncOutputQueue<DashScopeRealtimeMessage>();
  readonly #socket: WebSocket;
  #closed = false;

  constructor(url: URL, headers: Readonly<Record<string, string>>) {
    this.#socket = new WebSocket(url, { headers });
    this.#socket.on("message", (data, isBinary) => {
      if (isBinary) {
        this.#events.push({
          data: binaryData(data),
          type: "binary",
        });
        return;
      }
      try {
        this.#events.push({
          type: "json",
          value: JSON.parse(data.toString()) as unknown,
        });
      } catch {
        this.#events.fail(new Error("DashScope returned invalid JSON"));
      }
    });
    this.#socket.on("error", (error) => {
      this.#events.fail(error);
    });
    this.#socket.once("close", (code, reason) => {
      if (!this.#closed) {
        this.#events.fail(
          new Error(`DashScope realtime connection closed (${code}: ${reason.toString()})`),
        );
      }
    });
  }

  async connect(signal?: AbortSignal): Promise<void> {
    if (this.#socket.readyState === WebSocket.OPEN) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const onClose = () => {
        cleanup();
        reject(new Error("DashScope realtime connection closed during setup"));
      };
      const onAbort = () => {
        cleanup();
        reject(abortReason(signal));
      };
      const cleanup = () => {
        this.#socket.off("open", onOpen);
        this.#socket.off("error", onError);
        this.#socket.off("close", onClose);
        signal?.removeEventListener("abort", onAbort);
      };

      this.#socket.once("open", onOpen);
      this.#socket.once("error", onError);
      this.#socket.once("close", onClose);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
      }
    });
  }

  receive(signal?: AbortSignal): Promise<DashScopeRealtimeMessage> {
    return this.#events.nextRequired(signal);
  }

  async sendBinary(data: Uint8Array): Promise<void> {
    await this.#send(data);
  }

  async sendJson(event: Readonly<Record<string, unknown>>): Promise<void> {
    await this.#send(JSON.stringify(event));
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#events.close();
    if (
      this.#socket.readyState === WebSocket.OPEN ||
      this.#socket.readyState === WebSocket.CONNECTING
    ) {
      this.#socket.close(1000, "SESSION_CLOSED");
    }
  }

  async #send(data: string | Uint8Array): Promise<void> {
    if (this.#socket.readyState !== WebSocket.OPEN) {
      throw new Error("DashScope realtime connection is not open");
    }
    await new Promise<void>((resolve, reject) => {
      this.#socket.send(data, (error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }
}

class AsyncOutputQueue<T> {
  readonly #values: T[] = [];
  readonly #waiters: Array<{
    readonly reject: (error: unknown) => void;
    readonly resolve: (value: T | undefined) => void;
  }> = [];
  #closed = false;
  #failure: unknown;

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) {
      waiter.resolve(undefined);
    }
  }

  fail(error: unknown): void {
    if (this.#failure || this.#closed) {
      return;
    }
    this.#failure = error;
    for (const waiter of this.#waiters.splice(0)) {
      waiter.reject(error);
    }
  }

  next(signal?: AbortSignal): Promise<T | undefined> {
    const value = this.#values.shift();
    if (value !== undefined) {
      return Promise.resolve(value);
    }
    if (this.#failure) {
      return Promise.reject(this.#failure);
    }
    if (this.#closed || signal?.aborted) {
      return Promise.resolve(undefined);
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        reject: (error: unknown) => {
          cleanup();
          reject(error);
        },
        resolve: (nextValue: T | undefined) => {
          cleanup();
          resolve(nextValue);
        },
      };
      const onAbort = () => {
        const index = this.#waiters.indexOf(waiter);
        if (index >= 0) {
          this.#waiters.splice(index, 1);
        }
        waiter.resolve(undefined);
      };
      const cleanup = () => {
        signal?.removeEventListener("abort", onAbort);
      };
      this.#waiters.push(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  async nextRequired(signal?: AbortSignal): Promise<T> {
    const value = await this.next(signal);
    if (value === undefined) {
      throw abortReason(signal);
    }
    return value;
  }

  push(value: T): void {
    if (this.#closed || this.#failure) {
      return;
    }
    const waiter = this.#waiters.shift();
    if (waiter) {
      waiter.resolve(value);
    } else {
      this.#values.push(value);
    }
  }
}

class PipelineAdapterError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable: boolean) {
    super(message);
    this.name = "PipelineAdapterError";
    this.code = code;
    this.retryable = retryable;
  }
}

function createWebSocketTransport(
  url: URL,
  headers: Readonly<Record<string, string>>,
): DashScopeRealtimeTransport {
  return new WebSocketDashScopeTransport(url, headers);
}

function dashScopeRealtimeUrl(workspaceId: string): URL {
  if (!/^ws-[a-z0-9]+$/.test(workspaceId)) {
    throw new Error("DashScope workspace ID must use the ws- identifier format");
  }
  return new URL(`wss://${workspaceId}.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference`);
}

function dashScopeHeaders(apiKey: string, workspaceId: string): Readonly<Record<string, string>> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "User-Agent": "violet-core/0.1",
    "X-DashScope-WorkSpace": workspaceId,
  };
}

function asrRunTask(taskId: string, model: string): Readonly<Record<string, unknown>> {
  return {
    header: {
      action: "run-task",
      streaming: "duplex",
      task_id: taskId,
    },
    payload: {
      function: "recognition",
      input: {},
      model,
      parameters: {
        format: "pcm",
        heartbeat: true,
        max_sentence_silence: 600,
        multi_threshold_mode_enabled: true,
        punctuation_prediction_enabled: true,
        sample_rate: inputAudio.sampleRate,
        semantic_punctuation_enabled: false,
      },
      task: "asr",
      task_group: "audio",
    },
  };
}

function ttsRunTask(
  taskId: string,
  model: string,
  voice: string,
): Readonly<Record<string, unknown>> {
  return {
    header: {
      action: "run-task",
      streaming: "duplex",
      task_id: taskId,
    },
    payload: {
      function: "SpeechSynthesizer",
      input: {},
      model,
      parameters: {
        format: "pcm",
        sample_rate: outputAudio.sampleRate,
        text_type: "PlainText",
        voice,
      },
      task: "tts",
      task_group: "audio",
    },
  };
}

function continueTask(taskId: string, text: string): Readonly<Record<string, unknown>> {
  return {
    header: {
      action: "continue-task",
      streaming: "duplex",
      task_id: taskId,
    },
    payload: {
      input: { text },
    },
  };
}

function finishTask(taskId: string, cancel = false): Readonly<Record<string, unknown>> {
  return {
    header: {
      action: "finish-task",
      streaming: "duplex",
      task_id: taskId,
    },
    payload: {
      input: cancel ? { directive: "cancel" } : {},
    },
  };
}

async function waitForJsonEvent(
  transport: DashScopeRealtimeTransport,
  expectedName: string,
  taskId: string,
  signal?: AbortSignal,
): Promise<void> {
  while (true) {
    const message = await transport.receive(signal);
    if (message.type === "binary") {
      continue;
    }
    const event = providerEvent(message.value);
    if (eventName(event) === "task-failed") {
      throw providerTaskError(event, "DASHSCOPE");
    }
    if (eventName(event) === expectedName && taskIdOf(event) === taskId) {
      return;
    }
  }
}

function providerEvent(value: unknown): Readonly<Record<string, unknown>> {
  const event = record(value);
  if (!event || !eventName(event)) {
    throw new PipelineAdapterError(
      "INVALID_PROVIDER_EVENT",
      "DashScope returned an invalid realtime event",
      false,
    );
  }
  return event;
}

function eventName(event: Readonly<Record<string, unknown>>): string | undefined {
  return stringValue(record(event["header"])?.["event"]);
}

function taskIdOf(event: Readonly<Record<string, unknown>>): string | undefined {
  return stringValue(record(event["header"])?.["task_id"]);
}

function providerTaskError(
  event: Readonly<Record<string, unknown>>,
  provider: string,
): PipelineAdapterError {
  const header = record(event["header"]);
  const code = normalizeErrorCode(stringValue(header?.["error_code"]) ?? "TASK_FAILED");
  return new PipelineAdapterError(
    `${provider}_${code}`,
    stringValue(header?.["error_message"]) ?? `${provider} could not complete the realtime task`,
    true,
  );
}

function pipelineErrorOutput(
  error: unknown,
  stage: string,
): Extract<RealtimeConversationOutput, { readonly type: "error" }> {
  if (error instanceof PipelineAdapterError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      type: "error",
    };
  }
  return {
    code: `PIPELINE_${stage}_FAILED`,
    message: `The realtime pipeline ${stage.toLowerCase()} stage failed`,
    retryable: true,
    type: "error",
  };
}

function validateConfiguration(
  configuration: RealtimeSessionConfiguration,
  configuredVoice: string,
): void {
  if (
    configuration.inputAudio &&
    (configuration.inputAudio.channels !== inputAudio.channels ||
      configuration.inputAudio.encoding !== inputAudio.encoding ||
      configuration.inputAudio.sampleRate !== inputAudio.sampleRate)
  ) {
    throw new Error("The realtime pipeline requires 16kHz 16-bit mono PCM input");
  }
  if (
    configuration.outputAudio &&
    (configuration.outputAudio.channels !== outputAudio.channels ||
      configuration.outputAudio.encoding !== outputAudio.encoding ||
      configuration.outputAudio.sampleRate !== outputAudio.sampleRate)
  ) {
    throw new Error("The realtime pipeline requires 24kHz 16-bit mono PCM output");
  }
  if (configuration.turnDetection === "manual") {
    throw new Error("The realtime pipeline requires server-side turn detection");
  }
  if (configuration.voice && configuration.voice !== configuredVoice) {
    throw new Error("The requested realtime voice is not configured");
  }
}

function binaryData(value: RawData): Uint8Array {
  if (Buffer.isBuffer(value)) {
    return Uint8Array.from(value);
  }
  if (Array.isArray(value)) {
    return Uint8Array.from(Buffer.concat(value));
  }
  return Uint8Array.from(Buffer.from(value));
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function normalizeErrorCode(value: string): string {
  const normalized = value
    .toUpperCase()
    .replaceAll(/[^A-Z0-9]+/g, "_")
    .replaceAll(/^_+|_+$/g, "");
  return normalized || "TASK_FAILED";
}

function required(value: string, label: string): string {
  const result = value.trim();
  if (!result) {
    throw new Error(`${label} is required`);
  }
  return result;
}

function abortReason(signal: AbortSignal | undefined): Error {
  return signal?.reason instanceof Error ? signal.reason : new Error("Operation aborted");
}

function createTimeoutSignal(
  parent: AbortSignal | undefined,
  timeoutMs: number,
): {
  readonly dispose: () => void;
  readonly signal: AbortSignal;
} {
  const controller = new AbortController();
  const onAbort = () => controller.abort(parent?.reason);
  const timeout = setTimeout(() => {
    controller.abort(new Error("Pipeline provider setup timed out"));
  }, timeoutMs);
  parent?.addEventListener("abort", onAbort, { once: true });
  if (parent?.aborted) {
    onAbort();
  }
  return {
    dispose: () => {
      clearTimeout(timeout);
      parent?.removeEventListener("abort", onAbort);
    },
    signal: controller.signal,
  };
}
