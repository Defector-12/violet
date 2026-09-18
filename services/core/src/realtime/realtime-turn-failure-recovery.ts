import type { ContextEpoch, ConversationLedger } from "@violet/domain";

import { recordTestTrace } from "./test-trace.js";

interface PendingFailure {
  readonly contextEpoch: ContextEpoch;
  readonly generation: number;
  readonly turnId: string;
}

export interface RealtimeTurnFailureRecoveryPort {
  begin(turnId: string): Promise<number>;
  complete(turnId: string, generation: number): Promise<void>;
  fail(
    turnId: string,
    contextEpoch: ContextEpoch,
    generation: number,
    occurredAt: Date,
  ): Promise<void>;
}

export class RealtimeTurnFailureRecovery implements RealtimeTurnFailureRecoveryPort {
  readonly #baseRetryDelayMs: number;
  readonly #generations = new Map<string, number>();
  readonly #ledger: ConversationLedger;
  readonly #maximumRetryDelayMs: number;
  readonly #now: () => Date;
  readonly #pending = new Map<string, PendingFailure>();
  #currentRetryDelayMs: number;
  #nextGeneration = 1;
  #operationQueue = Promise.resolve();
  #stopped = false;
  #timer: NodeJS.Timeout | undefined;

  constructor(options: {
    readonly ledger: ConversationLedger;
    readonly now?: () => Date;
    readonly retryDelayMs?: number;
    readonly maximumRetryDelayMs?: number;
  }) {
    this.#baseRetryDelayMs = options.retryDelayMs ?? 1_000;
    this.#currentRetryDelayMs = this.#baseRetryDelayMs;
    this.#ledger = options.ledger;
    this.#maximumRetryDelayMs = options.maximumRetryDelayMs ?? 30_000;
    this.#now = options.now ?? (() => new Date());
  }

  async begin(turnId: string): Promise<number> {
    return this.#enqueue(async () => {
      if (this.#stopped) {
        throw new Error("Realtime turn failure recovery is stopped");
      }
      const key = canonicalId(turnId);
      const generation = this.#nextGeneration++;
      await this.#ledger.clearRequestFailure(turnId);
      this.#generations.set(key, generation);
      this.#pending.delete(key);
      return generation;
    });
  }

  async complete(turnId: string, generation: number): Promise<void> {
    await this.#enqueue(async () => {
      if (this.#stopped) {
        return;
      }
      const key = canonicalId(turnId);
      if (this.#generations.get(key) === generation) {
        this.#pending.delete(key);
        this.#generations.delete(key);
      }
    });
  }

  async fail(
    turnId: string,
    contextEpoch: ContextEpoch,
    generation: number,
    occurredAt: Date,
  ): Promise<void> {
    await this.#enqueue(async () => {
      if (this.#stopped) {
        return;
      }
      const key = canonicalId(turnId);
      if (this.#generations.get(key) !== generation) {
        return;
      }
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          await this.#ledger.markRequestFailed(turnId, contextEpoch.id, occurredAt);
          this.#pending.delete(key);
          this.#generations.delete(key);
          return;
        } catch (error) {
          recordTestTrace("realtime.failure_state.failed", {
            attempt,
            error: error instanceof Error ? error.message : "unknown",
            turnId,
          });
        }
      }
      this.#pending.set(key, { contextEpoch, generation, turnId });
      this.#scheduleFlush();
    });
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    await this.#operationQueue;
    this.#pending.clear();
    this.#generations.clear();
  }

  async #flush(): Promise<void> {
    if (this.#stopped) {
      return;
    }
    let failed = false;
    try {
      for (const [key, pending] of [...this.#pending]) {
        if (
          this.#pending.get(key) !== pending ||
          this.#generations.get(key) !== pending.generation
        ) {
          continue;
        }
        try {
          if (await this.#ledger.findByRequest(pending.turnId, "assistant")) {
            this.#pending.delete(key);
            this.#generations.delete(key);
            continue;
          }
          await this.#ledger.markRequestFailed(
            pending.turnId,
            pending.contextEpoch.id,
            this.#now(),
          );
          this.#pending.delete(key);
          this.#generations.delete(key);
          recordTestTrace("realtime.failure_state.recovered", { turnId: pending.turnId });
        } catch (error) {
          failed = true;
          recordTestTrace("realtime.failure_state.failed", {
            error: error instanceof Error ? error.message : "unknown",
            turnId: pending.turnId,
          });
        }
      }
    } finally {
      this.#currentRetryDelayMs = failed
        ? Math.min(this.#currentRetryDelayMs * 2, this.#maximumRetryDelayMs)
        : this.#baseRetryDelayMs;
      this.#scheduleFlush();
    }
  }

  #scheduleFlush(): void {
    if (this.#stopped || this.#timer || this.#pending.size === 0) {
      return;
    }
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.#enqueue(() => this.#flush());
    }, this.#currentRetryDelayMs);
    this.#timer.unref();
  }

  #enqueue<T>(work: () => Promise<T>): Promise<T> {
    const operation = this.#operationQueue.then(work, work);
    this.#operationQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }
}

function canonicalId(value: string): string {
  return value.toLowerCase();
}
