import { MemorySourceError } from "@violet/domain";
import { recordTestTrace } from "../realtime/test-trace.js";
import type { MemoryService } from "./memory-service.js";

/** One runner per Core lease; PostgreSQL owns progress across process restarts. */
export class MemoryJobRunner {
  readonly #memory: MemoryService;
  readonly #timeoutMs: number;
  readonly #stop = new AbortController();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #pending: Promise<boolean> | undefined;

  constructor(memory: MemoryService, timeoutMs = 30_000) {
    this.#memory = memory;
    this.#timeoutMs = timeoutMs;
  }

  async start(): Promise<void> {
    await this.#memory.repository.recoverJobs();
    this.#schedule();
  }

  runOnce(): Promise<boolean> {
    if (this.#pending) return this.#pending;
    this.#pending = this.#runOnce().finally(() => {
      this.#pending = undefined;
    });
    return this.#pending;
  }

  async stop(): Promise<void> {
    this.#stop.abort();
    clearTimeout(this.#timer);
    await this.#pending;
  }

  #schedule(): void {
    if (this.#stop.signal.aborted) return;
    this.#timer = setTimeout(() => {
      void this.runOnce()
        .catch(() => recordTestTrace("memory.automatic.poll_failed", {}))
        .finally(() => this.#schedule());
    }, 1_000);
    this.#timer.unref();
  }

  async #runOnce(): Promise<boolean> {
    if (this.#stop.signal.aborted) return false;
    const job = await this.#memory.repository.claimJob();
    if (!job) return false;
    if (this.#stop.signal.aborted) return true; // Recovered at next startup.
    const signal = AbortSignal.any([this.#stop.signal, AbortSignal.timeout(this.#timeoutMs)]);
    let onAbort: (() => void) | undefined;
    try {
      // Bound even a provider that ignores cancellation; the commit checks signal again.
      await Promise.race([
        this.#memory.processAutomaticJob(job, signal),
        new Promise<never>((_resolve, reject) => {
          onAbort = () => reject(signal.reason);
          signal.addEventListener("abort", onAbort, { once: true });
          if (signal.aborted) onAbort();
        }),
      ]);
    } catch (error) {
      if (!this.#stop.signal.aborted) {
        const expired = error instanceof MemorySourceError;
        await this.#memory.repository.finishJob(
          job,
          expired ? "skipped" : "retry",
          expired ? "source_changed" : signal.aborted ? "timeout" : "extraction_failed",
        );
      }
      recordTestTrace("memory.automatic.attempt_failed", {
        requestId: job.requestId,
        attempt: job.attempt,
        code: this.#stop.signal.aborted
          ? "interrupted"
          : signal.aborted
            ? "timeout"
            : "extraction_failed",
      });
    } finally {
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
    return true;
  }
}
