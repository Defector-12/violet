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

  it("marks a failed request terminal and clears that state after a successful retry", async () => {
    const ledger = new InMemoryConversationLedger();
    const model = new FlakyModel();
    const service = new ChatService({
      contextAssembler: new ContextAssembler({
        checkpoints: new InMemoryContextCheckpointRepository(),
        ledger,
        model,
      }),
      epochManager: new ContextEpochManager({ generateId: () => "epoch-1" }),
      generateId: randomId(),
      ledger,
      modelGateway: model,
      now: () => new Date("2026-09-16T00:00:00.000Z"),
    });
    const request = {
      message: "Retry after failure",
      requestId: "00000000-0000-4000-8000-000000000001",
    };

    await consume(service.stream(request));
    await expect(ledger.listTurns({ contextEpochId: "epoch-1" })).resolves.toMatchObject([
      { completed: false, failed: true },
    ]);

    await consume(service.stream(request));
    await expect(ledger.listTurns({ contextEpochId: "epoch-1" })).resolves.toMatchObject([
      { completed: true, failed: false },
    ]);
  });

  it("serializes epoch admission so delayed earlier input cannot cross the idle boundary", async () => {
    const ledger = new DelayedFindLedger();
    const model = new RecordingModel();
    let epochs = 0;
    const epochManager = new ContextEpochManager({
      generateId: () => `epoch-${++epochs}`,
    });
    const startedAt = new Date("2026-09-16T00:00:00.000Z");
    const initialEpoch = epochManager.acceptUserInput(startedAt);
    const laterInputAt = new Date(startedAt.getTime() + 30 * 60_000 + 1_000);
    const inputTimes = [new Date(startedAt.getTime() + 29 * 60_000 + 59_000), laterInputAt];
    let nowCalls = 0;
    const service = new ChatService({
      contextAssembler: new ContextAssembler({
        checkpoints: new InMemoryContextCheckpointRepository(),
        ledger,
        model,
      }),
      epochManager,
      generateId: randomId(),
      ledger,
      modelGateway: model,
      now: () => inputTimes[nowCalls++] ?? laterInputAt,
    });

    const first = consume(
      service.stream({
        message: "Earlier input",
        requestId: "00000000-0000-4000-8000-000000000001",
      }),
    );
    await ledger.firstFindStarted;
    const second = consume(
      service.stream({
        message: "Later input",
        requestId: "00000000-0000-4000-8000-000000000002",
      }),
    );
    ledger.releaseFirstFind();
    await Promise.all([first, second]);

    const messages = await ledger.list();
    expect(messages.filter((message) => message.role === "user")).toMatchObject([
      { contextEpochId: initialEpoch.id },
      { contextEpochId: initialEpoch.id },
    ]);
    expect(epochs).toBe(1);
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

class FlakyModel extends RecordingModel {
  #attempt = 0;

  override async *stream(request: ModelRequest) {
    this.#attempt += 1;
    if (this.#attempt === 1) {
      throw new Error("synthetic model failure");
    }
    yield* super.stream(request);
  }
}

class DelayedFindLedger extends InMemoryConversationLedger {
  readonly firstFindStarted: Promise<void>;
  #findCalls = 0;
  #notifyFirstFind = () => {};
  #releaseFirst = () => {};
  #waitForRelease: Promise<void>;

  constructor() {
    super();
    this.firstFindStarted = new Promise((resolve) => {
      this.#notifyFirstFind = resolve;
    });
    this.#waitForRelease = new Promise((resolve) => {
      this.#releaseFirst = resolve;
    });
  }

  override async findByRequest(requestId: string, role: "assistant" | "user") {
    this.#findCalls += 1;
    if (this.#findCalls === 1) {
      this.#notifyFirstFind();
      await this.#waitForRelease;
    }
    return super.findByRequest(requestId, role);
  }

  releaseFirstFind(): void {
    this.#releaseFirst();
  }
}

function randomId(): () => string {
  let id = 0;
  return () => `id-${++id}`;
}

async function consume<T>(events: AsyncIterable<T>): Promise<void> {
  for await (const _event of events) {
    // Consume the stream so the assistant turn is persisted.
  }
}
