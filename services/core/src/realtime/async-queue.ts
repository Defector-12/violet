interface Waiter<T> {
  readonly reject: (error: unknown) => void;
  readonly resolve: (value: T | undefined) => void;
}

export class AsyncQueue<T> {
  readonly #values: T[] = [];
  readonly #waiters: Waiter<T>[] = [];
  #closed = false;
  #failed = false;
  #failure: unknown;

  close(): void {
    if (this.#closed || this.#failed) {
      return;
    }
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) {
      waiter.resolve(undefined);
    }
  }

  fail(error: unknown): void {
    if (this.#closed || this.#failed) {
      return;
    }
    this.#failed = true;
    this.#failure = error;
    for (const waiter of this.#waiters.splice(0)) {
      waiter.reject(error);
    }
  }

  next(signal?: AbortSignal): Promise<T | undefined> {
    const value = this.#values.shift();
    if (value !== undefined) {
      return Promise.resolve(value);
    }
    if (this.#failed) {
      return Promise.reject(this.#failure);
    }
    if (this.#closed || signal?.aborted) {
      return Promise.resolve(undefined);
    }
    return new Promise((resolve, reject) => {
      const waiter: Waiter<T> = {
        reject: (error) => {
          cleanup();
          reject(error);
        },
        resolve: (nextValue) => {
          cleanup();
          resolve(nextValue);
        },
      };
      const onAbort = () => {
        const index = this.#waiters.indexOf(waiter);
        if (index >= 0) {
          this.#waiters.splice(index, 1);
        }
        waiter.resolve(undefined);
      };
      const cleanup = () => {
        signal?.removeEventListener("abort", onAbort);
      };
      this.#waiters.push(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
      }
    });
  }

  async nextRequired(signal?: AbortSignal): Promise<T> {
    const value = await this.next(signal);
    if (value === undefined) {
      throw abortReason(signal);
    }
    return value;
  }

  push(value: T): void {
    if (this.#closed || this.#failed) {
      return;
    }
    const waiter = this.#waiters.shift();
    if (waiter) {
      waiter.resolve(value);
    } else {
      this.#values.push(value);
    }
  }
}

export function abortReason(signal: AbortSignal | undefined): Error {
  return signal?.reason instanceof Error ? signal.reason : new Error("Operation aborted");
}

export function timeoutSignal(parent: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return parent ? AbortSignal.any([parent, timeout]) : timeout;
}
