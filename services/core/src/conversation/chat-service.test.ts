import type { ModelGateway, ModelRequest } from "@violet/domain";
import { describe, expect, it } from "vitest";

import { ChatService } from "./chat-service.js";
import { ContextAssembler } from "./context-assembler.js";
import { ContextEpochManager } from "./context-epoch-manager.js";
import { InMemoryContextCheckpointRepository } from "./in-memory-context-checkpoint-repository.js";
import { InMemoryConversationLedger } from "./in-memory-conversation-ledger.js";

describe("ChatService context assembly", () => {
  it("uses complete turns from the active epoch and excludes them after thirty minutes", async () => {
    const ledger = new InMemoryConversationLedger();
    const model = new RecordingModel();
    let now = new Date("2026-09-16T00:00:00.000Z");
    let id = 0;
    const service = new ChatService({
      contextAssembler: new ContextAssembler({
        checkpoints: new InMemoryContextCheckpointRepository(),
        ledger,
        model,
      }),
      epochManager: new ContextEpochManager({
        generateId: () => `epoch-${++id}`,
      }),
      generateId: () => `id-${++id}`,
      ledger,
      modelGateway: model,
      now: () => now,
    });

    await consume(
      service.stream({
        message: "First question",
        requestId: "00000000-0000-4000-8000-000000000001",
      }),
    );
    now = new Date(now.getTime() + 29 * 60_000 + 59_000);
    await consume(
      service.stream({
        message: "Second question",
        requestId: "00000000-0000-4000-8000-000000000002",
      }),
    );
    now = new Date(now.getTime() + 30 * 60_000);
    await consume(
      service.stream({
        message: "Third question",
        requestId: "00000000-0000-4000-8000-000000000003",
      }),
    );

    expect(model.requests[1]?.messages.map((message) => message.content)).toEqual([
      expect.stringContaining("private AI assistant"),
      "First question",
      "Test answer",
      "Second question",
    ]);
    expect(model.requests[2]?.messages.map((message) => message.content)).toEqual([
      expect.stringContaining("private AI assistant"),
      "Third question",
    ]);
  });

  it("does not create or extend an epoch for an idempotent request retry", async () => {
    const ledger = new InMemoryConversationLedger();
    const model = new RecordingModel();
    let now = new Date("2026-09-16T00:00:00.000Z");
    let epochs = 0;
    let ids = 0;
    const service = new ChatService({
      contextAssembler: new ContextAssembler({
        checkpoints: new InMemoryContextCheckpointRepository(),
        ledger,
        model,
      }),
      epochManager: new ContextEpochManager({
        generateId: () => `epoch-${++epochs}`,
      }),
      generateId: () => `id-${++ids}`,
      ledger,
      modelGateway: model,
      now: () => now,
    });
    const request = {
      message: "Retry me",
      requestId: "00000000-0000-4000-8000-000000000001",
    };

    await consume(service.stream(request));
    now = new Date(now.getTime() + 31 * 60_000);
    await consume(service.stream(request));
    expect(epochs).toBe(1);

    await consume(
      service.stream({
        message: "A genuinely new request",
        requestId: "00000000-0000-4000-8000-000000000002",
      }),
    );
    expect(epochs).toBe(2);
  });
});

class RecordingModel implements ModelGateway {
  readonly contextProfile = {
    contextWindowTokens: 100_000,
    estimateTokens(messages: readonly { readonly content: string }[]) {
      return messages.reduce((total, message) => total + message.content.length, 0);
    },
    maximumOutputTokens: 1_000,
  };
  readonly requests: ModelRequest[] = [];

  async *stream(request: ModelRequest) {
    this.requests.push(request);
    yield { content: "Test answer", type: "delta" as const };
    yield { inputTokens: 1, outputTokens: 1, type: "complete" as const };
  }
}

async function consume<T>(events: AsyncIterable<T>): Promise<void> {
  for await (const _event of events) {
    // Consume the stream so the assistant turn is persisted.
  }
}
