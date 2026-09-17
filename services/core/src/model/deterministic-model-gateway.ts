import type { ModelGateway, ModelRequest, ModelStreamEvent } from "@violet/domain";
import { deterministicContextProfile } from "./model-context.js";

export class DeterministicModelGateway implements ModelGateway {
  readonly contextProfile = deterministicContextProfile;

  async *stream(request: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelStreamEvent> {
    signal?.throwIfAborted();
    const lastUserMessage = request.messages.findLast((message) => message.role === "user");
    const content = lastUserMessage?.content ?? "";
    const response = `Violet test response: ${content}`;

    yield { content: response, type: "delta" };
    yield {
      inputTokens: Math.max(1, Math.ceil(content.length / 4)),
      outputTokens: Math.max(1, Math.ceil(response.length / 4)),
      type: "complete",
    };
  }
}
