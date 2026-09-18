import type {
  RealtimeConversation,
  RealtimeConversationInput,
  RealtimeConversationOutput,
  RealtimeConversationPort,
  RealtimeSessionConfiguration,
} from "@violet/domain";
import { deterministicContextProfile } from "../model/model-context.js";
import { AsyncQueue } from "./async-queue.js";

export interface DeterministicRealtimeConversationPortOptions {
  readonly generateId: () => string;
}

export class DeterministicRealtimeConversationPort implements RealtimeConversationPort {
  readonly contextProfile = deterministicContextProfile;
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
    turnDetection: "manual" as const,
    voiceKind: "none" as const,
  };
  readonly #generateId: () => string;
  readonly #outputQueue = new AsyncQueue<RealtimeConversationOutput>();

  constructor(generateId: () => string) {
    this.#generateId = generateId;
  }

  async close(): Promise<void> {
    this.#outputQueue.close();
  }

  async *outputs(signal?: AbortSignal): AsyncIterable<RealtimeConversationOutput> {
    while (true) {
      const output = await this.#outputQueue.next(signal);
      if (!output) {
        return;
      }
      yield output;
    }
  }

  async send(input: RealtimeConversationInput, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      return;
    }

    if (input.type === "cancel") {
      this.#outputQueue.push({
        responseId: input.responseId,
        type: "response-cancelled",
      });
      return;
    }

    if (input.type !== "text") {
      this.#outputQueue.push({
        code: "UNSUPPORTED_REALTIME_INPUT",
        message: "The deterministic realtime adapter accepts text input only",
        retryable: false,
        ...("turnId" in input ? { turnId: input.turnId } : {}),
        type: "error",
      });
      return;
    }

    const responseId = this.#generateId();
    this.#outputQueue.push({
      responseId,
      turnId: input.turnId,
      type: "response-started",
    });
    this.#outputQueue.push({
      responseId,
      text: `Violet realtime test response: ${input.text}`,
      turnId: input.turnId,
      type: "response-text",
    });
    this.#outputQueue.push({
      inputTokens: input.text.length,
      outputTokens: input.text.length + 31,
      responseId,
      turnId: input.turnId,
      type: "response-completed",
    });
  }
}
