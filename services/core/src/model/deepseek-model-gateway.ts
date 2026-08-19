import type { ModelGateway, ModelRequest, ModelStreamEvent } from "@violet/domain";
import OpenAI from "openai";
import type {
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions";

interface DeepSeekStreamingRequest extends ChatCompletionCreateParamsStreaming {
  readonly thinking: {
    readonly type: "enabled";
  };
  readonly user_id: string;
}

export class DeepSeekModelGateway implements ModelGateway {
  readonly #client: OpenAI;
  readonly #model: string;
  readonly #userId: string;

  constructor(input: {
    readonly apiKey: string;
    readonly baseUrl: string;
    readonly model: string;
    readonly userId: string;
  }) {
    this.#client = new OpenAI({
      apiKey: input.apiKey,
      baseURL: input.baseUrl,
      maxRetries: 2,
      timeout: 120_000,
    });
    this.#model = input.model;
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
      thinking: { type: "enabled" },
      user_id: this.#userId,
    };
    const stream = await this.#client.chat.completions.create(parameters, {
      ...(signal ? { signal } : {}),
    });

    let inputTokens = 0;
    let outputTokens = 0;
    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta.content;
      if (content) {
        yield { content, type: "delta" };
      }
      if (chunk.usage) {
        inputTokens = chunk.usage.prompt_tokens;
        outputTokens = chunk.usage.completion_tokens;
      }
    }

    yield {
      inputTokens,
      outputTokens,
      type: "complete",
    };
  }
}
