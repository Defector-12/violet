import type {
  RealtimeConversation,
  RealtimeConversationInput,
  RealtimeConversationOutput,
  RealtimeConversationPort,
  RealtimeSessionConfiguration,
} from "@violet/domain";

export interface DeterministicRealtimeConversationPortOptions {
  readonly generateId: () => string;
}

export class DeterministicRealtimeConversationPort implements RealtimeConversationPort {
  readonly #generateId: () => string;

  constructor(options: DeterministicRealtimeConversationPortOptions) {
    this.#generateId = options.generateId;
  }

  async open(
    _configuration: RealtimeSessionConfiguration,
    _signal?: AbortSignal,
  ): Promise<RealtimeConversation> {
    return new DeterministicRealtimeConversation(this.#generateId);
  }
}

class DeterministicRealtimeConversation implements RealtimeConversation {
  readonly capabilities = {
    inputModalities: ["text"] as const,
    interruption: true,
    outputModalities: ["text"] as const,
    runtimeKind: "deterministic" as const,
    transcription: false,
    voiceKind: "none" as const,
  };
  readonly #generateId: () => string;

  constructor(generateId: () => string) {
    this.#generateId = generateId;
  }

  async close(): Promise<void> {}

  async *send(
    input: RealtimeConversationInput,
    signal?: AbortSignal,
  ): AsyncIterable<RealtimeConversationOutput> {
    if (signal?.aborted) {
      return;
    }

    if (input.type === "cancel") {
      yield {
        responseId: input.responseId,
        type: "response-cancelled",
      };
      return;
    }

    if (input.type !== "text") {
      yield {
        code: "UNSUPPORTED_REALTIME_INPUT",
        message: "The deterministic realtime adapter accepts text input only",
        retryable: false,
        type: "error",
      };
      return;
    }

    const responseId = this.#generateId();
    yield {
      responseId,
      turnId: input.turnId,
      type: "response-started",
    };
    yield {
      responseId,
      text: `Violet realtime test response: ${input.text}`,
      turnId: input.turnId,
      type: "response-text",
    };
    yield {
      inputTokens: input.text.length,
      outputTokens: input.text.length + 31,
      responseId,
      turnId: input.turnId,
      type: "response-completed",
    };
  }
}
