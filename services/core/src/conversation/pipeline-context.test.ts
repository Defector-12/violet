import { describe, expect, it } from "vitest";

import type { MemoryService } from "../memory/memory-service.js";
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

    const { messages } = await assemble({
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

    const { messages } = await assemble({
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

  it("does not clear a terminal marker after cancellation wins an assembly race", async () => {
    const ledger = new DelayedExistingLedger();
    await append(ledger, "current", "user", "Cancelled transcript");
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

    const assembling = assemble({
      additionalSystemInstructions: [],
      currentMessage: { content: "Cancelled transcript", role: "user" },
      requestId: "current",
    });
    await ledger.findStarted;
    await ledger.markRequestFailed("current", epoch.id, epoch.startedAt);
    ledger.releaseFind();
    await assembling;

    await expect(ledger.listTurns({ contextEpochId: epoch.id })).resolves.toMatchObject([
      { completed: false, failed: true, requestId: "current" },
    ]);
  });

  it("uses the persisted user content for an idempotent request", async () => {
    const ledger = new InMemoryConversationLedger();
    await append(ledger, "current", "user", "Original transcript");
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

    const { messages } = await assemble({
      additionalSystemInstructions: [],
      currentMessage: { content: "Changed retry", role: "user" },
      requestId: "current",
    });

    expect(messages.at(-1)).toEqual({ content: "Original transcript", role: "user" });
  });

  it("retains the memory revision of each assembled context", async () => {
    let revision = 7;
    let nextId = 0;
    const memory = {
      repository: { state: async () => ({ revision }) },
      async context() {
        return { revision, summary: "", excludedRequests: new Set<string>() };
      },
    } as unknown as MemoryService;
    const ledger = new InMemoryConversationLedger();
    const assemble = createPipelineContextAssembler({
      contextAssembler: new ContextAssembler({
        checkpoints: new InMemoryContextCheckpointRepository(),
        ledger,
        memoryService: memory,
        model: new DeterministicModelGateway(),
      }),
      epochManager: new ContextEpochManager({ generateId: () => epoch.id }),
      generateId: () => `generated-${nextId++}`,
      ledger,
      now: () => epoch.startedAt,
    });
    const first = await assemble({
      additionalSystemInstructions: [],
      currentMessage: { content: "First question", role: "user" },
      requestId: "first",
    });
    revision = 8;
    const second = await assemble({
      additionalSystemInstructions: [],
      currentMessage: { content: "Second question", role: "user" },
      requestId: "second",
    });
    expect(first.memoryRevision).toBe(7);
    expect(second.memoryRevision).toBe(8);
    expect(second.messages.at(-1)?.content).toBe("Second question");
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

class DelayedExistingLedger extends InMemoryConversationLedger {
  readonly findStarted: Promise<void>;
  #notifyFindStarted = () => {};
  #release = () => {};
  #waitForRelease: Promise<void>;

  constructor() {
    super();
    this.findStarted = new Promise((resolve) => {
      this.#notifyFindStarted = resolve;
    });
    this.#waitForRelease = new Promise((resolve) => {
      this.#release = resolve;
    });
  }

  override async findByRequest(requestId: string, role: "assistant" | "user") {
    const message = await super.findByRequest(requestId, role);
    if (requestId === "current" && role === "user") {
      this.#notifyFindStarted();
      await this.#waitForRelease;
    }
    return message;
  }

  releaseFind(): void {
    this.#release();
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
