import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import type { Memory } from "@violet/domain";
import { describe, expect, it } from "vitest";
import {
  type AutomaticEvidence,
  type AutomaticFixture,
  automaticPlan,
  loadAutomaticFixtures,
} from "./eval-automatic-memory.js";
import { type AutomaticReview, scoreAutomatic } from "./eval-automatic-review.js";
import { distribution, loadMemoryFixtures } from "./eval-memory.js";
import { EvaluationBudget, evaluationModel, modelCost } from "./eval-memory-budget.js";

describe("memory evaluation evidence", () => {
  it("loads the complete fixed corpus with source quotes and valid correction/deletion targets", async () => {
    const fixtures = await loadMemoryFixtures();
    expect(fixtures).toHaveLength(180);
    expect(fixtures.filter((fixture) => fixture.sensitivity === "controlled")).toHaveLength(4);
    for (const origin of ["secret", "assistant", "tool", "visual", "cancelled"])
      expect(fixtures.filter((fixture) => fixture.origin === origin)).toHaveLength(4);
  });

  it("retains slow trials in nearest-rank tail statistics instead of reporting a best run", () => {
    const samples = [...Array.from({ length: 98 }, () => 2), 500, 1000];
    const before = [...samples];
    expect(distribution(samples)).toEqual({ count: 100, p50: 2, p95: 2, p99: 500, max: 1000 });
    expect(samples).toEqual(before);
    expect(() => distribution([])).toThrow();
    expect(() => distribution([Number.NaN])).toThrow();
  });

  it("adds 100 annotated automatic cases and bounds actual production prompts without provider calls", async () => {
    const fixtures = await loadAutomaticFixtures();
    const plan = await automaticPlan(fixtures);
    expect(fixtures).toHaveLength(100);
    expect(fixtures.filter((item) => item.expected.length)).toHaveLength(60);
    // Eight sensitive and three explicit opt-out cases are excluded before provider I/O.
    expect(plan).toMatchObject({ modelCalls: 0, logicalTrials: 300, providerEligibleTrials: 267 });
    expect(plan.maximumInput).toBeLessThan(12000);
    expect(plan.maximumProviderAttempts).toBe(2403);
  });
});

const fixture: AutomaticFixture = {
  id: "synthetic",
  group: "automatic",
  category: "preference",
  input: "我喜欢绿茶",
  expected: [{ content: "我喜欢绿茶", quote: "我喜欢绿茶", kind: "preference" }],
};
function examples() {
  const evidence: AutomaticEvidence[] = [1, 2, 3].map((trial) => {
    const memory: Memory = {
      id: `memory-${trial}`,
      content: fixture.input,
      kind: "preference",
      sensitivity: "normal",
      origin: "automatic",
      version: 1,
      state: "current",
      createdAt: "",
      updatedAt: "",
      sources: [
        { eventId: `source-${trial}`, startByte: 0, endByte: Buffer.byteLength(fixture.input) },
      ],
    };
    return {
      type: "automatic-case",
      mode: "model",
      id: fixture.id,
      trial,
      source: { id: `source-${trial}`, requestId: `request-${trial}`, content: fixture.input },
      seeds: [],
      stored: [memory],
      writes: [memory],
      job: { status: "complete", attempts: 1, failure_code: null },
      visibleMs: trial * 1000,
      settledMs: trial * 1000,
    };
  });
  const review: AutomaticReview = {
    evidenceHash: "evidence",
    corpusHash: "corpus",
    reviewer: "test-reviewer",
    cases: evidence.map((item) => ({
      id: item.id,
      trial: item.trial,
      reason: "Whole claim and supporting quote match.",
      writes: item.writes.map((memory) => ({
        memoryId: memory.id,
        expectedIndex: 0,
        reason: "Same qualified preference.",
      })),
    })),
  };
  return { evidence, review };
}
const score = (evidence: AutomaticEvidence[], review: AutomaticReview) =>
  scoreAutomatic([fixture], evidence, review, "evidence", "corpus");

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing test value");
  return value;
}

describe("automatic memory review accounting", () => {
  it("reports each independent trial and keeps slow samples", () => {
    const { evidence, review } = examples();
    expect(score(evidence, review).pooled.passed).toBe(true);
    required(evidence[2]).visibleMs = 61000;
    const result = score(evidence, review);
    expect(result.pooled).toMatchObject({
      precision: 1,
      recall: 1,
      passed: false,
      visibleMs: { p95: 61000 },
    });
    expect(result.perTrial).toHaveLength(3);
  });

  it("keeps missing trials and failed jobs in the expected denominator", () => {
    const { evidence, review } = examples();
    evidence.pop();
    required(review.cases[2]).writes = [];
    required(evidence[1]).job = { status: "failed", attempts: 3, failure_code: "timeout" };
    expect(score(evidence, review).pooled).toMatchObject({
      correct: 2,
      written: 2,
      expected: 3,
      recall: 2 / 3,
      missing: 1,
      operationalFailures: 2,
      passed: false,
    });
  });

  it("counts duplicates as extra writes, wrong kinds and wrong source ranges as false positives", () => {
    const { evidence, review } = examples();
    const original = required(evidence[0]?.writes[0]);
    required(evidence[0]).writes = [original, { ...original, id: "duplicate" }];
    required(review.cases[0]).writes.push({
      memoryId: "duplicate",
      expectedIndex: 0,
      reason: "Duplicate of the first.",
    });
    required(evidence[1]).writes = [{ ...required(evidence[1]?.writes[0]), kind: "goal" }];
    required(evidence[2]).writes = [
      {
        ...required(evidence[2]?.writes[0]),
        sources: [{ eventId: "wrong", startByte: 0, endByte: 9999 }],
      },
    ];
    expect(score(evidence, review).pooled).toMatchObject({
      correct: 1,
      written: 4,
      expected: 3,
      precision: 0.25,
      recall: 1 / 3,
    });
  });

  it("requires every write's explicit review bound to unchanged raw evidence", () => {
    const { evidence, review } = examples();
    expect(() => score(evidence, { ...review, evidenceHash: "different" })).toThrow(
      "different raw evidence",
    );
    expect(() => score(evidence, { ...review, corpusHash: "different" })).toThrow(
      "different corpus",
    );
    required(review.cases[0]?.writes[0]).reason = "pending";
    expect(() => score(evidence, review)).toThrow();
    required(review.cases[0]).writes = [];
    expect(() => score(evidence, review)).toThrow("Every actual write");
  });

  it("does not let an optimistic semantic verdict hide a changed existing version", () => {
    const { evidence, review } = examples();
    required(evidence[0]).seeds = [
      { ...required(evidence[0]?.stored[0]), content: "旧内容", version: 1, origin: "explicit" },
    ];
    expect(score(evidence, review).pooled).toMatchObject({ changedSeeds: 1, passed: false });
  });
});

async function withBudget(operation: (path: string) => Promise<void>) {
  const root = resolve(".local-acceptance");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(`${root}/automatic-budget-test-`);
  try {
    await operation(`${directory}/budget.ndjson`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("automatic evaluation spending authorization", () => {
  it("persists failed reservations, refunds only complete usage, locks concurrent runs and rejects changed caps", async () => {
    await withBudget(async (path) => {
      const first = new EvaluationBudget(path, 3, 1);
      expect(() => new EvaluationBudget(path, 3, 1)).toThrow();
      first.reserve("failed", 1000, 4096);
      const success = first.reserve("successful", 1000, 4096);
      first.settle(success, 100, 20);
      const saved = first.state;
      first.close();
      expect(() => new EvaluationBudget(path, 4, 1)).toThrow("Existing authorization differs");
      const resumed = new EvaluationBudget(path, 3, 1);
      try {
        expect(resumed.state).toEqual(saved);
        expect(resumed.state.chargedUpperCny).toBeCloseTo(
          modelCost(1000, 4096) + modelCost(100, 20),
        );
        resumed.reserve("last", 1000, 4096);
        expect(() => resumed.reserve("denied", 1000, 4096)).toThrow("attempt limit");
        expect(() => resumed.settle(success, 100, 20)).toThrow("already settled");
      } finally {
        resumed.close();
      }
    });
  });

  it("stops before network I/O when the next reservation would exceed the monetary cap", async () => {
    await withBudget(async (path) => {
      const budget = new EvaluationBudget(path, 3, 0.001);
      try {
        expect(() => budget.reserve("denied", 1000, 4096)).toThrow("cost limit");
        expect(budget.state.attempts).toBe(0);
      } finally {
        budget.close();
      }
    });
  });

  it("counts the SDK HTTP retry and retains its cost; captures partial output without credentials", async () => {
    await withBudget(async (path) => {
      const budget = new EvaluationBudget(path, 3, 1);
      let attempts = 0;
      const records: unknown[] = [];
      const model = evaluationModel(
        "synthetic-test-key",
        budget,
        (type, data) => records.push({ type, ...data }),
        async () => {
          attempts++;
          expect((await readFile(path, "utf8")).trim().split("\n").length).toBeGreaterThanOrEqual(
            attempts + 1,
          );
          if (attempts === 1)
            return new Response("temporary failure", {
              status: 500,
              headers: { "retry-after-ms": "1" },
            });
          return new Response(
            'data: {"id":"synthetic","choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n',
            { headers: { "content-type": "text/event-stream" } },
          );
        },
      );
      try {
        await expect(async () => {
          for await (const _event of model.stream({
            requestId: "synthetic",
            messages: [{ role: "user", content: "hello" }],
            maximumOutputTokens: 4096,
          })) {
            /* drain */
          }
        }).rejects.toThrow("did not complete normally");
        expect(attempts).toBe(2);
        expect(budget.state).toMatchObject({ attempts: 2, unsettled: 2 });
        expect(JSON.stringify(records)).toContain("partial");
        expect(JSON.stringify(records)).not.toContain("synthetic-test-key");
      } finally {
        budget.close();
      }
    });
  });
});
