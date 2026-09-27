import type { ModelGateway, ModelMessage, ModelRequest, ModelStreamEvent } from "@violet/domain";
import { deterministicContextProfile } from "../model/model-context.js";
import { parseRecallQuery, recallMemoryTool } from "./memory-search.js";
import type { MemoryService } from "./memory-service.js";

// One bounded tool loop shared by the existing text and Pipeline runtime.
export async function* streamWithRecall(
  model: ModelGateway,
  request: ModelRequest,
  memory: MemoryService | undefined,
  history: boolean,
  signal?: AbortSignal,
): AsyncIterable<ModelStreamEvent> {
  if (!memory || memory.injectionEnabled === false) {
    yield* model.stream(request, signal);
    return;
  }
  const messages: ModelMessage[] = [...request.messages];
  if (history) {
    messages.unshift({
      role: "system",
      content:
        "Core identified this turn as a request for prior context. Call recall_memory before answering or asking the user to repeat details. Use the shortest distinctive topic (usually one noun or noun phrase); omit words describing the unknown answer and do not invent synonyms. The archive may contain the answer even though this conversation does not.",
    });
  }
  let inputTokens = 0;
  let outputTokens = 0;
  // Up to three searches, followed by one answer-only round.
  for (let round = 0; round < 4; round++) {
    const profile = model.contextProfile ?? deterministicContextProfile;
    const requestSize = profile.estimateTokens([
      ...messages,
      { role: "system", content: JSON.stringify(recallMemoryTool) },
    ]);
    if (
      requestSize + (request.maximumOutputTokens ?? profile.maximumOutputTokens ?? 16_384) + 4_096 >
      profile.contextWindowTokens
    ) {
      throw new Error("Recall results exceed the model context budget");
    }
    let text = "";
    let completed = false;
    for await (const event of model.stream(
      {
        ...request,
        messages,
        ...(round < 3 ? { tools: [recallMemoryTool] } : { tools: [] }),
        thinking: false,
      },
      signal,
    )) {
      signal?.throwIfAborted();
      if (event.type === "delta") {
        text += event.content;
        continue;
      }
      completed = true;
      inputTokens += event.inputTokens;
      outputTokens += event.outputTokens;
      if (!event.toolCalls?.length) {
        if (text) yield { type: "delta", content: text };
        yield { type: "complete", inputTokens, outputTokens };
        return;
      }
      if (round === 3 || event.toolCalls.length > 4) throw new Error("Too many recall calls");
      messages.push({ role: "assistant", content: text, toolCalls: event.toolCalls });
      for (const call of event.toolCalls) {
        if (call.name !== recallMemoryTool.name) throw new Error("Unknown model tool");
        const result = await memory.recall(parseRecallQuery(call.arguments), history, signal);
        messages.push({
          role: "tool",
          toolCallId: call.id,
          content: JSON.stringify({
            ...result,
            ...(result.status === "not_found"
              ? {
                  searchNote:
                    "Every query word must occur literally. Retry using just the distinctive subject from the question, omitting the unknown detail (such as material, place, or name). Keep the subject; do not substitute a generic word or guess the answer.",
                }
              : {}),
          }),
        });
      }
    }
    if (!completed) throw new Error("Model response did not complete");
  }
  throw new Error("Recall tool round limit reached");
}

export async function* confirmedMemoryReply(content: string): AsyncIterable<ModelStreamEvent> {
  yield { type: "delta", content };
  yield { type: "complete", inputTokens: 0, outputTokens: 0 };
}
