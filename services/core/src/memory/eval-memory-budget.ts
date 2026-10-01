import assert from "node:assert/strict";
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import type { ModelGateway } from "@violet/domain";
import { DeepSeekModelGateway } from "../model/deepseek-model-gateway.js";

// DeepSeek V4.1 Flash official peak CNY prices checked 2026-09-28.
// https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
// Ignore cache discounts; reserve full output on every HTTP attempt, including SDK retries.
export const modelCost = (input: number, output: number) => (input * 2 + output * 8) / 1_000_000;
export type EvaluationEmit = (type: string, data: Record<string, unknown>) => void;
type Reservation = { requestId: string; input: number; output: number; settled?: boolean };

/** Append and fsync before network I/O. A partial ledger or an abandoned lock fails closed. */
export class EvaluationBudget {
  readonly #path: string;
  readonly #lock: number;
  readonly #fd: number;
  readonly #reservations: Reservation[] = [];
  #charged = 0;
  #stopped = false;

  constructor(
    path: string,
    readonly maximumAttempts: number,
    readonly budgetCny: number,
  ) {
    assert.ok(
      Number.isSafeInteger(maximumAttempts) && maximumAttempts > 0 && maximumAttempts <= 2700,
    );
    assert.ok(Number.isFinite(budgetCny) && budgetCny > 0 && budgetCny <= 100);
    this.#path = path;
    this.#lock = openSync(`${path}.lock`, "wx", 0o600);
    try {
      const header = { type: "authorization", maximumAttempts, budgetCny, priceDate: "2026-09-28" };
      if (existsSync(path)) {
        const text = readFileSync(path, "utf8");
        assert.ok(text.endsWith("\n"), "Incomplete budget ledger; reconcile before resuming");
        const [saved, ...entries] = text
          .trimEnd()
          .split("\n")
          .map((line) => JSON.parse(line));
        assert.deepEqual(saved, header, "Existing authorization differs; never reset a run budget");
        for (const entry of entries) this.#apply(entry);
        this.#fd = openSync(path, "a", 0o600);
      } else {
        this.#fd = openSync(path, "wx", 0o600);
        this.#append(header);
      }
    } catch (error) {
      closeSync(this.#lock);
      unlinkSync(`${path}.lock`);
      throw error;
    }
  }

  get state() {
    return {
      attempts: this.#reservations.length,
      chargedUpperCny: this.#charged,
      maximumAttempts: this.maximumAttempts,
      budgetCny: this.budgetCny,
      unsettled: this.#reservations.filter((item) => !item.settled).length,
    };
  }

  get stopped() {
    return (
      this.#stopped ||
      this.#reservations.length >= this.maximumAttempts ||
      this.#charged >= this.budgetCny
    );
  }

  reserve(requestId: string, input: number, output: number): number {
    assert.ok([input, output].every((value) => Number.isSafeInteger(value) && value > 0));
    if (
      this.#reservations.length >= this.maximumAttempts ||
      this.#charged + modelCost(input, output) > this.budgetCny
    ) {
      this.#stopped = true;
    }
    assert.ok(
      this.#reservations.length < this.maximumAttempts,
      "Authorized provider attempt limit reached",
    );
    assert.ok(
      this.#charged + modelCost(input, output) <= this.budgetCny,
      "Authorized model cost limit reached",
    );
    assert.ok(!this.#stopped, "Evaluation budget halted");
    const entry = {
      type: "reserve",
      attempt: this.#reservations.length + 1,
      requestId,
      input,
      output,
    };
    this.#append(entry);
    this.#apply(entry);
    return entry.attempt;
  }

  settle(attempt: number, input: number, output: number): void {
    // Missing usage retains the full reservation; errors never receive speculative refunds.
    if (![input, output].every((value) => Number.isSafeInteger(value) && value > 0)) return;
    const reservation = this.#reservations[attempt - 1];
    assert.ok(reservation && !reservation.settled, "Unknown or already settled attempt");
    const entry = { type: "settle", attempt, input, output };
    this.#append(entry);
    this.#apply(entry);
    if (input > reservation.input || output > reservation.output) this.#stopped = true;
    assert.ok(
      input <= reservation.input && output <= reservation.output,
      "Provider usage exceeded reserved bounds",
    );
  }

  close(): void {
    closeSync(this.#fd);
    closeSync(this.#lock);
    unlinkSync(`${this.#path}.lock`);
  }

  #append(entry: object) {
    const bytes = Buffer.from(`${JSON.stringify(entry)}\n`);
    assert.equal(writeSync(this.#fd, bytes), bytes.length);
    fsyncSync(this.#fd);
  }

  #apply(entry: {
    type: string;
    attempt: number;
    input: number;
    output: number;
    requestId?: string;
  }) {
    assert.ok(
      [entry.input, entry.output].every((value) => Number.isSafeInteger(value) && value > 0),
    );
    if (entry.type === "reserve") {
      assert.equal(entry.attempt, this.#reservations.length + 1);
      assert.ok(entry.requestId);
      this.#reservations.push({
        requestId: entry.requestId,
        input: entry.input,
        output: entry.output,
      });
      this.#charged += modelCost(entry.input, entry.output);
    } else {
      assert.equal(entry.type, "settle");
      const previous = this.#reservations[entry.attempt - 1];
      assert.ok(previous && !previous.settled);
      previous.settled = true;
      this.#charged +=
        modelCost(entry.input, entry.output) - modelCost(previous.input, previous.output);
    }
  }
}

export function evaluationModel(
  apiKey: string,
  budget: EvaluationBudget,
  emit: EvaluationEmit,
  transport: typeof fetch = fetch,
): ModelGateway {
  return {
    async *stream(request, signal) {
      let attempt = 0;
      let text = "";
      const started = performance.now();
      // Scope the fetch closure to this stream: retries and delayed cancellation cannot borrow
      // another request's reservation, output or identity.
      const delegate = new DeepSeekModelGateway({
        apiKey,
        baseUrl: "https://api.deepseek.com",
        model: "deepseek-flash",
        userId: "violet-automatic-memory-eval",
        fetch: async (url, init) => {
          signal?.throwIfAborted();
          const input = delegate.contextProfile.estimateTokens(request.messages);
          const output = request.maximumOutputTokens ?? Infinity;
          assert.ok(input <= 12000 && output <= 4096);
          attempt = budget.reserve(request.requestId, input, output);
          assert.equal(typeof init?.body, "string");
          // Never copy headers. Rename the numeric field because the recorder masks token keys.
          const { max_tokens: outputLimit, ...body } = JSON.parse(String(init?.body));
          emit("automatic-provider-send", {
            requestId: request.requestId,
            attempt,
            body,
            outputLimit,
            inputUpper: input,
            ...budget.state,
          });
          try {
            const response = await transport(url, init);
            emit("automatic-provider-status", {
              requestId: request.requestId,
              attempt,
              status: response.status,
              providerRequestId: response.headers.get("x-request-id"),
            });
            return response;
          } catch {
            emit("automatic-provider-error", { requestId: request.requestId, attempt });
            throw new Error("Provider transport failed");
          }
        },
      });
      try {
        for await (const event of delegate.stream(request, signal)) {
          if (event.type === "delta") text += event.content;
          else {
            budget.settle(attempt, event.inputTokens, event.outputTokens);
            emit("automatic-provider-usage", {
              requestId: request.requestId,
              attempt,
              input: event.inputTokens,
              output: event.outputTokens,
              unit: "tokens",
              ...budget.state,
            });
          }
          yield event;
        }
      } catch (error) {
        emit("automatic-provider-failure", {
          requestId: request.requestId,
          attempt,
          error: error instanceof Error ? error.message : "unknown",
        });
        throw error;
      } finally {
        emit("automatic-provider-receive", {
          requestId: request.requestId,
          attempt,
          text,
          elapsedMs: performance.now() - started,
          aborted: signal?.aborted ?? false,
        });
      }
    },
  };
}
