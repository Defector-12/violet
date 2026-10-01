import { randomBytes, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { EnvelopeCipher } from "@violet/crypto";
import {
  type LedgerMessage,
  MemoryConflictError,
  type MemoryJob,
  MemorySourceError,
  type MemoryWriteRequest,
  type ModelGateway,
  type ModelRequest,
  type ModelStreamEvent,
} from "@violet/domain";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ChatService } from "../conversation/chat-service.js";
import { ContextAssembler } from "../conversation/context-assembler.js";
import { ContextEpochManager } from "../conversation/context-epoch-manager.js";
import { MemoryJobRunner } from "../memory/memory-job-runner.js";
import { MemoryService } from "../memory/memory-service.js";
import { PostgresContextCheckpointRepository } from "./postgres-context-checkpoint-repository.js";
import { PostgresConversationLedger } from "./postgres-conversation-ledger.js";
import { PostgresMemoryRepository } from "./postgres-memory-repository.js";
import { initializeTestExtensions } from "./postgres-test-database.js";

const databaseUrl = process.env["VIOLET_TEST_DATABASE_URL"];
describe.skipIf(!databaseUrl)("PostgreSQL automatic memory jobs", () => {
  const schema = `violet_jobs_${randomUUID().replaceAll("-", "")}`;
  const cipher = new EnvelopeCipher({ key: randomBytes(32), keyVersion: "synthetic-jobs" });
  let admin: Pool;
  let pool: Pool;
  let ledger: PostgresConversationLedger;
  let repository: PostgresMemoryRepository;
  let upgrade: { enabled: boolean; floor: number; jobs: number; stamp: unknown };

  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl, max: 1 });
    await initializeTestExtensions(admin);
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({
      connectionString: databaseUrl,
      max: 4,
      options: `-c search_path=${schema},public`,
    });
    ledger = new PostgresConversationLedger({
      cipher,
      pool,
      instanceId: randomUUID(),
      constitutionVersion: "test",
    });
    const directory = new URL("../../../../infra/migrations/", import.meta.url);
    for (const file of (await readdir(directory)).filter((file) => file.endsWith(".sql")).sort()) {
      if (file.startsWith("0004")) {
        await ledger.append({
          id: randomUUID(),
          requestId: randomUUID(),
          content: "升级前原话",
          role: "user",
          occurredAt: new Date(),
        });
        await pool.query("UPDATE violet_instances SET memory_revision = 7");
      }
      await pool.query(await readFile(new URL(file, directory), "utf8"));
    }
    repository = new PostgresMemoryRepository({ cipher, pool });
    upgrade = {
      enabled: (await repository.settings()).enabled,
      floor: (await repository.snapshot()).minimumContextRevision ?? -1,
      jobs: Number((await pool.query("SELECT count(*) FROM memory_jobs")).rows[0].count),
      stamp: (await pool.query("SELECT memory_settings_revision FROM conversation_events")).rows[0]
        .memory_settings_revision,
    };
  });
  beforeEach(async () => {
    await pool.query("TRUNCATE violet_instances CASCADE");
    await ledger.initialize();
  });
  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin?.end();
  });

  async function toggle(enabled: boolean) {
    return repository.updateSettings({
      requestId: randomUUID(),
      expectedRevision: (await repository.settings()).revision,
      enabled,
    });
  }
  async function user(content = "我喜欢紫色 🪻") {
    return ledger.append({
      id: randomUUID(),
      requestId: randomUUID(),
      content,
      role: "user",
      occurredAt: new Date(),
      contextEpoch: { id: randomUUID(), startedAt: new Date() },
    });
  }
  async function complete(source: LedgerMessage, eligible = true) {
    return ledger.append({
      id: randomUUID(),
      requestId: source.requestId,
      content: "普通回答",
      role: "assistant",
      occurredAt: new Date(),
      automaticMemoryEligible: eligible,
    });
  }
  async function claimed() {
    const job = await repository.claimJob();
    if (!job) throw new Error("Expected pending job");
    return job;
  }
  async function write(source: LedgerMessage, job?: MemoryJob): Promise<MemoryWriteRequest> {
    return {
      requestId: source.requestId,
      sourceEventId: source.id,
      expectedRevision: (await repository.state()).revision,
      writes: [
        {
          content: source.content,
          kind: "preference",
          sensitivity: "normal",
          source: {
            eventId: source.id,
            startByte: 0,
            endByte: Buffer.byteLength(source.content),
            quote: source.content,
          },
        },
      ],
      ...(job ? { automaticJob: job } : {}),
    };
  }
  async function status(requestId: string) {
    return (await pool.query("SELECT * FROM memory_jobs WHERE request_id = $1", [requestId]))
      .rows[0];
  }
  function service(model: ModelGateway) {
    return new MemoryService({
      repository,
      ledger,
      model,
      epochManager: new ContextEpochManager({ generateId: randomUUID }),
    });
  }
  function model(onRequest?: (request: ModelRequest) => Promise<void>): ModelGateway {
    return {
      async *stream(request): AsyncIterable<ModelStreamEvent> {
        await onRequest?.(request);
        const source = JSON.parse(request.messages.at(-1)?.content ?? "{}").finalUser;
        yield {
          type: "delta",
          content: JSON.stringify({
            intent: "write",
            writes: [{ content: source, quote: source, kind: "preference" }],
          }),
        };
        yield { type: "complete", inputTokens: 1, outputTokens: 1 };
      },
    };
  }

  it("upgrades closed without backfill and preserves the preexisting context floor", () => {
    expect(upgrade).toEqual({ enabled: false, floor: 7, jobs: 0, stamp: null });
  });

  it("enqueues only new ordinary complete turns from the same enabled generation", async () => {
    const disabled = await user();
    await toggle(true);
    await complete(disabled);
    const interrupted = await user();
    await toggle(false);
    await toggle(true);
    await complete(interrupted);
    const explicit = await user();
    await complete(explicit, false);
    await complete(explicit, true); // Replay cannot enqueue.
    const failed = await user();
    await ledger.markRequestFailed(failed.requestId, required(failed.contextEpochId), new Date());
    await ledger.clearRequestFailure(failed.requestId);
    await complete(failed);
    const empty = await user();
    await ledger.append({
      id: randomUUID(),
      requestId: empty.requestId,
      role: "assistant",
      content: "",
      occurredAt: new Date(),
      automaticMemoryEligible: true,
    });
    const pending = await user();
    expect(await repository.claimJob()).toBeNull();
    await complete(pending);
    await complete(pending);
    const job = await claimed();
    expect(job.sourceEventId).toBe(pending.id);
    expect(await repository.claimJob()).toBeNull();
    const raw = JSON.stringify((await pool.query("SELECT * FROM memory_jobs")).rows);
    expect(raw).not.toContain("紫色");
    expect((await pool.query("SELECT * FROM memory_jobs")).rowCount).toBe(1);
  });

  it("rolls back the answer if atomic task insertion fails", async () => {
    await toggle(true);
    const source = await user();
    await pool.query(`CREATE FUNCTION fail_job_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'synthetic enqueue failure'; END; $$;
      CREATE TRIGGER fail_job BEFORE INSERT ON memory_jobs FOR EACH ROW EXECUTE FUNCTION fail_job_insert()`);
    try {
      await expect(complete(source)).rejects.toThrow("synthetic enqueue failure");
      expect(await ledger.findByRequest(source.requestId, "assistant")).toBeNull();
      expect(await status(source.requestId)).toBeUndefined();
    } finally {
      await pool.query("DROP TRIGGER fail_job ON memory_jobs; DROP FUNCTION fail_job_insert()");
    }
  });

  it("versions settings and returns current state on delayed idempotent retries", async () => {
    const input = { requestId: randomUUID(), expectedRevision: 0, enabled: true };
    expect((await repository.updateSettings(input)).revision).toBe(1);
    await toggle(false);
    expect(await repository.updateSettings(input)).toMatchObject({ enabled: false, revision: 2 });
    await expect(repository.updateSettings({ ...input, enabled: false })).rejects.toThrow(
      MemoryConflictError,
    );
    await expect(repository.updateSettings({ ...input, requestId: randomUUID() })).rejects.toThrow(
      MemoryConflictError,
    );
  });

  it.each([false, true])(
    "keeps erroneous explicit proposals on the ordinary chat path (enabled=%s)",
    async (enabled) => {
      if (enabled) await toggle(true);
      const gateway: ModelGateway = {
        async *stream(request): AsyncIterable<ModelStreamEvent> {
          // Reproduce the observed provider error, including the synchronous classifier.
          if (request.jsonOutput) {
            yield* model().stream(request);
            return;
          }
          yield {
            type: "delta",
            content: "普通回答",
          };
          yield { type: "complete", inputTokens: 1, outputTokens: 1 };
        },
      };
      const memory = service(gateway);
      const chat = new ChatService({
        ledger,
        modelGateway: gateway,
        memoryService: memory,
        generateId: randomUUID,
        epochManager: new ContextEpochManager({ generateId: randomUUID }),
        contextAssembler: new ContextAssembler({
          ledger,
          model: gateway,
          memoryService: memory,
          checkpoints: new PostgresContextCheckpointRepository({ cipher, pool }),
        }),
      });
      const request = { requestId: randomUUID(), message: "我平时喜欢用紫色书签" };
      for await (const event of chat.stream(request)) expect(event.type).not.toBe("error");
      if (enabled) expect(await status(request.requestId)).toMatchObject({ status: "pending" });
      else expect(await status(request.requestId)).toBeUndefined();
      expect((await repository.snapshot()).memories).toHaveLength(0);
      const runner = new MemoryJobRunner(memory);
      await runner.runOnce();
      const stored = (await repository.snapshot()).memories;
      expect(stored).toHaveLength(enabled ? 1 : 0);
      if (enabled)
        expect(stored[0]).toMatchObject({ origin: "automatic", content: request.message });
      const replay = [];
      for await (const event of chat.stream(request)) replay.push(event);
      expect(JSON.stringify(replay)).not.toContain("已记住");
      expect(JSON.stringify(replay)).toContain("普通回答");
      expect(await runner.runOnce()).toBe(false);
      await runner.stop();

      await toggle(false);
      for await (const event of chat.stream({
        requestId: randomUUID(),
        message: "请记住，我喜欢橙色笔记本。",
      }))
        expect(event.type).not.toBe("error");
      expect(
        (await repository.snapshot()).memories.filter((item) => item.origin === "explicit"),
      ).toHaveLength(1);
    },
  );

  it.each([1, 2, 3])(
    "disabling and reopening defeats an in-flight model result (trial %s)",
    async () => {
      await toggle(true);
      const source = await user();
      await complete(source);
      const entered = deferred();
      const release = deferred();
      const runner = new MemoryJobRunner(
        service(
          model(async () => {
            entered.resolve();
            await release.promise;
          }),
        ),
      );
      const running = runner.runOnce();
      await entered.promise;
      await toggle(false);
      await toggle(true);
      release.resolve();
      await running;
      expect(await status(source.requestId)).toMatchObject({ status: "skipped", attempts: 1 });
      expect((await repository.snapshot()).memories).toEqual([]);
      expect(await runner.runOnce()).toBe(false);
      await runner.stop();
    },
  );

  it("commits job outcome and encrypted automatic memory together without explicit replay", async () => {
    await toggle(true);
    const source = await user();
    await complete(source);
    const job = await claimed();
    const input = await write(source, job);
    await repository.write(input);
    expect(await status(source.requestId)).toMatchObject({ status: "complete", claim_id: null });
    expect(await repository.changesForRequest(source.requestId)).toBeNull();
    expect((await repository.snapshot()).memories[0]).toMatchObject({
      origin: "automatic",
      sources: [{ eventId: source.id }],
    });
    await expect(repository.write(input)).rejects.toThrow(MemorySourceError);
    expect((await repository.snapshot()).memories).toHaveLength(1);
    expect(await service(model()).replayTurn(source.requestId)).toBeNull();
  });

  it.each([1, 2, 3])(
    "deletion cascades a claimed job and forbids late recreation (trial %s)",
    async () => {
      await toggle(true);
      const source = await user();
      await complete(source);
      const job = await claimed();
      await repository.write(await write(source));
      const preview = await repository.previewDeletion(randomUUID(), {
        kind: "source",
        eventId: source.id,
      });
      await repository.confirmDeletion({
        id: preview.id,
        instanceId: preview.instanceId,
        minimumRestoreEpoch: preview.nextRestoreEpoch,
        deviceId: "synthetic",
      });
      expect(await status(source.requestId)).toBeUndefined();
      await expect(repository.write(await write(source, job))).rejects.toThrow(MemorySourceError);
      await expect(complete(source)).rejects.toThrow("deleted");
      expect((await repository.snapshot()).memories).toEqual([]);
    },
  );

  it("rejects automatic corrections, sensitive writes, wrong claims and changed sources", async () => {
    await toggle(true);
    const original = await user("我喜欢蓝色");
    const change = required((await repository.write(await write(original)))[0]);
    const source = await user();
    await complete(source);
    const job = await claimed();
    const input = await write(source, job);
    const proposed = required(input.writes[0]);
    await expect(
      repository.write({ ...input, automaticJob: { ...job, claimId: randomUUID() } }),
    ).rejects.toThrow(MemorySourceError);
    await expect(
      repository.write({
        ...input,
        writes: [{ ...proposed, target: { id: change.id, version: 1, action: "correct" } }],
      }),
    ).rejects.toThrow(MemorySourceError);
    await expect(
      repository.write({ ...input, writes: [{ ...proposed, sensitivity: "controlled" }] }),
    ).rejects.toThrow(MemorySourceError);
    await expect(
      repository.write({
        ...input,
        writes: [{ ...proposed, source: { ...proposed.source, eventId: original.id } }],
      }),
    ).rejects.toThrow(MemorySourceError);
    expect((await repository.snapshot()).memories).toHaveLength(1);
    expect(await status(source.requestId)).toMatchObject({ status: "running" });
  });

  it("automatic additions preserve in-flight revisions but explicit writes still invalidate them", async () => {
    await toggle(true);
    const source = await user();
    await complete(source);
    await repository.write(await write(source, await claimed()));
    const pending = await user("普通问题");
    await ledger.append({
      id: randomUUID(),
      requestId: pending.requestId,
      role: "assistant",
      content: "旧快照仍有效",
      occurredAt: new Date(),
      expectedMemoryRevision: 0,
    });
    const explicit = await user("请记住，我喜欢阅读");
    await repository.write(await write(explicit));
    const later = await user();
    await expect(
      ledger.append({
        id: randomUUID(),
        requestId: later.requestId,
        role: "assistant",
        content: "过期回答",
        occurredAt: new Date(),
        expectedMemoryRevision: 1,
      }),
    ).rejects.toThrow(MemoryConflictError);
  });

  it.each([1, 2, 3])(
    "rejects late extraction after a correction even with a fresh view revision (trial %s)",
    async () => {
      await toggle(true);
      const original = await user("我喜欢蓝色");
      const created = required((await repository.write(await write(original)))[0]);
      const source = await user();
      await complete(source);
      const job = await claimed();
      const correction = await write(await user("现在改成绿色"));
      await repository.write({
        ...correction,
        writes: [
          {
            ...required(correction.writes[0]),
            target: { id: created.id, version: 1, action: "correct" },
          },
        ],
      });
      await expect(repository.write(await write(source, job))).rejects.toThrow(MemorySourceError);
      expect((await repository.get(created.id))[0]?.version).toBe(2);
    },
  );

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])(
    "rejects malformed context revision %s",
    async (revision) => {
      const source = await user();
      await expect(
        ledger.append({
          id: randomUUID(),
          requestId: source.requestId,
          role: "assistant",
          content: "invalid revision",
          occurredAt: new Date(),
          expectedMemoryRevision: revision,
        }),
      ).rejects.toThrow(MemoryConflictError);
      expect(await ledger.findByRequest(source.requestId, "assistant")).toBeNull();
    },
  );

  it("retries a timed-out provider within bounds without accepting its late output", async () => {
    await toggle(true);
    const source = await user();
    await complete(source);
    const release = deferred();
    const runner = new MemoryJobRunner(service(model(async () => release.promise)), 20);
    try {
      await runner.runOnce();
      expect(await status(source.requestId)).toMatchObject({
        status: "pending",
        failure_code: "timeout",
        attempts: 1,
      });
      expect(await repository.claimJob()).toBeNull(); // Retry delay is durable.
    } finally {
      release.resolve();
      await runner.stop();
    }
    expect((await repository.snapshot()).memories).toHaveLength(0);
  });

  it.each([
    "我的密码是 synthetic-only-secret",
    "我的 API token 是 synthetic-only-value",
    "我对花生过敏。",
    "我正在服用降压药。",
  ])("filters sensitive sources before the model: %s", async (content) => {
    await toggle(true);
    const source = await user(content);
    await complete(source);
    let calls = 0;
    const runner = new MemoryJobRunner(
      service(
        model(async () => {
          calls++;
        }),
      ),
    );
    await runner.runOnce();
    expect(calls).toBe(0);
    expect(await status(source.requestId)).toMatchObject({
      status: "skipped",
      failure_code: "sensitive_source",
    });
    await runner.stop();
  });

  it("recovers claims across restart, rejects old claims, and stops after three failed attempts", async () => {
    await toggle(true);
    const source = await user();
    await complete(source);
    const first = await claimed();
    await repository.recoverJobs();
    const second = await claimed();
    expect(second.attempt).toBe(2);
    await expect(repository.write(await write(source, first))).rejects.toThrow(MemorySourceError);
    await repository.finishJob(second, "retry", "synthetic_failure");
    await pool.query("UPDATE memory_jobs SET available_at = now()");
    const third = await claimed();
    expect(third.attempt).toBe(3);
    await repository.finishJob(third, "retry", "synthetic_failure");
    expect(await status(source.requestId)).toMatchObject({ status: "failed", attempts: 3 });
    await repository.recoverJobs();
    expect(await repository.claimJob()).toBeNull();
  });

  it("bounds an unresponsive model and leaves shutdown claims recoverable", async () => {
    await toggle(true);
    const source = await user();
    await complete(source);
    const entered = deferred();
    const release = deferred();
    const runner = new MemoryJobRunner(
      service(
        model(async () => {
          entered.resolve();
          await release.promise;
        }),
      ),
    );
    const work = runner.runOnce();
    await entered.promise;
    await runner.stop();
    await work;
    expect(await status(source.requestId)).toMatchObject({ status: "running" });
    await repository.recoverJobs();
    const restored = new MemoryJobRunner(service(model()));
    await restored.runOnce();
    release.resolve();
    await restored.stop();
    expect(await status(source.requestId)).toMatchObject({ status: "complete", attempts: 2 });
    expect((await repository.snapshot()).memories).toHaveLength(1);
  });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Required test value is missing");
  return value;
}
