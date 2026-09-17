import type { ContextEpoch } from "@violet/domain";

const defaultInactivityMs = 30 * 60 * 1000;

export class ContextEpochManager {
  readonly #generateId: () => string;
  readonly #inactivityMs: number;
  #active: { epoch: ContextEpoch; lastUserInputAt: Date } | null = null;

  constructor(options: { readonly generateId: () => string; readonly inactivityMs?: number }) {
    this.#generateId = options.generateId;
    this.#inactivityMs = options.inactivityMs ?? defaultInactivityMs;
  }

  acceptUserInput(at: Date): ContextEpoch {
    const current = this.current(at);
    if (current) {
      this.#active = { epoch: current, lastUserInputAt: new Date(at) };
      return current;
    }

    const epoch = {
      id: this.#generateId(),
      startedAt: new Date(at),
    };
    this.#active = { epoch, lastUserInputAt: new Date(at) };
    return epoch;
  }

  current(at: Date): ContextEpoch | null {
    if (!this.#active) {
      return null;
    }
    const idleMs = at.getTime() - this.#active.lastUserInputAt.getTime();
    if (idleMs >= this.#inactivityMs) {
      this.#active = null;
      return null;
    }
    return {
      id: this.#active.epoch.id,
      startedAt: new Date(this.#active.epoch.startedAt),
    };
  }
}
