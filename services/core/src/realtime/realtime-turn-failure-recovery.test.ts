import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { InMemoryConversationLedger } from "../conversation/in-memory-conversation-ledger.js";
import { RealtimeTurnFailureRecovery } from "./realtime-turn-failure-recovery.js";

describe("RealtimeTurnFailureRecovery", () => {
  it("retries a scheduled terminal marker until it is persisted", async () => {
    const ledger = new InMemoryConversationLedger();
    const contextEpoch = { id: randomUUID(), startedAt: new Date() };
    const turnId = randomUUID();
    await ledger.append({
      content: "Interrupted request",
      contextEpoch,
      id: randomUUID(),
      occurredAt: contextEpoch.startedAt,
      requestId: turnId,
      role: "user",
    });
    const persistFailure = ledger.markRequestFailed.bind(ledger);
    let attempts = 0;
    const markFailed = vi.spyOn(ledger, "markRequestFailed").mockImplementation((...input) => {
      attempts += 1;
      return attempts <= 3
        ? Promise.reject(new Error("Temporary database failure"))
        : persistFailure(...input);
    });
    const recovery = new RealtimeTurnFailureRecovery({
      ledger,
      maximumRetryDelayMs: 1,
      retryDelayMs: 0,
    });

    const generation = await recovery.start(turnId);
    if (generation === null) throw new Error("Expected the turn to start");
    await recovery.fail(turnId, contextEpoch, generation, new Date());
    await waitUntil(() => markFailed.mock.calls.length === 4);

    await expect(ledger.listTurns({ contextEpochId: contextEpoch.id })).resolves.toMatchObject([
      { completed: false, failed: true, requestId: turnId },
    ]);
    await recovery.stop();
  });

  it("cancels queued recovery when the turn is retried", async () => {
    const ledger = new InMemoryConversationLedger();
    const contextEpoch = { id: randomUUID(), startedAt: new Date() };
    const recovery = new RealtimeTurnFailureRecovery({
      ledger,
      retryDelayMs: 10,
    });
    const turnId = randomUUID();
    await ledger.append({
      content: "Retry this request",
      contextEpoch,
      id: randomUUID(),
      occurredAt: contextEpoch.startedAt,
      requestId: turnId,
      role: "user",
    });
    const markFailed = vi
      .spyOn(ledger, "markRequestFailed")
      .mockRejectedValue(new Error("Temporary database failure"));

    const generation = await recovery.start(turnId);
    if (generation === null) throw new Error("Expected the turn to start");
    await recovery.fail(turnId, contextEpoch, generation, new Date());
    await expect(recovery.reopen(turnId)).resolves.toEqual(expect.any(Number));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(markFailed).toHaveBeenCalledTimes(3);
    await recovery.stop();
  });

  it("ignores a terminal signal from an older turn generation", async () => {
    const ledger = new InMemoryConversationLedger();
    const contextEpoch = { id: randomUUID(), startedAt: new Date() };
    const turnId = randomUUID();
    await ledger.append({
      content: "Retried request",
      contextEpoch,
      id: randomUUID(),
      occurredAt: contextEpoch.startedAt,
      requestId: turnId,
      role: "user",
    });
    const recovery = new RealtimeTurnFailureRecovery({ ledger });
    const oldGeneration = await recovery.start(turnId);
    if (oldGeneration === null) throw new Error("Expected the turn to start");
    await recovery.fail(turnId, contextEpoch, oldGeneration, new Date());
    const currentGeneration = await recovery.reopen(turnId);
    if (currentGeneration === null) throw new Error("Expected the turn to reopen");

    await recovery.fail(turnId, contextEpoch, oldGeneration, new Date());
    await expect(ledger.listTurns({ contextEpochId: contextEpoch.id })).resolves.toMatchObject([
      { failed: false, requestId: turnId },
    ]);

    await recovery.fail(turnId, contextEpoch, currentGeneration, new Date());
    await expect(ledger.listTurns({ contextEpochId: contextEpoch.id })).resolves.toMatchObject([
      { failed: true, requestId: turnId },
    ]);
    await recovery.stop();
  });

  it("keeps queued recovery when reopening the turn fails", async () => {
    const ledger = new InMemoryConversationLedger();
    const contextEpoch = { id: randomUUID(), startedAt: new Date() };
    const turnId = randomUUID();
    await ledger.append({
      content: "Retry after database recovery",
      contextEpoch,
      id: randomUUID(),
      occurredAt: contextEpoch.startedAt,
      requestId: turnId,
      role: "user",
    });
    const persistFailure = ledger.markRequestFailed.bind(ledger);
    let failureAttempts = 0;
    const markFailed = vi.spyOn(ledger, "markRequestFailed").mockImplementation((...input) => {
      failureAttempts += 1;
      return failureAttempts <= 3
        ? Promise.reject(new Error("Temporary database failure"))
        : persistFailure(...input);
    });
    const recovery = new RealtimeTurnFailureRecovery({
      ledger,
      maximumRetryDelayMs: 1,
      retryDelayMs: 1,
    });
    const generation = await recovery.start(turnId);
    if (generation === null) throw new Error("Expected the turn to start");
    const clearFailure = vi
      .spyOn(ledger, "clearRequestFailure")
      .mockRejectedValueOnce(new Error("Retry could not reopen the turn"));

    await recovery.fail(turnId, contextEpoch, generation, new Date());
    await expect(recovery.reopen(turnId)).rejects.toThrow("Retry could not reopen the turn");
    await waitUntil(() => markFailed.mock.calls.length === 4);

    expect(clearFailure).toHaveBeenCalledTimes(1);
    await expect(ledger.listTurns({ contextEpochId: contextEpoch.id })).resolves.toMatchObject([
      { failed: true, requestId: turnId },
    ]);
    await recovery.stop();
  });

  it("does not reopen a turn that has not been marked failed", async () => {
    const ledger = new InMemoryConversationLedger();
    const contextEpoch = { id: randomUUID(), startedAt: new Date() };
    const turnId = randomUUID();
    await ledger.append({
      content: "Still in progress",
      contextEpoch,
      id: randomUUID(),
      occurredAt: contextEpoch.startedAt,
      requestId: turnId,
      role: "user",
    });
    const recovery = new RealtimeTurnFailureRecovery({ ledger });

    await expect(recovery.start(turnId)).resolves.toEqual(expect.any(Number));
    await expect(recovery.start(turnId.toUpperCase())).resolves.toBeNull();
    await expect(recovery.reopen(turnId)).resolves.toBeNull();
    await recovery.stop();
  });

  it("drains a queued terminal marker before stopping", async () => {
    const ledger = new InMemoryConversationLedger();
    const contextEpoch = { id: randomUUID(), startedAt: new Date() };
    const turnId = randomUUID();
    await ledger.append({
      content: "Interrupted during shutdown",
      contextEpoch,
      id: randomUUID(),
      occurredAt: contextEpoch.startedAt,
      requestId: turnId,
      role: "user",
    });
    const persistFailure = ledger.markRequestFailed.bind(ledger);
    let attempts = 0;
    vi.spyOn(ledger, "markRequestFailed").mockImplementation((...input) => {
      attempts += 1;
      return attempts <= 3
        ? Promise.reject(new Error("Temporary database failure"))
        : persistFailure(...input);
    });
    const recovery = new RealtimeTurnFailureRecovery({
      ledger,
      retryDelayMs: 60_000,
    });

    const generation = await recovery.start(turnId);
    if (generation === null) throw new Error("Expected the turn to start");
    await recovery.fail(turnId, contextEpoch, generation, new Date());
    await recovery.stop();

    expect(attempts).toBe(4);
    await expect(ledger.listTurns({ contextEpochId: contextEpoch.id })).resolves.toMatchObject([
      { completed: false, failed: true, requestId: turnId },
    ]);
  });

  it("reports a failed shutdown drain instead of silently dropping it", async () => {
    const ledger = new InMemoryConversationLedger();
    const contextEpoch = { id: randomUUID(), startedAt: new Date() };
    const turnId = randomUUID();
    await ledger.append({
      content: "Still unavailable during shutdown",
      contextEpoch,
      id: randomUUID(),
      occurredAt: contextEpoch.startedAt,
      requestId: turnId,
      role: "user",
    });
    const markFailed = vi
      .spyOn(ledger, "markRequestFailed")
      .mockRejectedValue(new Error("Database remains unavailable"));
    const recovery = new RealtimeTurnFailureRecovery({
      ledger,
      retryDelayMs: 60_000,
    });

    const generation = await recovery.start(turnId);
    if (generation === null) throw new Error("Expected the turn to start");
    await recovery.fail(turnId, contextEpoch, generation, new Date());

    await expect(recovery.stop()).rejects.toThrow(
      "Could not persist 1 realtime turn failure marker",
    );
    expect(markFailed).toHaveBeenCalledTimes(6);
  });

  it("bounds shutdown when storage never resolves", async () => {
    const ledger = new InMemoryConversationLedger();
    const contextEpoch = { id: randomUUID(), startedAt: new Date() };
    const turnId = randomUUID();
    await ledger.append({
      content: "Storage is stuck during shutdown",
      contextEpoch,
      id: randomUUID(),
      occurredAt: contextEpoch.startedAt,
      requestId: turnId,
      role: "user",
    });
    const markFailed = vi
      .spyOn(ledger, "markRequestFailed")
      .mockRejectedValue(new Error("Database remains unavailable"));
    const recovery = new RealtimeTurnFailureRecovery({
      ledger,
      retryDelayMs: 60_000,
      shutdownTimeoutMs: 10,
    });
    const generation = await recovery.start(turnId);
    if (generation === null) throw new Error("Expected the turn to start");
    await recovery.fail(turnId, contextEpoch, generation, new Date());
    let resolveLookup: ((value: null) => void) | undefined;
    vi.spyOn(ledger, "findByRequest").mockReturnValue(
      new Promise((resolve) => {
        resolveLookup = resolve;
      }),
    );

    await expect(
      Promise.race([
        recovery.stop(),
        new Promise<void>((_, reject) => {
          setTimeout(() => reject(new Error("Shutdown exceeded its test deadline")), 250);
        }),
      ]),
    ).rejects.toThrow("Could not persist 1 realtime turn failure marker");
    resolveLookup?.(null);
    await Promise.resolve();
    expect(markFailed).toHaveBeenCalledTimes(3);
  });

  it("bounds shutdown while an earlier recovery operation is still running", async () => {
    const ledger = new InMemoryConversationLedger();
    const contextEpoch = { id: randomUUID(), startedAt: new Date() };
    const turnId = randomUUID();
    await ledger.append({
      content: "Storage stalls before shutdown",
      contextEpoch,
      id: randomUUID(),
      occurredAt: contextEpoch.startedAt,
      requestId: turnId,
      role: "user",
    });
    let resolvePersist: (() => void) | undefined;
    const markFailed = vi.spyOn(ledger, "markRequestFailed").mockReturnValue(
      new Promise<void>((resolve) => {
        resolvePersist = resolve;
      }),
    );
    const recovery = new RealtimeTurnFailureRecovery({
      ledger,
      retryDelayMs: 60_000,
      shutdownTimeoutMs: 10,
    });
    const generation = await recovery.start(turnId);
    if (generation === null) throw new Error("Expected the turn to start");
    const failure = recovery.fail(turnId, contextEpoch, generation, new Date());
    await waitUntil(() => markFailed.mock.calls.length === 1);

    await expect(
      Promise.race([
        recovery.stop(),
        new Promise<void>((_, reject) => {
          setTimeout(() => reject(new Error("Shutdown exceeded its test deadline")), 250);
        }),
      ]),
    ).rejects.toThrow("Could not persist 1 realtime turn failure marker");
    resolvePersist?.();
    await failure;
    expect(markFailed).toHaveBeenCalledTimes(1);
  });
});

async function waitUntil(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error("Condition was not met");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
