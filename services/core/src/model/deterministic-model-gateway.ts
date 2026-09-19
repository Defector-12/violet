import type { ModelGateway, ModelRequest, ModelStreamEvent } from "@violet/domain";
import { deterministicContextProfile } from "./model-context.js";

export class DeterministicModelGateway implements ModelGateway {
  readonly contextProfile = deterministicContextProfile;

  async *stream(request: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelStreamEvent> {
    signal?.throwIfAborted();
    const lastUserMessage = request.messages.findLast((message) => message.role === "user");
    const content = lastUserMessage?.content ?? "";
    const response = boundOutput(`Violet test response: ${content}`, request.maximumOutputTokens);

    if (response) {
      yield { content: response, type: "delta" };
    }
    yield {
      inputTokens: Math.max(1, Math.ceil(content.length / 4)),
      outputTokens: Math.ceil(Array.from(response).length / 4),
      type: "complete",
    };
  }
}

function boundOutput(content: string, maximumOutputTokens: number | undefined): string {
  if (maximumOutputTokens === undefined) {
    return content;
  }
  return Array.from(content)
    .slice(0, Math.max(0, maximumOutputTokens) * 4)
    .join("");
}
