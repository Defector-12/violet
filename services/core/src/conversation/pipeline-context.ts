import type { ConversationLedger } from "@violet/domain";
import { assertMemoryContentAllowed } from "@violet/policy";

import type { PipelineContextAssembler } from "../realtime/pipeline-realtime-conversation.js";
import type { ContextAssembler } from "./context-assembler.js";
import type { ContextEpochManager } from "./context-epoch-manager.js";

export function createPipelineContextAssembler(options: {
  readonly contextAssembler: ContextAssembler;
  readonly epochManager: ContextEpochManager;
  readonly generateId: () => string;
  readonly ledger: ConversationLedger;
  readonly now?: () => Date;
}): PipelineContextAssembler {
  const now = options.now ?? (() => new Date());
  return async (input, signal) => {
    assertMemoryContentAllowed(input.currentMessage.content);
    let userMessage = await options.ledger.findByRequest(input.requestId, "user");
    if (!userMessage) {
      const occurredAt = now();
      const contextEpoch = options.epochManager.acceptUserInput(occurredAt);
      userMessage = await options.ledger.append({
        content: input.currentMessage.content,
        contextEpoch,
        id: options.generateId(),
        occurredAt,
        requestId: input.requestId,
        role: "user",
      });
    }
    const assembled = await options.contextAssembler.assemble({
      additionalSystemInstructions: input.additionalSystemInstructions,
      beforeSequence: userMessage.sequence,
      ...(userMessage.contextEpochId ? { contextEpochId: userMessage.contextEpochId } : {}),
      currentMessage: {
        content: userMessage.content,
        role: "user",
      },
      ...(signal ? { signal } : {}),
    });
    return {
      messages: assembled.messages,
      ...(assembled.memoryRevision !== undefined
        ? { memoryRevision: assembled.memoryRevision }
        : {}),
    };
  };
}
