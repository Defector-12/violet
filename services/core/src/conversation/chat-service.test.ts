import type { ModelGateway, ModelRequest } from "@violet/domain";
import { describe, expect, it, vi } from "vitest";
import { RealtimeTurnFailureRecovery } from "../realtime/realtime-turn-failure-recovery.js";
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

    const firstEvents = await collect(service.stream(request));
    now = new Date(now.getTime() + 31 * 60_000);
    const retriedEvents = await collect(service.stream(request));
    expect(epochs).toBe(1);
    expect(model.requests).toHaveLength(1);
    expect(retriedEvents.map((event) => event.type)).toEqual(["start", "delta", "complete"]);
    expect(retriedEvents[1]).toMatchObject({
      content: "Test answer",
      requestId: request.requestId,
    });
    expect(retriedEvents[2]).toMatchObject({
      messageId: firstEvents[2]?.type === "complete" ? firstEvents[2].messageId : undefined,
      usage: { inputTokens: 0, outputTokens: 0 },
    });

    await consume(
      service.stream({
        message: "A genuinely new request",
        requestId: "00000000-0000-4000-8000-000000000002",
      }),
    );
    expect(epochs).toBe(2);
    expect(model.requests).toHaveLength(2);
  });

  it("coalesces concurrent retries behind the first completed response", async () => {
    const ledger = new InMemoryConversationLedger();
    const model = new BlockingModel();
    const service = createService(ledger, model);
    const request = {
      message: "Run once",
      requestId: "00000000-0000-4000-8000-000000000001",
    };

    const first = collect(service.stream(request));
    await model.started;
    const retry = collect(service.stream(request));
    await Promise.resolve();
    expect(model.requests).toHaveLength(1);

    model.release();
    const [firstEvents, retryEvents] = await Promise.all([first, retry]);

    expect(model.requests).toHaveLength(1);
    expect(retryEvents[1]).toMatchObject({
      content: "Test answer",
      requestId: request.requestId,
    });
    expect(retryEvents[2]).toMatchObject({
      messageId: firstEvents[2]?.type === "complete" ? firstEvents[2].messageId : undefined,
      usage: { inputTokens: 0, outputTokens: 0 },
    });
  });

  it("rejects the same request while another service instance is still processing it", async () => {
    const ledger = new InMemoryConversationLedger();
    const recovery = new RealtimeTurnFailureRecovery({ ledger });
    const firstModel = new BlockingModel();
    const secondModel = new RecordingModel();
    const firstService = createService(ledger, firstModel, recovery);
    const secondService = createService(ledger, secondModel, recovery);
    const request = {
      message: "Shared in-flight request",
      requestId: "00000000-0000-4000-8000-000000000001",
    };

    const first = collect(firstService.stream(request));
    await firstModel.started;
    const duplicate = await collect(secondService.stream(request));

    expect(duplicate).toMatchObject([
      {
        error: { code: "REQUEST_IN_PROGRESS", retryable: true },
        requestId: request.requestId,
        type: "error",
      },
    ]);
    expect(secondModel.requests).toHaveLength(0);

    firstModel.release();
    await first;
    await recovery.stop();
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

  it("marks a persisted request failed when the response iterator is closed early", async () => {
    const ledger = new InMemoryConversationLedger();
    const service = createService(ledger, new RecordingModel());
    const requestId = "00000000-0000-4000-8000-000000000001";
    const stream = service
      .stream({ message: "Stop after start", requestId })
      [Symbol.asyncIterator]();

    await expect(stream.next()).resolves.toMatchObject({
      value: { requestId, type: "start" },
    });
    await stream.return?.();

    const user = await ledger.findByRequest(requestId, "user");
    await expect(
      ledger.listTurns({ contextEpochId: user?.contextEpochId ?? "" }),
    ).resolves.toMatchObject([{ completed: false, failed: true, requestId }]);
  });

  it("retries a transient failure-marker write without waiting for a restart", async () => {
    const ledger = new FlakyFailureLedger();
    const recovery = new RealtimeTurnFailureRecovery({
      ledger,
      maximumRetryDelayMs: 1,
      retryDelayMs: 0,
    });
    const service = createService(ledger, new FlakyModel(), recovery);
    const requestId = "00000000-0000-4000-8000-000000000001";

    await consume(service.stream({ message: "Fail once", requestId }));
    await waitUntil(() => ledger.failureAttempts === 4);

    const user = await ledger.findByRequest(requestId, "user");
    await expect(
      ledger.listTurns({ contextEpochId: user?.contextEpochId ?? "" }),
    ).resolves.toMatchObject([{ completed: false, failed: true, requestId }]);
    await recovery.stop();
  });

  it("releases the request claim when the user event cannot be persisted", async () => {
    const ledger = new FlakyUserAppendLedger();
    const model = new RecordingModel();
    const service = createService(ledger, model);
    const request = {
      message: "Retry persistence",
      requestId: "00000000-0000-4000-8000-000000000001",
    };

    await expect(collect(service.stream(request))).resolves.toMatchObject([
      { error: { code: "MODEL_GATEWAY_FAILED" }, type: "error" },
    ]);
    await expect(collect(service.stream(request))).resolves.toMatchObject([
      { type: "start" },
      { content: "Test answer", type: "delta" },
      { type: "complete" },
    ]);
    expect(model.requests).toHaveLength(1);
  });

  it.each([false, true])(
    "terminalizes a claimed request when admission lookup fails (reopened=%s)",
    async (reopened) => {
      const ledger = new InMemoryConversationLedger();
      const model = new RecordingModel();
      const recovery = new RealtimeTurnFailureRecovery({ ledger });
      const service = createService(ledger, model, recovery);
      const request = {
        message: "Retry admission",
        requestId: "00000000-0000-4000-8000-000000000001",
      };
      if (reopened) {
        const occurredAt = new Date("2026-09-16T00:00:00.000Z");
        await ledger.append({
          content: request.message,
          contextEpoch: { id: "epoch-1", startedAt: occurredAt },
          id: "original-user",
          occurredAt,
          requestId: request.requestId,
          role: "user",
        });
        await ledger.markRequestFailed(request.requestId, "epoch-1", occurredAt);
      }
      const existing = await ledger.findByRequest(request.requestId, "user");
      const lookup = vi
        .spyOn(ledger, "findByRequest")
        .mockResolvedValueOnce(existing)
        .mockResolvedValueOnce(null)
        .mockRejectedValueOnce(new Error("Temporary post-claim read failure"));
      try {
        await expect(collect(service.stream(request))).resolves.toMatchObject([
          { error: { code: "MODEL_GATEWAY_FAILED" }, type: "error" },
        ]);
        await expect(ledger.listTurns({ contextEpochId: "epoch-1" })).resolves.toMatchObject([
          { completed: false, failed: true, requestId: request.requestId },
        ]);
        await expect(ledger.isCompletePrefix("epoch-1", 1)).resolves.toBe(true);
        expect(model.requests).toHaveLength(0);

        await expect(collect(service.stream(request))).resolves.toMatchObject([
          { type: "start" },
          { content: "Test answer", type: "delta" },
          { type: "complete" },
        ]);
        expect(model.requests).toHaveLength(1);
        await expect(ledger.listTurns({ contextEpochId: "epoch-1" })).resolves.toMatchObject([
          { completed: true, failed: false, requestId: request.requestId },
        ]);
      } finally {
        lookup.mockRestore();
        await recovery.stop();
      }
    },
  );

  it("rejects a request ID reused with different content", async () => {
    const ledger = new InMemoryConversationLedger();
    const model = new RecordingModel();
    const service = createService(ledger, model);
    const requestId = "00000000-0000-4000-8000-000000000001";

    await consume(service.stream({ message: "Original", requestId }));
    const retry = await collect(service.stream({ message: "Changed", requestId }));

    expect(retry).toMatchObject([
      {
        error: { code: "REQUEST_ID_CONFLICT", retryable: false },
        requestId,
        type: "error",
      },
    ]);
    expect(model.requests).toHaveLength(1);
  });

  it("rejects a request ID reused with a different context event", async () => {
    const ledger = new InMemoryConversationLedger();
    const model = new RecordingModel();
    const service = createService(ledger, model);
    const requestId = "00000000-0000-4000-8000-000000000001";
    const contextSessionId = "00000000-0000-4000-8000-000000000002";
    const firstEventId = "00000000-0000-4000-8000-000000000003";
    const secondEventId = "00000000-0000-4000-8000-000000000004";

    await consume(
      service.stream({ contextSessionId, message: "Inspect this", requestId }, undefined, {
        content: "First context",
        eventId: firstEventId,
        sourceId: contextSessionId,
      }),
    );
    const retry = await collect(
      service.stream({ contextSessionId, message: "Inspect this", requestId }, undefined, {
        content: "Second context",
        eventId: secondEventId,
        sourceId: contextSessionId,
      }),
    );

    expect(retry).toMatchObject([
      {
        error: { code: "REQUEST_ID_CONFLICT", retryable: false },
        requestId,
        type: "error",
      },
    ]);
    expect(model.requests).toHaveLength(1);
  });

  it("rejects a request ID reused with the same event from a different context session", async () => {
    const ledger = new InMemoryConversationLedger();
    const model = new RecordingModel();
    const service = createService(ledger, model);
    const requestId = "00000000-0000-4000-8000-000000000001";
    const firstSessionId = "00000000-0000-4000-8000-000000000002";
    const secondSessionId = "00000000-0000-4000-8000-000000000003";
    const eventId = "00000000-0000-4000-8000-000000000004";

    await consume(
      service.stream(
        { contextSessionId: firstSessionId, message: "Inspect this", requestId },
        undefined,
        {
          content: "First context",
          eventId,
          sourceId: firstSessionId,
        },
      ),
    );
    const retry = await collect(
      service.stream(
        { contextSessionId: secondSessionId, message: "Inspect this", requestId },
        undefined,
        {
          content: "Second context",
          eventId,
          sourceId: secondSessionId,
        },
      ),
    );

    expect(retry).toMatchObject([
      {
        error: { code: "REQUEST_ID_CONFLICT", retryable: false },
        requestId,
        type: "error",
      },
    ]);
    expect(model.requests).toHaveLength(1);
  });

  it("treats UUID case variants as the same idempotent request", async () => {
    const ledger = new InMemoryConversationLedger();
    const model = new RecordingModel();
    const service = createService(ledger, model);
    const requestId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

    const first = await collect(service.stream({ message: "Same UUID", requestId }));
    const retry = await collect(
      service.stream({ message: "Same UUID", requestId: requestId.toUpperCase() }),
    );

    expect(model.requests).toHaveLength(1);
    expect(retry[2]).toMatchObject({
      messageId: first[2]?.type === "complete" ? first[2].messageId : undefined,
      requestId: requestId.toUpperCase(),
      type: "complete",
    });
    await expect(ledger.list()).resolves.toHaveLength(2);
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

class BlockingModel extends RecordingModel {
  readonly started: Promise<void>;
  #notifyStarted = () => {};
  #release = () => {};
  #released: Promise<void>;

  constructor() {
    super();
    this.started = new Promise((resolve) => {
      this.#notifyStarted = resolve;
    });
    this.#released = new Promise((resolve) => {
      this.#release = resolve;
    });
  }

  override async *stream(request: ModelRequest) {
    this.requests.push(request);
    this.#notifyStarted();
    await this.#released;
    yield { content: "Test answer", type: "delta" as const };
    yield { inputTokens: 1, outputTokens: 1, type: "complete" as const };
  }

  release(): void {
    this.#release();
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

class FlakyFailureLedger extends InMemoryConversationLedger {
  failureAttempts = 0;

  override async markRequestFailed(
    requestId: string,
    contextEpochId: string,
    occurredAt: Date,
  ): Promise<void> {
    this.failureAttempts += 1;
    if (this.failureAttempts <= 3) {
      throw new Error("Temporary database failure");
    }
    await super.markRequestFailed(requestId, contextEpochId, occurredAt);
  }
}

class FlakyUserAppendLedger extends InMemoryConversationLedger {
  #failed = false;

  override async append(input: Parameters<InMemoryConversationLedger["append"]>[0]) {
    if (!this.#failed && input.role === "user") {
      this.#failed = true;
      throw new Error("Temporary user append failure");
    }
    return super.append(input);
  }
}

function createService(
  ledger: InMemoryConversationLedger,
  modelGateway: ModelGateway,
  turnFailureRecovery?: RealtimeTurnFailureRecovery,
): ChatService {
  return new ChatService({
    contextAssembler: new ContextAssembler({
      checkpoints: new InMemoryContextCheckpointRepository(),
      ledger,
      model: modelGateway,
    }),
    epochManager: new ContextEpochManager({ generateId: () => "epoch-1" }),
    generateId: randomId(),
    ledger,
    modelGateway,
    ...(turnFailureRecovery ? { turnFailureRecovery } : {}),
    now: () => new Date("2026-09-16T00:00:00.000Z"),
  });
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

async function collect<T>(events: AsyncIterable<T>): Promise<T[]> {
  const output: T[] = [];
  for await (const event of events) {
    output.push(event);
  }
  return output;
}

async function waitUntil(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error("Condition was not met");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
