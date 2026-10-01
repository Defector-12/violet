import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { LedgerMessage, Memory, MemoryKind, ModelGateway } from "@violet/domain";
import { classifyMemoryContent } from "@violet/policy";
import { deepSeekV41ContextProfile } from "../model/model-context.js";
import { automaticReview } from "./eval-automatic-review.js";
import { database } from "./eval-memory.js";
import { EvaluationBudget, evaluationModel, modelCost } from "./eval-memory-budget.js";
import { MemoryJobRunner } from "./memory-job-runner.js";
import { proposeMemory } from "./memory-proposal.js";

export interface AutomaticFixture {
  id: string;
  group: "automatic";
  category: string;
  input: string;
  expected: { content: string; quote: string; kind: MemoryKind; seed?: number }[];
  seeds?: { content: string; kind: MemoryKind }[];
  reason?: string;
}

export interface AutomaticEvidence {
  type: "automatic-case";
  mode: "model" | "local";
  id: string;
  trial: number;
  source: { id: string; requestId: string; content: string };
  seeds: readonly Memory[];
  stored: readonly Memory[];
  writes: readonly Memory[];
  job: { status: string; attempts: number; failure_code: string | null } | null;
  visibleMs: number | null;
  settledMs: number;
  error?: string;
}

const emit = (type: string, data: Record<string, unknown>) =>
  console.log(JSON.stringify({ schemaVersion: 1, type, ...data }));
const kinds = new Set(["fact", "preference", "goal", "relationship"]);
export const fixtureHash = (fixtures: AutomaticFixture[]) =>
  createHash("sha256").update(JSON.stringify(fixtures)).digest("hex");

export async function loadAutomaticFixtures(): Promise<AutomaticFixture[]> {
  const text = await readFile(
    new URL("../../src/memory/fixtures/release-1d-memory.jsonl", import.meta.url),
    "utf8",
  );
  const all = text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(new Set(all.map((item) => item.id)).size, all.length);
  const fixtures: AutomaticFixture[] = all.filter((item) => item.group === "automatic");
  assert.equal(fixtures.length, 100);
  assert.equal(fixtures.filter((item) => item.expected.length > 0).length, 60);
  for (const item of fixtures) {
    assert.ok(item.id && item.input && item.category);
    assert.ok(item.expected.length <= 8);
    assert.ok(item.expected.length || item.reason);
    for (const expected of item.expected) {
      assert.ok(expected.content && expected.quote && item.input.includes(expected.quote));
      assert.ok(kinds.has(expected.kind));
      if (expected.seed !== undefined) {
        assert.ok(Number.isSafeInteger(expected.seed) && expected.seed >= 0);
        assert.deepEqual(item.seeds?.[expected.seed], {
          content: expected.content,
          kind: expected.kind,
        });
      }
    }
    for (const seed of item.seeds ?? []) assert.ok(seed.content && kinds.has(seed.kind));
    if (item.category === "secret") assert.equal(classifyMemoryContent(item.input), "secret");
    if (item.category === "controlled")
      assert.equal(classifyMemoryContent(item.input), "controlled");
  }
  return fixtures;
}

function fixedModel(fixture: AutomaticFixture, seeds: readonly Memory[]): ModelGateway {
  return {
    async *stream() {
      yield {
        type: "delta",
        content: JSON.stringify(
          fixture.expected.length
            ? {
                intent: "write",
                writes: fixture.expected.map((expected) => ({
                  content: expected.content,
                  kind: expected.kind,
                  quote: expected.quote,
                  ...(expected.seed === undefined
                    ? {}
                    : {
                        targetId: seeds[expected.seed]?.id,
                        targetVersion: seeds[expected.seed]?.version,
                        action: "add_source",
                      }),
                })),
              }
            : { intent: "none", history: false },
        ),
      };
      yield { type: "complete", inputTokens: 0, outputTokens: 0 };
    },
  };
}

type EvaluationDatabase = Awaited<ReturnType<typeof database>>;
async function toggle(db: EvaluationDatabase, enabled: boolean) {
  return db.repository.updateSettings({
    requestId: randomUUID(),
    expectedRevision: (await db.repository.settings()).revision,
    enabled,
  });
}

async function seed(
  db: EvaluationDatabase,
  content: string,
  kind: MemoryKind,
  existingSource?: LedgerMessage,
) {
  const source = existingSource ?? (await db.source(content));
  assert.equal(source.content, content);
  const changes = await db.repository.write({
    requestId: source.requestId,
    sourceEventId: source.id,
    expectedRevision: (await db.repository.state()).revision,
    writes: [
      {
        content,
        kind,
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
  await db.complete(source);
  const memory = (await db.repository.get(changes[0]?.id ?? ""))[0];
  assert.ok(memory);
  return memory;
}

async function status(
  db: EvaluationDatabase,
  requestId: string,
): Promise<AutomaticEvidence["job"]> {
  const result = await db.pool.query(
    "SELECT status, attempts, failure_code FROM memory_jobs WHERE request_id = $1",
    [requestId],
  );
  return result.rows[0] ?? null;
}

function changed(memories: readonly Memory[], before: readonly Memory[]) {
  return memories.filter((memory) => {
    const old = before.find((item) => item.id === memory.id);
    return !old || JSON.stringify(old) !== JSON.stringify(memory);
  });
}

export async function collectAutomatic(
  fixtures: AutomaticFixture[],
  model?: ModelGateway,
  budget?: EvaluationBudget,
) {
  emit("automatic-start", {
    mode: model ? "model" : "local",
    corpusHash: fixtureHash(fixtures),
    cases: fixtures.length,
    trials: model ? 3 : 1,
    expectedItems: fixtures.reduce((sum, item) => sum + item.expected.length, 0),
    latencyScope:
      "assistant ledger commit acknowledged -> MemoryService.list observes committed memory; production 1s scheduler, excludes Mac/network refresh",
  });
  let localPassed = true;
  for (let trial = 1; trial <= (model ? 3 : 1); trial++) {
    for (const fixture of fixtures) {
      assert.ok(
        !budget?.stopped,
        "Authorized evaluation limit reached; remaining trials stay missing",
      );
      const db = await database();
      let runner: MemoryJobRunner | undefined;
      try {
        await db.ledger.initialize();
        const seeds: Memory[] = [];
        for (const item of fixture.seeds ?? []) seeds.push(await seed(db, item.content, item.kind));
        await toggle(db, true);
        const source = await db.source(fixture.input);
        const service = db.makeService(model ?? fixedModel(fixture, seeds));
        runner = new MemoryJobRunner(service);
        // Use the same scheduler/retry/commit path as Core. Local contract checks skip timers.
        if (model) await runner.start();
        const completion = await db.complete(source, true);
        const started = performance.now();
        const safeSource = {
          id: source.id,
          requestId: source.requestId,
          content: fixture.category === "secret" ? "[synthetic secret withheld]" : source.content,
        };
        emit("automatic-case-start", {
          id: fixture.id,
          trial,
          source: safeSource,
          completionEventId: completion.id,
          seeds,
        });
        let visibleMs: number | null = null;
        let job: AutomaticEvidence["job"] = null;
        let previousJobState = "";
        let stored: readonly Memory[] = seeds;
        let error: string | undefined;
        try {
          if (!model) await runner.runOnce();
          for (;;) {
            stored = (await service.list()).memories;
            if (visibleMs === null && changed(stored, seeds).length)
              visibleMs = performance.now() - started;
            job = await status(db, source.requestId);
            const jobState = JSON.stringify(job);
            if (jobState !== previousJobState) {
              emit("automatic-job-state", {
                id: fixture.id,
                trial,
                requestId: source.requestId,
                job,
                elapsedMs: performance.now() - started,
              });
              previousJobState = jobState;
            }
            if (!job || ["complete", "skipped", "failed"].includes(job.status)) break;
            if (!model) throw new Error("Local fixed proposal did not settle on its first attempt");
            if (performance.now() - started >= 125_000)
              throw new Error("Automatic job did not settle within 125 seconds");
            await delay(100);
          }
        } catch (failure) {
          error = failure instanceof Error ? failure.message : "unknown";
        }
        // Stop before final snapshot, so an unfinished attempt cannot commit after evidence.
        const settledMs = performance.now() - started;
        await runner.stop();
        stored = (await service.list()).memories;
        job = await status(db, source.requestId);
        const writes = changed(stored, seeds);
        if (visibleMs === null && writes.length) visibleMs = performance.now() - started;
        const evidence: AutomaticEvidence = {
          type: "automatic-case",
          mode: model ? "model" : "local",
          id: fixture.id,
          trial,
          source: safeSource,
          seeds,
          stored,
          writes,
          job,
          visibleMs,
          settledMs,
          ...(error ? { error } : {}),
        };
        emit(evidence.type, {
          ...evidence,
          semanticVerdict: model ? "requires_review" : "not_measured",
        });
        if (!model) {
          const expected = fixture.expected.map((item) => ({
            content: item.content,
            kind: item.kind,
          }));
          const actual = writes.map((item) => ({ content: item.content, kind: item.kind }));
          const passed =
            !error &&
            ["complete", "skipped"].includes(job?.status ?? "") &&
            JSON.stringify(actual.sort((a, b) => a.content.localeCompare(b.content))) ===
              JSON.stringify(expected.sort((a, b) => a.content.localeCompare(b.content)));
          localPassed &&= passed;
          emit("automatic-local-verdict", { id: fixture.id, passed });
        }
      } finally {
        await runner?.stop();
        await db.close();
      }
    }
  }
  const controlsPassed = await automaticControls();
  emit("automatic-summary", {
    mode: model ? "model" : "local",
    localPassed,
    controlsPassed,
    semanticVerdict: model ? "requires_review" : "not_measured",
  });
  return localPassed && controlsPassed;
}

/** Deterministic boundary stories complement (and are never pooled into) model quality. */
export async function automaticControls() {
  const db = await database();
  let runner: MemoryJobRunner | undefined;
  try {
    await db.ledger.initialize();
    const existing = await seed(db, "我喜欢读诗", "preference");
    await toggle(db, true);
    await toggle(db, false);
    const disabled: LedgerMessage[] = [];
    let calls = 0;
    runner = new MemoryJobRunner(
      db.makeService({
        stream() {
          calls++;
          throw new Error("Disabled turns must never invoke extraction");
        },
      }),
    );
    for (let index = 0; index < 20; index++) {
      const source = await db.source(`我长期收藏第 ${index} 类邮票`);
      disabled.push(source);
      await db.complete(source, true);
      assert.equal(await runner.runOnce(), false);
      assert.equal((await db.repository.snapshot()).memories.length, 1);
      emit("automatic-control", {
        name: "disabled-turn",
        index,
        requestId: source.requestId,
        eventId: source.id,
        passed: true,
      });
    }
    await toggle(db, true);
    await db.repository.recoverJobs();
    for (const source of disabled) await db.complete(source, true);
    assert.equal(await runner.runOnce(), false);
    assert.equal(calls, 0);
    assert.deepEqual((await db.repository.snapshot()).memories, [existing]);
    emit("automatic-control", { name: "reopen-no-backfill", turns: 20, passed: true, calls });
    await toggle(db, false);
    const explicit = await seed(db, "我喜欢散步", "preference");
    await db.makeService().correct(explicit.id, {
      requestId: randomUUID(),
      expectedVersion: 1,
      content: "我喜欢晨间散步",
    });
    assert.ok(
      (await db.makeService().recall({ query: "晨间散步" }, false)).items.some(
        (item) => item.id === explicit.id && item.version === 2,
      ),
    );
    await remove(db, explicit.id, 2);
    assert.equal((await db.repository.get(explicit.id)).length, 0);
    emit("automatic-control", {
      name: "phase2-write-correct-recall-delete-while-disabled",
      passed: true,
    });
    await runner.stop();
    for (let index = 0; index < 20; index++) {
      await toggle(db, true);
      const source = await db.source(`我长期收藏第 ${index} 类邮票`);
      await db.complete(source, true);
      const job = await db.repository.claimJob();
      assert.ok(job);
      emit("automatic-control-start", {
        name: "deleted-source-late-job",
        index,
        requestId: source.requestId,
        eventId: source.id,
        claimId: job.claimId,
      });
      // The source-deletion UI operates on saved memory sources, not arbitrary unsaved chat.
      await seed(db, source.content, "fact", source);
      const preview = await db
        .makeService()
        .preview({ id: randomUUID(), target: { kind: "source", eventId: source.id } });
      await db
        .makeService()
        .confirm(
          preview.id,
          { instanceId: preview.instanceId, minimumRestoreEpoch: preview.nextRestoreEpoch },
          "synthetic-eval",
        );
      await assert.rejects(
        db.makeService().processAutomaticJob(job, new AbortController().signal),
        { name: "MemorySourceError" },
      );
      await db.repository.recoverJobs();
      assert.equal(await db.repository.claimJob(), null);
      assert.deepEqual((await db.repository.snapshot()).memories, [existing]);
      emit("automatic-control", {
        name: "deleted-source-late-job",
        index,
        requestId: source.requestId,
        eventId: source.id,
        claimId: job.claimId,
        deletionId: preview.id,
        passed: true,
      });
    }
    return true;
  } catch (error) {
    emit("automatic-control-failure", {
      error: error instanceof Error ? error.message : "unknown",
    });
    return false;
  } finally {
    await runner?.stop();
    await db.close();
  }
}

async function remove(db: EvaluationDatabase, id: string, version: number) {
  const service = db.makeService();
  const preview = await service.preview({
    id: randomUUID(),
    target: { kind: "memory", id, version },
  });
  await service.confirm(
    preview.id,
    { instanceId: preview.instanceId, minimumRestoreEpoch: preview.nextRestoreEpoch },
    "synthetic-eval",
  );
}

export async function automaticPlan(fixtures: AutomaticFixture[]) {
  const bounds: number[] = [];
  for (const fixture of fixtures) {
    await proposeMemory(
      {
        async *stream(request) {
          bounds.push(deepSeekV41ContextProfile.estimateTokens(request.messages));
          yield { type: "delta", content: '{"intent":"none","history":false}' };
          yield { type: "complete", inputTokens: 0, outputTokens: 0 };
        },
      },
      {
        id: randomUUID(),
        requestId: randomUUID(),
        role: "user",
        content: fixture.input,
        sequence: 1,
        occurredAt: new Date(),
      },
      (fixture.seeds ?? []).map(
        (item): Memory => ({
          ...item,
          id: randomUUID(),
          version: 1,
          state: "current",
          origin: "explicit",
          sensitivity: "normal",
          sources: [],
          createdAt: "2026-09-28T00:00:00Z",
          updatedAt: "2026-09-28T00:00:00Z",
        }),
      ),
      undefined,
      "automatic",
    );
  }
  return {
    modelCalls: 0,
    cases: fixtures.length,
    positive: 60,
    negative: 40,
    trials: 3,
    expectedItemsPerTrial: fixtures.reduce((sum, item) => sum + item.expected.length, 0),
    corpusHash: fixtureHash(fixtures),
    logicalTrials: fixtures.length * 3,
    providerEligibleTrials: bounds.length * 3,
    maximumProviderAttempts: bounds.length * 3 * 3 * 3,
    maximumInput: Math.max(...bounds),
    maximumOutput: 4096,
    unit: "tokens",
    noRetryUpperCny: bounds.reduce((sum, input) => sum + modelCost(input, 4096) * 3, 0),
    allRetriesUpperCny: bounds.reduce((sum, input) => sum + modelCost(input, 4096) * 27, 0),
    pricing: "2026-09-28 DeepSeek V4.1 Flash peak, cache-miss input 2 / output 8 CNY per million",
    keyPresent: Boolean(process.env["DEEPSEEK_API_KEY"]),
    semanticVerdict: "requires_real_model_and_review",
  };
}

export async function automaticMain(args: string[]) {
  assert.ok(
    args.every(
      (arg) =>
        ["--model", "--local", "--plan"].includes(arg) ||
        /^--(?:budget-cny|max-provider-attempts)=\d+(?:\.\d+)?$/.test(arg) ||
        /^--(?:evidence|review)=.+$/.test(arg),
    ),
    "Unknown automatic evaluation argument",
  );
  const value = (name: string) =>
    args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  const fixtures = await loadAutomaticFixtures();
  if (value("evidence")) {
    assert.ok(!args.includes("--model"), "Review must not initiate provider calls");
    await automaticReview(fixtures, resolve(value("evidence") ?? ""), value("review"), emit);
  } else if (args.includes("--plan")) {
    emit("automatic-plan", await automaticPlan(fixtures));
  } else if (args.includes("--model")) {
    const apiKey = process.env["DEEPSEEK_API_KEY"];
    assert.ok(apiKey, "DEEPSEEK_API_KEY required; use environment, never argv");
    const directory = resolve(".local-acceptance");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const budget = new EvaluationBudget(
      resolve(directory, "phase3-eval-budget.ndjson"),
      Number(value("max-provider-attempts")),
      Number(value("budget-cny")),
    );
    try {
      emit("automatic-budget", budget.state);
      if (!(await collectAutomatic(fixtures, evaluationModel(apiKey, budget, emit), budget)))
        process.exitCode = 1;
    } finally {
      emit("automatic-budget", budget.state);
      budget.close();
    }
  } else if (!(await collectAutomatic(fixtures))) process.exitCode = 1;
}
