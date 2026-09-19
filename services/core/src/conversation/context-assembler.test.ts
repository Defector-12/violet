import type {
  ContextCheckpointRepository,
  ModelGateway,
  ModelMessage,
  ModelRequest,
} from "@violet/domain";
import { describe, expect, it } from "vitest";

import {
  boundUntrustedContext,
  ContextAssembler,
  ContextAssemblyError,
} from "./context-assembler.js";
import { InMemoryContextCheckpointRepository } from "./in-memory-context-checkpoint-repository.js";
import { InMemoryConversationLedger } from "./in-memory-conversation-ledger.js";

const epoch = {
  id: "00000000-0000-4000-8000-000000000001",
  startedAt: new Date("2026-09-16T00:00:00.000Z"),
};

describe("ContextAssembler", () => {
  it("orders system instructions, complete turns, and the current user message", async () => {
    const ledger = new InMemoryConversationLedger();
    await appendTurn(ledger, 1, "Earlier question", "Earlier answer");
    const assembler = new ContextAssembler({
      checkpoints: new InMemoryContextCheckpointRepository(),
      ledger,
      model: new CheckpointModel(),
    });

    const context = await assembler.assemble({
      additionalSystemInstructions: ["Safety instruction"],
      beforeSequence: 3,
      contextEpochId: epoch.id,
      currentMessage: { content: "Current question", role: "user" },
    });

    expect(context.messages.map((message) => message.role)).toEqual([
      "system",
      "system",
      "user",
      "assistant",
      "user",
    ]);
    expect(context.messages.map((message) => message.content)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("private AI assistant"),
        "Safety instruction",
        "Earlier question",
        "Earlier answer",
        "Current question",
      ]),
    );
  });

  it("compresses only complete oldest turns into one rolling checkpoint", async () => {
    const ledger = new InMemoryConversationLedger();
    await appendTurn(ledger, 1, "Question one", "Answer one");
    await appendTurn(ledger, 2, "Question two", "Answer two");
    const checkpoints = new InMemoryContextCheckpointRepository();
    const model = new CheckpointModel();
    const assembler = new ContextAssembler({
      checkpoints,
      ledger,
      model,
      now: () => new Date("2026-09-16T01:00:00.000Z"),
    });

    const context = await assembler.assemble({
      contextEpochId: epoch.id,
      maximumHistoryTurns: 1,
    });

    expect(model.requests).toHaveLength(1);
    expect(model.requests[0]?.maximumOutputTokens).toBe(1_024);
    expect(model.requests[0]?.thinking).toBe(false);
    expect(model.requests[0]?.messages[0]?.content).toContain("label it as correction provenance");
    expect(context.checkpoint).toMatchObject({
      content: "Bounded checkpoint.",
      contextEpochId: epoch.id,
      deletionRevision: 0,
      fromSequence: 1,
      throughSequence: 2,
    });
    expect(context.history.map((message) => message.content)).toEqual([
      expect.stringContaining("[UNTRUSTED CONVERSATION CHECKPOINT]"),
      "Question two",
      "Answer two",
    ]);
    expect(context.history[0]?.role).toBe("assistant");
    expect(context.systemInstructions).not.toContain("Bounded checkpoint.");
    await expect(checkpoints.get(epoch.id)).resolves.toMatchObject({
      content: "Bounded checkpoint.",
      throughSequence: 2,
    });
  });

  it("expands a checkpoint boundary so interleaved logical turns are never split", async () => {
    const ledger = new InMemoryConversationLedger();
    for (const [id, requestId, role, content] of [
      ["user-a", "request-a", "user", "Question A"],
      ["user-b", "request-b", "user", "Question B"],
      ["assistant-b", "request-b", "assistant", "Answer B"],
      ["assistant-a", "request-a", "assistant", "Answer A"],
    ] as const) {
      await ledger.append({
        content,
        contextEpoch: epoch,
        id,
        occurredAt: new Date(),
        requestId,
        role,
      });
    }
    const assembler = new ContextAssembler({
      checkpoints: new InMemoryContextCheckpointRepository(),
      ledger,
      model: new CheckpointModel(),
    });

    const context = await assembler.assemble({
      contextEpochId: epoch.id,
      maximumHistoryTurns: 1,
    });

    expect(context.checkpoint).toMatchObject({
      fromSequence: 1,
      throughSequence: 4,
    });
    expect(context.history).toMatchObject([
      {
        content: expect.stringContaining("Bounded checkpoint."),
        role: "assistant",
      },
    ]);
  });

  it("does not checkpoint past an older incomplete turn", async () => {
    const ledger = new InMemoryConversationLedger();
    await ledger.append({
      content: "Question A",
      contextEpoch: epoch,
      id: "user-a",
      occurredAt: new Date(),
      requestId: "request-a",
      role: "user",
    });
    await ledger.append({
      content: "Question B",
      contextEpoch: epoch,
      id: "user-b",
      occurredAt: new Date(),
      requestId: "request-b",
      role: "user",
    });
    await ledger.append({
      content: "Answer B",
      contextEpoch: epoch,
      id: "assistant-b",
      occurredAt: new Date(),
      requestId: "request-b",
      role: "assistant",
    });
    const checkpoints = new InMemoryContextCheckpointRepository();
    const model = new CheckpointModel();
    const assembler = new ContextAssembler({ checkpoints, ledger, model });

    await expect(
      assembler.assemble({
        contextEpochId: epoch.id,
        maximumHistoryTurns: 0,
      }),
    ).rejects.toBeInstanceOf(ContextAssemblyError);
    await expect(checkpoints.get(epoch.id)).resolves.toBeNull();
    expect(model.requests).toHaveLength(0);

    await ledger.append({
      content: "Answer A",
      contextEpoch: epoch,
      id: "assistant-a",
      occurredAt: new Date(),
      requestId: "request-a",
      role: "assistant",
    });
    const context = await assembler.assemble({
      contextEpochId: epoch.id,
      maximumHistoryTurns: 0,
    });
    expect(context.checkpoint).toMatchObject({
      fromSequence: 1,
      throughSequence: 4,
    });
  });

  it("checkpoints past a terminally failed turn without injecting it into history", async () => {
    const ledger = new InMemoryConversationLedger();
    await ledger.append({
      content: "Question that failed",
      contextEpoch: epoch,
      id: "failed-user",
      occurredAt: epoch.startedAt,
      requestId: "failed-request",
      role: "user",
    });
    await ledger.markRequestFailed("failed-request", epoch.id, epoch.startedAt);
    for (let index = 1; index <= 21; index += 1) {
      await appendTurn(ledger, index, `Question ${index}`, `Answer ${index}`);
    }
    const assembler = new ContextAssembler({
      checkpoints: new InMemoryContextCheckpointRepository(),
      ledger,
      model: new CheckpointModel(),
    });

    const context = await assembler.assemble({
      contextEpochId: epoch.id,
      maximumHistoryTurns: 20,
    });

    expect(context.checkpoint).toMatchObject({ throughSequence: 3 });
    expect(context.history.some((message) => message.content === "Question that failed")).toBe(
      false,
    );
    expect(context.history.at(-1)?.content).toBe("Answer 21");
  });

  it("rejects a checkpoint when a failed request is retried during save", async () => {
    const ledger = new InMemoryConversationLedger();
    await ledger.append({
      content: "Question that will be retried",
      contextEpoch: epoch,
      id: "failed-user",
      occurredAt: epoch.startedAt,
      requestId: "failed-request",
      role: "user",
    });
    await ledger.markRequestFailed("failed-request", epoch.id, epoch.startedAt);
    for (let index = 1; index <= 21; index += 1) {
      await appendTurn(ledger, index, `Question ${index}`, `Answer ${index}`);
    }
    const assembler = new ContextAssembler({
      checkpoints: new ReopeningCheckpointRepository(ledger, "failed-request"),
      ledger,
      model: new CheckpointModel(),
    });

    await expect(
      assembler.assemble({
        contextEpochId: epoch.id,
        maximumHistoryTurns: 20,
      }),
    ).rejects.toThrow("Conversation changed while the checkpoint was generated");
  });

  it("rejects a persisted checkpoint whose watermark splits a logical turn", async () => {
    const ledger = new InMemoryConversationLedger();
    for (const [id, requestId, role, content] of [
      ["user-a", "request-a", "user", "Question A"],
      ["user-b", "request-b", "user", "Question B"],
      ["assistant-b", "request-b", "assistant", "Answer B"],
      ["assistant-a", "request-a", "assistant", "Answer A"],
    ] as const) {
      await ledger.append({
        content,
        contextEpoch: epoch,
        id,
        occurredAt: new Date(),
        requestId,
        role,
      });
    }
    const checkpoints = new InMemoryContextCheckpointRepository();
    await checkpoints.save({
      content: "Unsafe checkpoint",
      contextEpochId: epoch.id,
      deletionRevision: 0,
      fromSequence: 2,
      throughSequence: 3,
      updatedAt: new Date(),
    });
    const assembler = new ContextAssembler({
      checkpoints,
      ledger,
      model: new CheckpointModel(),
    });

    const context = await assembler.assemble({ contextEpochId: epoch.id });

    expect(context.checkpoint).toBeNull();
    expect(context.history.map((message) => message.content)).toEqual([
      "Question A",
      "Answer A",
      "Question B",
      "Answer B",
    ]);
  });

  it("does not reuse a checkpoint newer than a historical request boundary", async () => {
    const ledger = new InMemoryConversationLedger();
    await appendTurn(ledger, 1, "Question one", "Answer one");
    await appendTurn(ledger, 2, "Question two", "Answer two");
    const checkpoints = new InMemoryContextCheckpointRepository();
    await checkpoints.save({
      content: "Future checkpoint",
      contextEpochId: epoch.id,
      deletionRevision: 0,
      fromSequence: 1,
      throughSequence: 4,
      updatedAt: new Date(),
    });
    const assembler = new ContextAssembler({
      checkpoints,
      ledger,
      model: new CheckpointModel(),
    });

    const context = await assembler.assemble({
      beforeSequence: 3,
      contextEpochId: epoch.id,
      currentMessage: { content: "Question two", role: "user" },
    });

    expect(context.checkpoint).toBeNull();
    expect(context.history.map((message) => message.content)).toEqual([
      "Question one",
      "Answer one",
    ]);
  });

  it("keeps the largest recent complete suffix within twenty thousand tokens after compression", async () => {
    const ledger = new InMemoryConversationLedger();
    for (let index = 1; index <= 7; index += 1) {
      await appendTurn(
        ledger,
        index,
        `Q${index}${"q".repeat(4_490)}`,
        `A${index}${"a".repeat(4_490)}`,
      );
    }
    const assembler = new ContextAssembler({
      checkpoints: new InMemoryContextCheckpointRepository(),
      ledger,
      model: new CheckpointModel({
        contextWindowTokens: 60_000,
        maximumOutputTokens: 1_000,
      }),
    });

    const context = await assembler.assemble({
      contextEpochId: epoch.id,
    });

    expect(context.checkpoint?.throughSequence).toBe(10);
    expect(context.history).toHaveLength(5);
    expect(context.history[1]?.content.startsWith("Q6")).toBe(true);
    expect(context.history[3]?.content.startsWith("Q7")).toBe(true);
  });

  it("stops using a checkpoint when its deletion revision is stale", async () => {
    const ledger = new InMemoryConversationLedger();
    await appendTurn(ledger, 1, "Question one", "Answer one");
    await appendTurn(ledger, 2, "Question two", "Answer two");
    const checkpoints = new InMemoryContextCheckpointRepository();
    const model = new CheckpointModel();
    const assembler = new ContextAssembler({ checkpoints, ledger, model });
    await assembler.assemble({
      contextEpochId: epoch.id,
      maximumHistoryTurns: 1,
    });
    checkpoints.setDeletionRevision(1);

    const context = await assembler.assemble({
      contextEpochId: epoch.id,
      maximumHistoryTurns: 1,
    });

    expect(model.requests).toHaveLength(2);
    expect(context.checkpoint?.deletionRevision).toBe(1);
    expect(context.history.map((message) => message.content)).toEqual([
      expect.stringContaining("[UNTRUSTED CONVERSATION CHECKPOINT]"),
      "Question two",
      "Answer two",
    ]);
  });

  it("uses the checkpoint output limit when budgeting a compression request", async () => {
    const ledger = new InMemoryConversationLedger();
    await appendTurn(ledger, 1, "q".repeat(500), "a".repeat(500));
    const model = new CheckpointModel({
      contextWindowTokens: 10_000,
      maximumOutputTokens: 5_000,
    });
    const assembler = new ContextAssembler({
      checkpoints: new InMemoryContextCheckpointRepository(),
      ledger,
      model,
    });

    const context = await assembler.assemble({
      contextEpochId: epoch.id,
      currentMessage: { content: "Next question", role: "user" },
    });

    expect(model.requests).toHaveLength(1);
    expect(context.checkpoint?.throughSequence).toBe(2);
    expect(context.messages.at(-1)).toEqual({ content: "Next question", role: "user" });
  });

  it("rolls an oversized checkpoint prefix through bounded complete batches", async () => {
    const ledger = new InMemoryConversationLedger();
    for (let index = 1; index <= 20; index += 1) {
      await appendTurn(ledger, index, "q".repeat(100), "a".repeat(100));
    }
    const model = new CheckpointModel({
      contextWindowTokens: 10_000,
      maximumOutputTokens: 5_000,
    });
    const assembler = new ContextAssembler({
      checkpoints: new InMemoryContextCheckpointRepository(),
      ledger,
      model,
    });

    const context = await assembler.assemble({ contextEpochId: epoch.id });

    expect(model.requests).toHaveLength(2);
    expect(
      model.requests.every(
        (request) => model.contextProfile.estimateTokens(request.messages) <= 4_880,
      ),
    ).toBe(true);
    expect(context.checkpoint?.throughSequence).toBeGreaterThan(2);
    expect(context.history.at(-1)?.content).toBe("a".repeat(100));
  });

  it("falls back to bounded complete turns when checkpoints are disabled", async () => {
    const ledger = new InMemoryConversationLedger();
    await appendTurn(ledger, 1, "Question one", "Answer one");
    await appendTurn(ledger, 2, "Question two", "Answer two");
    const checkpoints = new InMemoryContextCheckpointRepository();
    await checkpoints.save({
      content: "Previously persisted checkpoint",
      contextEpochId: epoch.id,
      deletionRevision: 0,
      fromSequence: 1,
      throughSequence: 2,
      updatedAt: new Date(),
    });
    const model = new CheckpointModel();
    const assembler = new ContextAssembler({
      checkpointEnabled: false,
      checkpoints,
      ledger,
      model,
    });

    const context = await assembler.assemble({
      contextEpochId: epoch.id,
      maximumHistoryTurns: 1,
    });

    expect(context.checkpoint).toBeNull();
    expect(context.history.map((message) => message.content)).toEqual([
      "Question two",
      "Answer two",
    ]);
    expect(model.requests).toHaveLength(0);
  });

  it("uses the target adapter profile without shrinking checkpoint model batches", async () => {
    const assembler = new ContextAssembler({
      checkpoints: new InMemoryContextCheckpointRepository(),
      ledger: new InMemoryConversationLedger(),
      model: new CheckpointModel(),
    });

    await expect(
      assembler.assemble({
        contextProfile: {
          contextWindowTokens: 6_000,
          estimateTokens(messages) {
            return messages.reduce((total, message) => total + message.content.length, 0);
          },
          maximumOutputTokens: 1_000,
        },
        currentMessage: { content: "x".repeat(2_000), role: "user" },
      }),
    ).rejects.toBeInstanceOf(ContextAssemblyError);
  });

  it("fails explicitly instead of truncating an oversized current message", async () => {
    const assembler = new ContextAssembler({
      checkpoints: new InMemoryContextCheckpointRepository(),
      ledger: new InMemoryConversationLedger(),
      model: new CheckpointModel({
        contextWindowTokens: 256,
        maximumOutputTokens: 32,
      }),
    });

    await expect(
      assembler.assemble({
        currentMessage: { content: "x".repeat(1_000), role: "user" },
      }),
    ).rejects.toBeInstanceOf(ContextAssemblyError);
  });

  it("reserves 16,384 output tokens when a model omits its maximum output", async () => {
    const model: ModelGateway = {
      contextProfile: {
        contextWindowTokens: 25_000,
        estimateTokens(messages) {
          return messages.reduce((total, message) => total + message.content.length, 0);
        },
      },
      async *stream() {
        yield { inputTokens: 0, outputTokens: 0, type: "complete" };
      },
    };
    const assembler = new ContextAssembler({
      checkpoints: new InMemoryContextCheckpointRepository(),
      ledger: new InMemoryConversationLedger(),
      model,
    });

    await expect(
      assembler.assemble({
        currentMessage: { content: "x".repeat(5_000), role: "user" },
      }),
    ).rejects.toBeInstanceOf(ContextAssemblyError);
  });

  it("reassembles when the deletion revision changes before return", async () => {
    const checkpoints = new ChangingRevisionRepository();
    const assembler = new ContextAssembler({
      checkpoints,
      ledger: new InMemoryConversationLedger(),
      model: new CheckpointModel(),
    });

    const context = await assembler.assemble({
      currentMessage: { content: "Current question", role: "user" },
    });

    expect(context.messages.at(-1)).toEqual({
      content: "Current question",
      role: "user",
    });
    expect(checkpoints.reads).toBe(4);
  });
});

describe("boundUntrustedContext", () => {
  it("retains a hash, source, and original length when truncating", () => {
    const bounded = boundUntrustedContext("界".repeat(100), "context-id", 30);
    const parsed = JSON.parse(bounded) as Record<string, unknown>;

    expect(parsed).toMatchObject({
      originalBytes: 300,
      sourceId: "context-id",
      truncated: true,
    });
    expect(parsed["excerpt"]).toBe("界".repeat(10));
    expect(parsed["sha256"]).toMatch(/^[a-f0-9]{64}$/);
  });
});

class CheckpointModel implements ModelGateway {
  readonly contextProfile;
  readonly requests: ModelRequest[] = [];

  constructor(
    limits: {
      readonly contextWindowTokens: number;
      readonly maximumOutputTokens: number;
    } = {
      contextWindowTokens: 10_000,
      maximumOutputTokens: 1_000,
    },
  ) {
    this.contextProfile = {
      ...limits,
      estimateTokens(messages: readonly ModelMessage[]) {
        return messages.reduce((total, message) => total + message.content.length + 4, 2);
      },
    };
  }

  async *stream(request: ModelRequest) {
    this.requests.push(request);
    yield { content: "Bounded checkpoint.", type: "delta" as const };
    yield { inputTokens: 1, outputTokens: 1, type: "complete" as const };
  }
}

class ChangingRevisionRepository implements ContextCheckpointRepository {
  reads = 0;

  async deletionRevision(): Promise<number> {
    this.reads += 1;
    return this.reads === 1 ? 0 : 1;
  }

  async get() {
    return null;
  }

  async save() {
    return false;
  }
}

class ReopeningCheckpointRepository extends InMemoryContextCheckpointRepository {
  readonly #ledger: InMemoryConversationLedger;
  readonly #requestId: string;

  constructor(ledger: InMemoryConversationLedger, requestId: string) {
    super();
    this.#ledger = ledger;
    this.#requestId = requestId;
  }

  override async save(checkpoint: Parameters<ContextCheckpointRepository["save"]>[0]) {
    const saved = await super.save(checkpoint);
    await this.#ledger.clearRequestFailure(this.#requestId);
    return saved;
  }
}

async function appendTurn(
  ledger: InMemoryConversationLedger,
  index: number,
  user: string,
  assistant: string,
): Promise<void> {
  const requestId = `request-${index}`;
  await ledger.append({
    content: user,
    contextEpoch: epoch,
    id: `user-${index}`,
    occurredAt: new Date(epoch.startedAt.getTime() + index * 2_000),
    requestId,
    role: "user",
  });
  await ledger.append({
    content: assistant,
    contextEpoch: epoch,
    id: `assistant-${index}`,
    occurredAt: new Date(epoch.startedAt.getTime() + index * 2_000 + 1_000),
    requestId,
    role: "assistant",
  });
}
