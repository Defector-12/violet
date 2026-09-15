import type { ModelGateway, ModelRequest, ModelStreamEvent } from "@violet/domain";
import OpenAI from "openai";
import type {
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions";
import { recordTestTrace } from "../realtime/test-trace.js";

interface DeepSeekStreamingRequest extends ChatCompletionCreateParamsStreaming {
  readonly thinking?: {
    readonly type: "enabled";
  };
  readonly user_id: string;
}

export class DeepSeekModelGateway implements ModelGateway {
  readonly #client: OpenAI;
  readonly #model: string;
  readonly #thinking: boolean;
  readonly #userId: string;

  constructor(input: {
    readonly apiKey: string;
    readonly baseUrl: string;
    readonly model: string;
    readonly thinking?: boolean;
    readonly userId: string;
  }) {
    this.#client = new OpenAI({
      apiKey: input.apiKey,
      baseURL: input.baseUrl,
      maxRetries: 2,
      timeout: 120_000,
    });
    this.#model = input.model;
    this.#thinking = input.thinking ?? true;
    this.#userId = input.userId;
  }

  async *stream(request: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelStreamEvent> {
    const parameters: DeepSeekStreamingRequest = {
      messages: request.messages.map(
        (message): ChatCompletionMessageParam => ({
          content: message.content,
          role: message.role,
        }),
      ),
      model: this.#model,
      stream: true,
      stream_options: { include_usage: true },
      ...(this.#thinking ? { thinking: { type: "enabled" as const } } : {}),
      user_id: this.#userId,
    };
    recordTestTrace("model.send", {
      requestId: request.requestId,
      model: this.#model,
      system: parameters.messages.filter((message) => message.role === "system"),
      currentMessage: parameters.messages.at(-1),
      preexistingMessages: Math.max(0, parameters.messages.length - 1),
      thinking: this.#thinking,
    });
    let inputTokens = 0;
    let outputTokens = 0;
    let answer = "";
    try {
      const stream = await this.#client.chat.completions.create(parameters, {
        ...(signal ? { signal } : {}),
      });
      for await (const chunk of stream) {
        const content = chunk.choices[0]?.delta.content;
        if (content) {
          answer += content;
          yield { content, type: "delta" };
        }
        if (chunk.usage) {
          inputTokens = chunk.usage.prompt_tokens;
          outputTokens = chunk.usage.completion_tokens;
        }
      }
    } catch (error) {
      recordTestTrace("model.failed", {
        requestId: request.requestId,
        error: error instanceof Error ? error.message : "unknown",
      });
      throw error;
    } finally {
      recordTestTrace("model.receive", {
        requestId: request.requestId,
        model: this.#model,
        text: answer,
        inputTokens,
        outputTokens,
        aborted: signal?.aborted ?? false,
      });
    }

    yield {
      inputTokens,
      outputTokens,
      type: "complete",
    };
  }
}
