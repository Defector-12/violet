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

    const generation = await recovery.begin(turnId);
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

    const generation = await recovery.begin(turnId);
    await recovery.fail(turnId, contextEpoch, generation, new Date());
    await recovery.begin(turnId);
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
    const oldGeneration = await recovery.begin(turnId);
    const currentGeneration = await recovery.begin(turnId);

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
    const generation = await recovery.begin(turnId);
    const clearFailure = vi
      .spyOn(ledger, "clearRequestFailure")
      .mockRejectedValueOnce(new Error("Retry could not reopen the turn"));

    await recovery.fail(turnId, contextEpoch, generation, new Date());
    await expect(recovery.begin(turnId)).rejects.toThrow("Retry could not reopen the turn");
    await waitUntil(() => markFailed.mock.calls.length === 4);

    expect(clearFailure).toHaveBeenCalledTimes(1);
    await expect(ledger.listTurns({ contextEpochId: contextEpoch.id })).resolves.toMatchObject([
      { failed: true, requestId: turnId },
    ]);
    await recovery.stop();
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
