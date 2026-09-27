import type { ModelGateway, ModelRequest, ModelStreamEvent, ModelToolCall } from "@violet/domain";
import OpenAI from "openai";
import type {
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions";
import { recordTestTrace } from "../realtime/test-trace.js";
import { deepSeekV41ContextProfile } from "./model-context.js";

interface DeepSeekStreamingRequest extends ChatCompletionCreateParamsStreaming {
  readonly thinking?: {
    readonly type: "disabled" | "enabled";
  };
  readonly user_id: string;
}

export class DeepSeekModelGateway implements ModelGateway {
  readonly contextProfile = deepSeekV41ContextProfile;
  readonly #client: OpenAI;
  readonly #model: string;
  readonly #thinking: boolean;
  readonly #userId: string;

  constructor(input: {
    readonly apiKey: string;
    readonly baseUrl: string;
    readonly fetch?: typeof fetch;
    readonly model: string;
    readonly thinking?: boolean;
    readonly userId: string;
  }) {
    this.#client = new OpenAI({
      apiKey: input.apiKey,
      baseURL: input.baseUrl,
      ...(input.fetch ? { fetch: input.fetch } : {}),
      maxRetries: 2,
      timeout: 120_000,
    });
    this.#model = input.model;
    this.#thinking = input.thinking ?? true;
    this.#userId = input.userId;
  }

  async *stream(request: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelStreamEvent> {
    const thinking = request.thinking ?? this.#thinking;
    const parameters: DeepSeekStreamingRequest = {
      messages: request.messages.map((message): ChatCompletionMessageParam => {
        if (message.role === "tool") {
          if (!message.toolCallId) throw new Error("Tool result requires a call ID");
          return { role: "tool", content: message.content, tool_call_id: message.toolCallId };
        }
        if (message.role === "assistant" && message.toolCalls) {
          return {
            role: "assistant",
            content: message.content || null,
            tool_calls: message.toolCalls.map((call) => ({
              id: call.id,
              type: "function",
              function: { name: call.name, arguments: call.arguments },
            })),
          };
        }
        return { content: message.content, role: message.role };
      }),
      model: this.#model,
      ...(request.jsonOutput ? { response_format: { type: "json_object" as const } } : {}),
      ...(request.tools?.length
        ? { tools: request.tools.map((tool) => ({ type: "function" as const, function: tool })) }
        : {}),
      ...(request.maximumOutputTokens ? { max_tokens: request.maximumOutputTokens } : {}),
      stream: true,
      stream_options: { include_usage: true },
      thinking: { type: thinking ? "enabled" : "disabled" },
      user_id: this.#userId,
    };
    recordTestTrace("model.send", {
      requestId: request.requestId,
      model: this.#model,
      system: parameters.messages.filter((message) => message.role === "system"),
      currentMessage: parameters.messages.at(-1),
      preexistingMessages: Math.max(0, parameters.messages.length - 1),
      thinking,
      maximumOutputTokens: request.maximumOutputTokens,
    });
    let inputTokens = 0;
    let outputTokens = 0;
    let answer = "";
    let finishReason: string | null = null;
    const calls = new Map<number, { id: string; name: string; arguments: string }>();
    try {
      const stream = await this.#client.chat.completions.create(parameters, {
        ...(signal ? { signal } : {}),
      });
      for await (const chunk of stream) {
        const choice = chunk.choices[0];
        for (const delta of choice?.delta.tool_calls ?? []) {
          const call = calls.get(delta.index) ?? { id: "", name: "", arguments: "" };
          call.id += delta.id ?? "";
          call.name += delta.function?.name ?? "";
          call.arguments += delta.function?.arguments ?? "";
          if (call.arguments.length > 16_384 || calls.size > 4) {
            throw new Error("Model tool request exceeded its bound");
          }
          calls.set(delta.index, call);
        }
        const content = choice?.delta.content;
        if (content) {
          answer += content;
          yield { content, type: "delta" };
        }
        if (choice?.finish_reason) {
          finishReason = choice.finish_reason;
        }
        if (chunk.usage) {
          inputTokens = chunk.usage.prompt_tokens;
          outputTokens = chunk.usage.completion_tokens;
        }
      }
      if (
        finishReason !== "stop" &&
        !(finishReason === "tool_calls" && calls.size > 0 && request.tools?.length)
      ) {
        throw new Error(
          `DeepSeek response did not complete normally (finish_reason=${finishReason ?? "missing"})`,
        );
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

    const toolCalls: ModelToolCall[] = [...calls.values()];
    if (toolCalls.some((call) => !call.id || !call.name || !call.arguments)) {
      throw new Error("Model returned an incomplete tool call");
    }
    yield {
      inputTokens,
      outputTokens,
      type: "complete",
      ...(toolCalls.length ? { toolCalls } : {}),
    };
  }
}
