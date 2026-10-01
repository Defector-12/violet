import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { EnvelopeCipher } from "@violet/crypto";
import type { LedgerMessage, Memory, MemoryKind, ModelGateway } from "@violet/domain";
import { Pool } from "pg";
import { ContextEpochManager } from "../conversation/context-epoch-manager.js";
import { DeepSeekModelGateway } from "../model/deepseek-model-gateway.js";
import { PostgresConversationLedger } from "../storage/postgres-conversation-ledger.js";
import { PostgresMemoryRepository } from "../storage/postgres-memory-repository.js";
import { initializeTestExtensions } from "../storage/postgres-test-database.js";
import { proposeMemory } from "./memory-proposal.js";
import { MemoryService } from "./memory-service.js";

interface Fixture {
  id: string;
  group: "write" | "correct" | "delete" | "negative" | "history" | "irrelevant" | "ordinary";
  input: string;
  content?: string;
  kind?: MemoryKind;
  query?: string;
  target?: string;
  sensitivity?: "controlled";
  origin?: "secret" | "assistant" | "tool" | "visual" | "cancelled";
  untrusted?: string;
}

export async function loadMemoryFixtures(): Promise<Fixture[]> {
  // Use the source fixture from source and dist; tsc does not copy JSONL assets.
  const text = await readFile(
    new URL("../../src/memory/fixtures/release-1d-memory.jsonl", import.meta.url),
    "utf8",
  );
  const all: Fixture[] = text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(new Set(all.map((fixture) => fixture.id)).size, all.length);
  const fixtures = all.filter((fixture) => String(fixture.group) !== "automatic");
  for (const [group, count] of Object.entries({
    write: 40,
    correct: 10,
    delete: 20,
    negative: 20,
    history: 50,
    irrelevant: 20,
    ordinary: 20,
  })) {
    assert.equal(fixtures.filter((fixture) => fixture.group === group).length, count, group);
  }
  for (const fixture of fixtures) {
    assert.ok(fixture.input);
    if (fixture.target) assert.ok(fixtures.some((other) => other.id === fixture.target));
    if (fixture.group === "write" || fixture.group === "correct") {
      assert.ok(fixture.content && fixture.input.includes(fixture.content));
      assert.ok(fixture.kind);
    }
    if (fixture.group === "history" || fixture.group === "irrelevant") assert.ok(fixture.query);
  }
  return fixtures;
}

function emit(type: string, data: Record<string, unknown>) {
  console.log(JSON.stringify({ schemaVersion: 1, type, ...data }));
}

export function distribution(values: readonly number[]) {
  assert.ok(values.length > 0 && values.every(Number.isFinite));
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p: number) => sorted[Math.ceil(p * sorted.length) - 1] ?? 0;
  return {
    count: values.length,
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
    max: sorted.at(-1),
  };
}

export async function database() {
  const connectionString = process.env["VIOLET_TEST_DATABASE_URL"];
  assert.ok(connectionString, "VIOLET_TEST_DATABASE_URL is required (isolated local PostgreSQL)");
  const address = new URL(connectionString);
  assert.ok(
    ["localhost", "127.0.0.1", "[::1]"].includes(address.hostname),
    "Evaluation only creates schemas in a local test database",
  );
  const schema = `violet_eval_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString, max: 1 });
  const pool = new Pool({ connectionString, max: 2, options: `-c search_path=${schema},public` });
  const close = async () => {
    await pool.end();
    try {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      await admin.end();
    }
  };
  try {
    await initializeTestExtensions(admin);
    await admin.query(`CREATE SCHEMA "${schema}"`);
    for (const migration of [
      "0001_violet_seed.sql",
      "0002_context_checkpoints.sql",
      "0002b_context_turn_failures.sql",
      "0002c_context_event_ids.sql",
      "0003_explicit_memory.sql",
      "0004_memory_jobs.sql",
    ]) {
      await pool.query(
        await readFile(
          new URL(`../../../../infra/migrations/${migration}`, import.meta.url),
          "utf8",
        ),
      );
    }
    const cipher = new EnvelopeCipher({ key: randomBytes(32), keyVersion: "synthetic-eval-v1" });
    const ledger = new PostgresConversationLedger({
      cipher,
      pool,
      instanceId: randomUUID(),
      constitutionVersion: "synthetic-eval",
    });
    const repository = new PostgresMemoryRepository({ cipher, pool });
    const epochs = new ContextEpochManager({ generateId: randomUUID });
    const makeService = (model?: ModelGateway) =>
      new MemoryService({
        repository,
        ledger,
        epochManager: epochs,
        ...(model ? { model } : {}),
      });
    async function source(content: string, role: "user" | "assistant" = "user") {
      const occurredAt = new Date("2026-09-01T12:00:00Z");
      return ledger.append({
        content,
        role,
        occurredAt,
        id: randomUUID(),
        requestId: randomUUID(),
        contextEpoch: epochs.acceptUserInput(occurredAt),
      });
    }
    async function complete(message: LedgerMessage, automaticMemoryEligible = false) {
      return ledger.append({
        content: "Synthetic completion.",
        role: "assistant",
        id: randomUUID(),
        requestId: message.requestId,
        occurredAt: message.occurredAt,
        automaticMemoryEligible,
      });
    }
    return { pool, ledger, repository, makeService, source, complete, close };
  } catch (error) {
    await close();
    throw error;
  }
}

function proposalGateway(fixture: Fixture): ModelGateway {
  return {
    async *stream() {
      yield {
        type: "delta",
        content: JSON.stringify(
          fixture.group === "write"
            ? {
                intent: "write",
                writes: [{ content: fixture.content, quote: fixture.content, kind: fixture.kind }],
              }
            : { intent: "none", history: false },
        ),
      };
      yield { type: "complete", inputTokens: 0, outputTokens: 0 };
    },
  };
}

export async function evaluateLocal(fixtures: Fixture[]) {
  const db = await database();
  const service = db.makeService();
  const memories = new Map<string, Memory>();
  const sources = new Map<string, LedgerMessage>();
  const outcomes: { id: string; passed: boolean }[] = [];
  let historyHits = 0;
  let currentHits = 0;
  let unrelatedHits = 0;
  async function trial(fixture: Fixture, operation: () => Promise<unknown>) {
    const started = performance.now();
    emit("local-case-start", {
      id: fixture.id,
      ...(fixture.origin === "secret"
        ? { input: "[synthetic secret withheld]" }
        : { input: fixture.input }),
    });
    try {
      const evidence = await operation();
      outcomes.push({ id: fixture.id, passed: true });
      emit("local-case", {
        id: fixture.id,
        passed: true,
        elapsedMs: performance.now() - started,
        evidence,
      });
    } catch (error) {
      outcomes.push({ id: fixture.id, passed: false });
      emit("local-case", {
        id: fixture.id,
        passed: false,
        elapsedMs: performance.now() - started,
        error: error instanceof Error ? error.message : "unknown",
      });
    }
  }
  try {
    for (const fixture of fixtures.filter((item) => item.group === "write")) {
      await trial(fixture, async () => {
        const source = await db.source(fixture.input);
        sources.set(fixture.id, source);
        const writing = db.makeService(proposalGateway(fixture));
        const result = await writing.prepareTurn(source);
        assert.equal(result.changes.length, 1);
        assert.deepEqual(await writing.prepareTurn(source), result);
        const stored = (await db.repository.get(result.changes[0]?.id ?? ""))[0];
        assert.ok(stored);
        assert.equal(stored.content, fixture.content);
        const citation = stored.sources[0];
        assert.ok(citation);
        assert.equal(citation.eventId, source.id);
        assert.equal(
          Buffer.from(source.content).subarray(citation.startByte, citation.endByte).toString(),
          fixture.content,
        );
        memories.set(fixture.id, stored);
        await db.complete(source);
        return { requestId: source.requestId, eventId: source.id, result, stored };
      });
    }
    // Restart the service objects, retaining only encrypted PostgreSQL and the synthetic key.
    const restarted = db.makeService();
    for (const fixture of fixtures.filter((item) => item.group === "write" && item.query)) {
      const result = await restarted.recall({ query: fixture.query ?? "" }, false);
      const hit = result.items.some((item) => item.id === memories.get(fixture.id)?.id);
      currentHits += Number(hit);
      emit("current-recall", { id: fixture.id, query: fixture.query, hit, result });
    }
    for (const fixture of fixtures.filter((item) => item.group === "history")) {
      const source = await db.source(fixture.content ?? "");
      sources.set(fixture.id, source);
      await db.complete(source);
    }
    for (const fixture of fixtures.filter(
      (item) => item.group === "history" || item.group === "irrelevant",
    )) {
      await trial(fixture, async () => {
        const result = await service.recall(
          { query: fixture.query ?? "", from: "2026-09-01T00:00:00Z", to: "2026-09-02T00:00:00Z" },
          true,
        );
        assert.ok(result.items.length <= 5);
        if (fixture.group === "history") {
          const hit = result.items.some((item) =>
            item.sourceEventIds.includes(sources.get(fixture.id)?.id ?? ""),
          );
          historyHits += Number(hit);
          return { hit, result, expectedSourceEventId: sources.get(fixture.id)?.id };
        }
        unrelatedHits += Number(result.items.length > 0);
        return { result };
      });
    }
    for (const fixture of fixtures.filter(
      (item) => item.group === "ordinary" || item.group === "negative",
    )) {
      await trial(fixture, async () => {
        const revision = (await db.repository.state()).revision;
        if (fixture.origin === "secret") {
          const source: LedgerMessage = {
            content: fixture.input,
            role: "user",
            id: randomUUID(),
            requestId: randomUUID(),
            sequence: 0,
            occurredAt: new Date(),
          };
          await assert.rejects(service.prepareTurn(source), { name: "MemorySecretError" });
        } else if (fixture.group === "ordinary") {
          const source = await db.source(fixture.input);
          const result = await db.makeService(proposalGateway(fixture)).prepareTurn(source);
          assert.equal(result.changes.length, 0);
          await db.complete(source);
        } else {
          const source = await db.source(
            fixture.input,
            fixture.origin === "assistant" ? "assistant" : "user",
          );
          if (fixture.origin === "cancelled") {
            assert.ok(source.contextEpochId);
            await db.ledger.markRequestFailed(source.requestId, source.contextEpochId, new Date());
          }
          const quote = fixture.untrusted ?? fixture.input;
          await assert.rejects(
            db.repository.write({
              requestId: source.requestId,
              sourceEventId: source.id,
              expectedRevision: revision,
              writes: [
                {
                  content: quote,
                  kind: "fact",
                  sensitivity: "normal",
                  source: {
                    eventId: source.id,
                    startByte: 0,
                    endByte: Buffer.byteLength(quote),
                    quote,
                  },
                },
              ],
            }),
            { name: "MemorySourceError" },
          );
        }
        assert.equal((await db.repository.state()).revision, revision);
        return { unchangedRevision: revision };
      });
    }
    for (const fixture of fixtures.filter((item) => item.group === "correct")) {
      await trial(fixture, async () => {
        const previous = memories.get(fixture.target ?? "");
        assert.ok(previous);
        const input = {
          requestId: randomUUID(),
          expectedVersion: previous.version,
          content: fixture.input,
        };
        const changes = await service.correct(previous.id, input);
        assert.deepEqual(await service.correct(previous.id, input), changes);
        const versions = await db.repository.get(previous.id);
        assert.equal(versions[0]?.version, previous.version + 1);
        assert.equal(versions[1]?.state, "superseded");
        const current = versions[0];
        assert.ok(current);
        memories.set(fixture.target ?? "", current);
        const result = await db.makeService().recall({ query: fixture.query ?? "" }, true);
        assert.ok(
          result.items.some((item) => item.id === previous.id && item.version === current.version),
        );
        assert.ok(
          result.items.every(
            (item) =>
              !item.sourceEventIds.some((id) => previous.sources.some((old) => old.eventId === id)),
          ),
        );
        return { requestId: input.requestId, changes, versions, result };
      });
    }
    for (const fixture of fixtures.filter((item) => item.group === "delete")) {
      await trial(fixture, async () => {
        const target = memories.get(fixture.target ?? "");
        const source = sources.get(fixture.target ?? "");
        assert.ok(target && source);
        const preview = await service.preview({
          id: randomUUID(),
          target: {
            kind: "memory",
            id: target.id,
            version: target.version,
          },
        });
        const confirmation = {
          instanceId: preview.instanceId,
          minimumRestoreEpoch: preview.nextRestoreEpoch,
        };
        const status = await service.confirm(preview.id, confirmation, "synthetic-eval");
        assert.deepEqual(await service.confirm(preview.id, confirmation, "synthetic-eval"), status);
        assert.equal((await db.repository.get(target.id)).length, 0);
        assert.equal(await db.ledger.findByRequest(source.requestId, "user"), null);
        assert.equal(await db.ledger.findByRequest(source.requestId, "assistant"), null);
        await assert.rejects(
          db.repository.write({
            requestId: source.requestId,
            sourceEventId: source.id,
            expectedRevision: (await db.repository.state()).revision,
            writes: [
              {
                content: source.content,
                kind: "fact",
                sensitivity: "normal",
                source: {
                  eventId: source.id,
                  startByte: 0,
                  endByte: Buffer.byteLength(source.content),
                  quote: source.content,
                },
              },
            ],
          }),
          { name: "MemorySourceError" },
        );
        const result = await service.recall({ query: target.content }, true);
        assert.ok(
          result.items.every(
            (item) =>
              item.id !== target.id &&
              !item.sourceEventIds.some((id) => preview.eventIds.includes(id)),
          ),
        );
        return { deletionId: preview.id, deletedEventIds: preview.eventIds, status, result };
      });
    }
    const currentCount = fixtures.filter((item) => item.group === "write" && item.query).length;
    const summary = {
      modelCalls: 0,
      evaluation: "deterministic-proposals-real-postgres",
      cases: outcomes.length,
      failed: outcomes.filter((item) => !item.passed),
      current: { hits: currentHits, count: currentCount },
      history: { hits: historyHits, count: 50 },
      unrelated: { found: unrelatedHits, count: 20 },
      passed:
        outcomes.length === fixtures.length &&
        outcomes.every((item) => item.passed) &&
        currentHits / currentCount >= 0.8 &&
        historyHits >= 45 &&
        unrelatedHits <= 1,
    };
    emit("local-summary", summary);
    return summary.passed;
  } finally {
    await db.close();
  }
}

export async function benchmarkMemory() {
  let passed = true;
  for (const scale of [1, 10]) {
    const db = await database();
    try {
      const service = db.makeService();
      const turns = 500 * scale;
      const memoryCount = 100 * scale;
      emit("benchmark-seed", { scale, turns, memoryCount });
      for (let index = 0; index < turns; index++) {
        const content = `Synthetic observatory log ${index}: telescope calibration and lunar photographs.`;
        const source = await db.source(content);
        if (index < memoryCount) {
          await db.repository.write({
            requestId: source.requestId,
            sourceEventId: source.id,
            expectedRevision: (await db.repository.state()).revision,
            writes: [
              {
                content,
                kind: "fact",
                sensitivity: "normal",
                source: {
                  eventId: source.id,
                  startByte: 0,
                  endByte: Buffer.byteLength(content),
                  quote: content,
                },
              },
            ],
          });
        }
        await db.complete(source);
      }
      for (const history of [false, true]) {
        const elapsed: number[] = [];
        for (let attempt = 1; attempt <= 50; attempt++) {
          const query = attempt % 2 ? "telescope calibration" : "unmentioned-submarine";
          const started = performance.now();
          const result = await service.recall({ query }, history);
          const elapsedMs = performance.now() - started;
          elapsed.push(elapsedMs);
          emit("benchmark-trial", {
            scale,
            history,
            attempt,
            query,
            elapsedMs,
            status: result.status,
          });
        }
        const stats = distribution(elapsed);
        passed &&= stats.p95 <= 300;
        emit("benchmark-summary", {
          scale,
          events: turns * 2,
          memories: memoryCount,
          history,
          milliseconds: stats,
          passed: stats.p95 <= 300,
          scope:
            "MemoryService.recall including PostgreSQL, decryption, filtering and revision recheck; all samples, no discarded warmup",
        });
      }
    } finally {
      await db.close();
    }
  }
  return passed;
}

// This collector deliberately leaves semantic judgment to a reviewer. It never reports model
// quality as passed merely because a response parsed or contains an expected word.
async function collectModelProposals(
  fixtures: Fixture[],
  maximumAttempts: number,
  budgetCny: number,
) {
  assert.ok(
    Number.isSafeInteger(maximumAttempts) && maximumAttempts > 0 && maximumAttempts <= 2000,
    "--model requires --max-provider-attempts=1..2000 after cost approval",
  );
  const apiKey = process.env["DEEPSEEK_API_KEY"];
  assert.ok(apiKey, "DEEPSEEK_API_KEY is required");
  assert.ok(
    Number.isFinite(budgetCny) && budgetCny > 0 && budgetCny <= 100,
    "--model requires an explicit --budget-cny=0..100",
  );
  // Official peak CNY rates checked 2026-09-21; assume all input misses the cache.
  const cost = (input: number, output: number) => (input * 2 + output * 8) / 1_000_000;
  let chargedUpperCny = 0;
  let inputUpper = 0;
  let outputUpper = 0;
  let lastReservation = 0;
  let attempts = 0;
  let activeRequestId = "";
  const delegate = new DeepSeekModelGateway({
    apiKey,
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-flash",
    userId: "violet-memory-eval",
    fetch: async (input, init) => {
      const reservation = cost(inputUpper, outputUpper);
      if (chargedUpperCny + reservation > budgetCny)
        throw new Error("Evaluation cost limit reached");
      if (++attempts > maximumAttempts)
        throw new Error("Authorized provider attempt limit reached");
      chargedUpperCny += reservation;
      lastReservation = reservation;
      emit("provider-attempt", { attempt: attempts, requestId: activeRequestId, chargedUpperCny });
      try {
        const response = await fetch(input, init);
        emit("provider-status", {
          attempt: attempts,
          requestId: activeRequestId,
          status: response.status,
        });
        return response;
      } catch {
        emit("provider-error", { attempt: attempts, requestId: activeRequestId });
        throw new Error("Provider transport failed");
      }
    },
  });
  const model: ModelGateway = {
    contextProfile: delegate.contextProfile,
    async *stream(request, signal) {
      inputUpper = delegate.contextProfile.estimateTokens(request.messages);
      outputUpper = request.maximumOutputTokens ?? Infinity;
      assert.ok(inputUpper <= 12_000);
      assert.ok((request.maximumOutputTokens ?? Infinity) <= 4096);
      activeRequestId = request.requestId;
      // The generic recorder masks credential-like *token* keys. Keep numeric model usage
      // under neutral labels without weakening that credential redaction policy.
      const { maximumOutputTokens, ...sent } = request;
      emit("proposal-send", { request: sent, outputLimit: maximumOutputTokens, unit: "tokens" });
      let text = "";
      try {
        for await (const event of delegate.stream(request, signal)) {
          if (event.type === "delta") text += event.content;
          else {
            // Failed HTTP attempts retain their full reservation; only this successful attempt
            // is reconciled against provider usage. Missing usage also retains the reservation.
            if (event.inputTokens > 0 && event.outputTokens > 0) {
              chargedUpperCny += cost(event.inputTokens, event.outputTokens) - lastReservation;
            }
            emit("proposal-usage", {
              requestId: request.requestId,
              input: event.inputTokens,
              output: event.outputTokens,
              unit: "tokens",
              chargedUpperCny,
            });
          }
          yield event;
        }
      } finally {
        emit("proposal-receive", { requestId: request.requestId, text });
      }
    },
  };
  const candidates = fixtures
    .filter((fixture) => fixture.group === "write")
    .map(
      (fixture): Memory => ({
        id: randomUUID(),
        version: 1,
        state: "current",
        origin: "explicit",
        content: fixture.content ?? "",
        kind: fixture.kind ?? "fact",
        sensitivity: fixture.sensitivity ?? "normal",
        sources: [],
        createdAt: "2026-09-01T00:00:00Z",
        updatedAt: "2026-09-01T00:00:00Z",
      }),
    );
  const writeFixtures = fixtures.filter((fixture) => fixture.group === "write");
  const correctedCandidates = candidates.map((candidate, index) => {
    const correction = fixtures.find(
      (fixture) => fixture.group === "correct" && fixture.target === writeFixtures[index]?.id,
    );
    return correction ? { ...candidate, version: 2, content: correction.input } : candidate;
  });
  for (const fixture of fixtures) {
    for (let trial = 1; trial <= 3; trial++) {
      if (attempts >= maximumAttempts) throw new Error("Authorized provider attempt limit reached");
      if (chargedUpperCny + cost(12_000, 4096) > budgetCny)
        throw new Error("Evaluation cost limit reached");
      const source: LedgerMessage = {
        id: randomUUID(),
        requestId: randomUUID(),
        role: "user",
        sequence: 1,
        content: fixture.input,
        occurredAt: new Date("2026-09-01T00:00:00Z"),
      };
      const started = performance.now();
      // Independent trials use known setup, not a preceding model's unreviewed proposal.
      const context =
        fixture.group === "write"
          ? []
          : fixture.group === "delete"
            ? correctedCandidates
            : candidates;
      const controller = new AbortController();
      if (fixture.origin === "cancelled") controller.abort();
      emit("proposal-case-start", {
        id: fixture.id,
        trial,
        requestId: source.requestId,
        eventId: source.id,
        expected: fixture,
        target: context[writeFixtures.findIndex((item) => item.id === fixture.target)],
      });
      try {
        controller.signal.throwIfAborted();
        const proposal = await proposeMemory(
          model,
          source,
          context,
          AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]),
        );
        emit("proposal-case", {
          id: fixture.id,
          trial,
          proposal,
          elapsedMs: performance.now() - started,
          semanticVerdict: "requires_review",
        });
      } catch (error) {
        emit("proposal-case", {
          id: fixture.id,
          trial,
          elapsedMs: performance.now() - started,
          error: error instanceof Error ? error.message : "unknown",
          semanticVerdict: "requires_review",
        });
      }
    }
  }
  emit("proposal-summary", {
    attempts,
    budgetCny,
    chargedUpperCny,
    semanticVerdict: "requires_review",
    scope:
      "Intent and proposal collection only; end-to-end tool answering and Qwen audio require separate acceptance",
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--automatic")) {
    const { automaticMain } = await import("./eval-automatic-memory.js");
    await automaticMain(args.filter((arg) => arg !== "--automatic"));
    return;
  }
  const fixtures = await loadMemoryFixtures();
  assert.ok(
    args.every(
      (arg) =>
        ["--model", "--local", "--benchmark", "--plan"].includes(arg) ||
        /^--max-provider-attempts=\d+$/.test(arg) ||
        /^--budget-cny=\d+(?:\.\d+)?$/.test(arg),
    ),
    "Unknown evaluation argument",
  );
  if (args.includes("--plan")) {
    emit("evaluation-plan", {
      cases: fixtures.length,
      trialsPerModelCase: 3,
      maximumLogicalCalls: fixtures.length * 3,
      maximumProviderAttempts: fixtures.length * 9,
      inputLimitPerCall: 12_000,
      outputLimitPerCall: 4096,
      unit: "tokens",
      modelCalls: 0,
      semanticVerdict: "requires_review",
      fixtureGroups: Object.fromEntries(
        [...new Set(fixtures.map((fixture) => fixture.group))].map((group) => [
          group,
          fixtures.filter((fixture) => fixture.group === group).length,
        ]),
      ),
    });
  } else if (args.includes("--model")) {
    await collectModelProposals(
      fixtures,
      Number(args.find((arg) => arg.startsWith("--max-provider-attempts="))?.split("=")[1]),
      Number(args.find((arg) => arg.startsWith("--budget-cny="))?.split("=")[1]),
    );
  } else if (args.includes("--benchmark")) {
    if (!(await benchmarkMemory())) process.exitCode = 1;
  } else {
    const localPassed = await evaluateLocal(fixtures);
    const performancePassed = await benchmarkMemory();
    if (!localPassed || !performancePassed) process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Finish module initialization before loading modes that reuse the database/statistics helpers.
  void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
