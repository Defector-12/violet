import { describe, expect, it } from "vitest";

import { DeterministicModelGateway } from "../model/deterministic-model-gateway.js";
import { ContextAssembler } from "./context-assembler.js";
import { ContextEpochManager } from "./context-epoch-manager.js";
import { InMemoryContextCheckpointRepository } from "./in-memory-context-checkpoint-repository.js";
import { InMemoryConversationLedger } from "./in-memory-conversation-ledger.js";
import { createPipelineContextAssembler } from "./pipeline-context.js";

const epoch = {
  id: "00000000-0000-4000-8000-000000000001",
  startedAt: new Date("2026-09-16T00:00:00.000Z"),
};

describe("createPipelineContextAssembler", () => {
  it("bounds history before the current user event when a later turn completes concurrently", async () => {
    const ledger = new InjectingLedger();
    await append(ledger, "prior", "user", "Prior question");
    await append(ledger, "prior", "assistant", "Prior answer");
    await append(ledger, "current", "user", "Current question");
    const assemble = createPipelineContextAssembler({
      contextAssembler: new ContextAssembler({
        checkpoints: new InMemoryContextCheckpointRepository(),
        ledger,
        model: new DeterministicModelGateway(),
      }),
      epochManager: new ContextEpochManager({ generateId: () => epoch.id }),
      generateId: () => "generated",
      ledger,
    });

    const messages = await assemble({
      additionalSystemInstructions: [],
      currentMessage: { content: "Current question", role: "user" },
      requestId: "current",
    });

    expect(messages.map((message) => message.content)).toEqual([
      expect.stringContaining("private AI assistant"),
      "Prior question",
      "Prior answer",
      "Current question",
    ]);
  });

  it("persists an ASR final transcript before assembling its point-in-time context", async () => {
    const ledger = new InMemoryConversationLedger();
    const assemble = createPipelineContextAssembler({
      contextAssembler: new ContextAssembler({
        checkpoints: new InMemoryContextCheckpointRepository(),
        ledger,
        model: new DeterministicModelGateway(),
      }),
      epochManager: new ContextEpochManager({ generateId: () => epoch.id }),
      generateId: () => "current-user",
      ledger,
      now: () => epoch.startedAt,
    });

    const messages = await assemble({
      additionalSystemInstructions: [],
      currentMessage: { content: "Final transcript", role: "user" },
      requestId: "current",
    });

    expect(messages.at(-1)).toEqual({ content: "Final transcript", role: "user" });
    await expect(ledger.findByRequest("current", "user")).resolves.toMatchObject({
      contextEpochId: epoch.id,
      sequence: 1,
    });
  });
});

class InjectingLedger extends InMemoryConversationLedger {
  #injected = false;

  override async findByRequest(requestId: string, role: "assistant" | "user") {
    const message = await super.findByRequest(requestId, role);
    if (requestId === "current" && role === "user" && !this.#injected) {
      this.#injected = true;
      await append(this, "future", "user", "Future question");
      await append(this, "future", "assistant", "Future answer");
    }
    return message;
  }
}

async function append(
  ledger: InMemoryConversationLedger,
  requestId: string,
  role: "assistant" | "user",
  content: string,
): Promise<void> {
  await ledger.append({
    content,
    contextEpoch: epoch,
    id: `${requestId}-${role}`,
    occurredAt: epoch.startedAt,
    requestId,
    role,
  });
}
