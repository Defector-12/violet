import type { ContextEpoch, ConversationLedger } from "@violet/domain";

import { recordTestTrace } from "./test-trace.js";

interface PendingFailure {
  readonly contextEpoch: ContextEpoch;
  readonly generation: number;
  readonly turnId: string;
}

export interface RealtimeTurnFailureRecoveryPort {
  start(turnId: string): Promise<number | null>;
  reopen(turnId: string): Promise<number | null>;
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
  readonly #shutdownTimeoutMs: number;
  #currentRetryDelayMs: number;
  #nextGeneration = 1;
  #operationQueue = Promise.resolve();
  #stopped = false;
  #stopping = false;
  #timer: NodeJS.Timeout | undefined;

  constructor(options: {
    readonly ledger: ConversationLedger;
    readonly now?: () => Date;
    readonly retryDelayMs?: number;
    readonly maximumRetryDelayMs?: number;
    readonly shutdownTimeoutMs?: number;
  }) {
    this.#baseRetryDelayMs = options.retryDelayMs ?? 1_000;
    this.#currentRetryDelayMs = this.#baseRetryDelayMs;
    this.#ledger = options.ledger;
    this.#maximumRetryDelayMs = options.maximumRetryDelayMs ?? 30_000;
    this.#now = options.now ?? (() => new Date());
    this.#shutdownTimeoutMs = options.shutdownTimeoutMs ?? 5_000;
  }

  async start(turnId: string): Promise<number | null> {
    return this.#enqueue(async () => {
      if (this.#stopped || this.#stopping) {
        throw new Error("Realtime turn failure recovery is stopped");
      }
      const key = canonicalId(turnId);
      if (this.#generations.has(key)) {
        return null;
      }
      const generation = this.#nextGeneration++;
      this.#generations.set(key, generation);
      return generation;
    });
  }

  async reopen(turnId: string): Promise<number | null> {
    return this.#enqueue(async () => {
      if (this.#stopped || this.#stopping) {
        throw new Error("Realtime turn failure recovery is stopped");
      }
      const key = canonicalId(turnId);
      const pending = this.#pending.has(key);
      const cleared = await this.#ledger.clearRequestFailure(turnId);
      if (!pending && !cleared) {
        return null;
      }
      const generation = this.#nextGeneration++;
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
      this.#pending.set(key, { contextEpoch, generation, turnId });
      if (this.#stopping) {
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
          if (this.#stopping) {
            return;
          }
        }
      }
      this.#scheduleFlush();
    });
  }

  async stop(): Promise<void> {
    if (this.#stopped || this.#stopping) {
      await this.#operationQueue;
      return;
    }
    this.#stopping = true;
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    const drain = this.#enqueue(async () => {
      if (this.#timer) {
        clearTimeout(this.#timer);
        this.#timer = undefined;
      }
      for (let attempt = 0; attempt < 3 && this.#pending.size > 0; attempt += 1) {
        await this.#flushPending();
      }
      this.#stopped = true;
    });
    let drainError: unknown;
    try {
      await withTimeout(() => drain, this.#shutdownTimeoutMs);
    } catch (error) {
      drainError = error;
      this.#stopped = true;
    }
    const pendingCount =
      drainError instanceof ShutdownTimeoutError
        ? Math.max(1, new Set([...this.#pending.keys(), ...this.#generations.keys()]).size)
        : this.#pending.size;
    this.#pending.clear();
    this.#generations.clear();
    if (pendingCount > 0) {
      throw new Error(`Could not persist ${pendingCount} realtime turn failure marker(s)`);
    }
    if (drainError) {
      throw drainError;
    }
  }

  async #flush(): Promise<void> {
    if (this.#stopped) {
      return;
    }
    const failed = await this.#flushPending();
    this.#currentRetryDelayMs = failed
      ? Math.min(this.#currentRetryDelayMs * 2, this.#maximumRetryDelayMs)
      : this.#baseRetryDelayMs;
    this.#scheduleFlush();
  }

  async #flushPending(): Promise<boolean> {
    let failed = false;
    for (const [key, pending] of [...this.#pending]) {
      if (this.#pending.get(key) !== pending || this.#generations.get(key) !== pending.generation) {
        continue;
      }
      try {
        const assistant = await this.#ledger.findByRequest(pending.turnId, "assistant");
        if (this.#stopped) {
          return true;
        }
        if (assistant) {
          this.#pending.delete(key);
          this.#generations.delete(key);
          continue;
        }
        await this.#ledger.markRequestFailed(pending.turnId, pending.contextEpoch.id, this.#now());
        if (this.#stopped) {
          return true;
        }
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
    return failed;
  }

  #scheduleFlush(): void {
    if (this.#stopped || this.#stopping || this.#timer || this.#pending.size === 0) {
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

class ShutdownTimeoutError extends Error {}

async function withTimeout(work: () => Promise<void>, timeoutMs: number): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;
  await Promise.race([
    work(),
    new Promise<void>((_, reject) => {
      timeout = setTimeout(
        () => reject(new ShutdownTimeoutError("Realtime turn failure recovery shutdown timed out")),
        timeoutMs,
      );
    }),
  ]).finally(() => {
    if (timeout) {
      clearTimeout(timeout);
    }
  });
}
