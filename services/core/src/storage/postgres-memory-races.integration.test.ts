import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { EnvelopeCipher } from "@violet/crypto";
import {
  MemoryConflictError,
  type MemoryWriteRequest,
  type ModelGateway,
  type ModelStreamEvent,
} from "@violet/domain";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ChatService } from "../conversation/chat-service.js";
import { ContextAssembler } from "../conversation/context-assembler.js";
import { ContextEpochManager } from "../conversation/context-epoch-manager.js";
import { MemoryService } from "../memory/memory-service.js";
import { PostgresContextCheckpointRepository } from "./postgres-context-checkpoint-repository.js";
import { PostgresConversationLedger } from "./postgres-conversation-ledger.js";
import { PostgresMemoryRepository } from "./postgres-memory-repository.js";

const databaseUrl = process.env["VIOLET_TEST_DATABASE_URL"];
const trials = [1, 2, 3];
const cancellationCases = trials.flatMap((trial) =>
  (["pool", "row", "insert"] as const).map((stage) => ({ trial, stage })),
);

describe.skipIf(!databaseUrl)("PostgreSQL memory commit boundaries", () => {
  const schema = `violet_memory_races_${randomUUID().replaceAll("-", "")}`;
  const cipher = new EnvelopeCipher({ key: randomBytes(32), keyVersion: "synthetic-races" });
  const instanceId = randomUUID();
  let admin: Pool;
  let pool: Pool;
  let writerPool: Pool;
  let ledger: PostgresConversationLedger;
  let writerLedger: PostgresConversationLedger;
  let memory: PostgresMemoryRepository;
  let writerMemory: PostgresMemoryRepository;

  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl, max: 1 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const options = { connectionString: databaseUrl, options: `-c search_path=${schema},public` };
    pool = new Pool({ ...options, max: 4 });
    writerPool = new Pool({ ...options, max: 1, application_name: schema });
    for (const migration of [
      "0001_violet_seed.sql",
      "0002_context_checkpoints.sql",
      "0002b_context_turn_failures.sql",
      "0002c_context_event_ids.sql",
      "0003_explicit_memory.sql",
    ]) {
      await pool.query(
        await readFile(
          new URL(`../../../../infra/migrations/${migration}`, import.meta.url),
          "utf8",
        ),
      );
    }
    ledger = new PostgresConversationLedger({
      cipher,
      pool,
      instanceId,
      constitutionVersion: "test",
    });
    writerLedger = new PostgresConversationLedger({
      cipher,
      pool: writerPool,
      instanceId,
      constitutionVersion: "test",
    });
    await ledger.initialize();
    memory = new PostgresMemoryRepository({ cipher, pool });
    writerMemory = new PostgresMemoryRepository({ cipher, pool: writerPool });
  });

  afterAll(async () => {
    await writerPool?.end();
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin?.end();
  });

  async function source(content = "请记住，我喜欢合成测试蓝。") {
    const message = await ledger.append({
      content,
      id: randomUUID(),
      requestId: randomUUID(),
      role: "user",
      occurredAt: new Date(),
      contextEpoch: { id: randomUUID(), startedAt: new Date() },
    });
    const input: MemoryWriteRequest = {
      requestId: message.requestId,
      sourceEventId: message.id,
      expectedRevision: (await memory.state()).revision,
      writes: [
        {
          content,
          kind: "preference",
          sensitivity: "normal",
          source: {
            eventId: message.id,
            startByte: 0,
            endByte: Buffer.byteLength(content),
            quote: content,
          },
        },
      ],
    };
    return { input, message };
  }

  async function waitForDatabaseLock() {
    await vi.waitFor(
      async () => {
        const result = await admin.query(
          "SELECT 1 FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock'",
          [schema],
        );
        expect(result.rowCount).toBe(1);
      },
      { timeout: 3_000, interval: 10 },
    );
  }

  async function cancelWhileWaiting(
    stage: "pool" | "row" | "insert",
    table: "memory_operations" | "conversation_events",
    operation: (signal: AbortSignal) => Promise<unknown>,
  ) {
    const controller = new AbortController();
    const reason = new Error(`synthetic cancellation at ${stage}`);
    const holder = await (stage === "pool" ? writerPool : pool).connect();
    const lockKey = randomBytes(4).readUInt32BE() % 2_000_000_000;
    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      if (stage === "row") await holder.query("ROLLBACK");
      if (stage === "insert") await holder.query("SELECT pg_advisory_unlock($1)", [lockKey]);
      holder.release();
    };
    let pending: Promise<unknown> | undefined;
    try {
      if (stage === "row") {
        await holder.query("BEGIN");
        await holder.query("SELECT id FROM violet_instances WHERE singleton = true FOR UPDATE");
      }
      if (stage === "insert") {
        // Pause inside the real INSERT, after the application's initial row-lock check.
        await holder.query("SELECT pg_advisory_lock($1)", [lockKey]);
        await pool.query(`
          CREATE FUNCTION pause_insert() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN PERFORM pg_advisory_xact_lock(${lockKey}); RETURN NEW; END $$;
          CREATE TRIGGER pause_insert AFTER INSERT ON ${table}
          FOR EACH ROW EXECUTE FUNCTION pause_insert();
        `);
      }
      pending = operation(controller.signal).then(
        () => "unexpected commit",
        (error: unknown) => error,
      );
      if (stage === "pool") {
        await vi.waitFor(() => expect(writerPool.waitingCount).toBe(1));
      } else {
        await waitForDatabaseLock();
      }
      controller.abort(reason);
      await release();
      expect(await pending).toBe(reason);
    } finally {
      controller.abort(reason);
      await release();
      await pending;
      if (stage === "insert") {
        await pool.query(`DROP TRIGGER IF EXISTS pause_insert ON ${table}`);
        await pool.query("DROP FUNCTION IF EXISTS pause_insert()");
      }
    }
  }

  it.each(cancellationCases)(
    "rolls back memory cancelled at $stage (trial $trial)",
    async ({ stage }) => {
      const { input } = await source();
      await cancelWhileWaiting(stage, "memory_operations", (signal) =>
        writerMemory.write(input, signal),
      );
      expect(await memory.changesForRequest(input.requestId)).toBeNull();
      expect((await memory.state()).revision).toBe(input.expectedRevision);
      const sources = await pool.query("SELECT 1 FROM memory_sources WHERE event_id = $1", [
        input.sourceEventId,
      ]);
      expect(sources.rowCount).toBe(0);
    },
  );

  it.each(cancellationCases)(
    "rolls back assistant append cancelled at $stage (trial $trial)",
    async ({ stage }) => {
      const { message, input } = await source();
      await ledger.markRequestFailed(message.requestId, message.contextEpochId ?? "", new Date());
      await cancelWhileWaiting(stage, "conversation_events", (signal) =>
        writerLedger.append({
          content: "Synthetic old answer",
          id: randomUUID(),
          requestId: message.requestId,
          role: "assistant",
          occurredAt: new Date(),
          signal,
          expectedMemoryRevision: input.expectedRevision,
        }),
      );
      expect(await ledger.findByRequest(message.requestId, "assistant")).toBeNull();
      expect(
        await ledger.listTurns({ contextEpochId: message.contextEpochId ?? "" }),
      ).toMatchObject([{ failed: true, completed: false }]);
    },
  );

  it("carries the bounded prepareTurn signal through commit into a waiting repository", async () => {
    const { message, input } = await source("请记住，我对合成测试花粉过敏。");
    let received: AbortSignal | undefined;
    const write = vi.spyOn(memory, "write").mockImplementation((request, signal) => {
      received = signal;
      return writerMemory.write(request, signal);
    });
    const service = new MemoryService({
      repository: memory,
      ledger,
      epochManager: new ContextEpochManager({ generateId: randomUUID }),
      model: {
        stream(): AsyncIterable<ModelStreamEvent> {
          throw new Error("Must not extract");
        },
      },
    });
    try {
      await cancelWhileWaiting("pool", "memory_operations", (signal) =>
        service.prepareTurn(message, signal),
      );
      expect(received?.aborted).toBe(true);
      expect(await memory.changesForRequest(input.requestId)).toBeNull();
    } finally {
      write.mockRestore();
    }
  });

  it.each([
    "请记住，我可能对合成测试花粉过敏。",
    "Please remember my medical history: I don't have diabetes.",
    "请记住，我对合成测试花粉过敏。\n目前没有药物过敏病史。",
  ])("persists explicitly authorized controlled words unchanged: %s", async (content) => {
    const { message } = await source(content);
    const service = new MemoryService({
      repository: memory,
      ledger,
      epochManager: new ContextEpochManager({ generateId: randomUUID }),
      model: {
        stream(): AsyncIterable<ModelStreamEvent> {
          throw new Error("Must not extract controlled content");
        },
      },
    });
    const result = await service.prepareTurn(message);
    expect(result.changes).toHaveLength(1);
    expect(await memory.get(result.changes[0]?.id ?? "")).toMatchObject([
      {
        content,
        sensitivity: "controlled",
        sources: [{ eventId: message.id, startByte: 0, endByte: Buffer.byteLength(content) }],
      },
    ]);
    const question = await source("你记住我对合成测试花粉过敏了吗；请回答。");
    expect(await service.prepareTurn(question.message)).toEqual({ changes: [], history: false });
    expect(await memory.changesForRequest(question.message.requestId)).toBeNull();
  });

  it.each(trials)("rejects stale append without any invalidation signal (trial %s)", async () => {
    const initial = await source();
    const created = (await memory.write(initial.input))[0];
    expect(created).toBeDefined();
    const correction = await source("纠正，合成测试偏好改为绿色。");
    const holder = await pool.connect();
    let pending: Promise<unknown> | undefined;
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM violet_instances WHERE singleton = true FOR UPDATE");
      pending = writerLedger
        .append({
          content: "Old revision answer",
          id: randomUUID(),
          requestId: correction.message.requestId,
          role: "assistant",
          occurredAt: new Date(),
          expectedMemoryRevision: correction.input.expectedRevision,
        })
        .catch((error: unknown) => error);
      await waitForDatabaseLock();
      // Simulate the correction commit before the service has emitted invalidation.
      await holder.query("UPDATE violet_instances SET memory_revision = memory_revision + 1");
      await holder.query("COMMIT");
      expect(await pending).toBeInstanceOf(MemoryConflictError);
      expect(await ledger.findByRequest(correction.message.requestId, "assistant")).toBeNull();
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
      await pending;
    }
  });

  it.each(trials)("retains writes cancelled only after COMMIT dispatch (trial %s)", async () => {
    const { input, message } = await source();
    for (const kind of ["memory", "assistant"] as const) {
      const controller = new AbortController();
      const client = await writerPool.connect();
      const proxied = new Proxy(client, {
        get(target, property) {
          if (property === "query")
            return (text: string, values?: unknown[]) => {
              const dispatched = target.query(text, values);
              if (text === "COMMIT") controller.abort(new Error("after COMMIT dispatch"));
              return dispatched;
            };
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const connect = vi.spyOn(writerPool, "connect").mockImplementation(async () => proxied);
      try {
        if (kind === "memory") {
          const result = await writerMemory.write(input, controller.signal);
          expect(await memory.changesForRequest(input.requestId)).toEqual(result);
        } else {
          const result = await writerLedger.append({
            content: "Committed answer",
            id: randomUUID(),
            requestId: message.requestId,
            role: "assistant",
            occurredAt: new Date(),
            signal: controller.signal,
            expectedMemoryRevision: (await memory.state()).revision,
          });
          expect(await ledger.findByRequest(message.requestId, "assistant")).toEqual(result);
        }
        expect(controller.signal.aborted).toBe(true);
      } finally {
        connect.mockRestore();
      }
    }
  });

  function createChat(model: ModelGateway) {
    const epochs = new ContextEpochManager({ generateId: randomUUID });
    const service = new MemoryService({ repository: memory, ledger, epochManager: epochs, model });
    return {
      service,
      chat: new ChatService({
        contextAssembler: new ContextAssembler({
          checkpoints: new PostgresContextCheckpointRepository({ cipher, pool }),
          ledger,
          model,
          memoryService: service,
        }),
        epochManager: epochs,
        generateId: randomUUID,
        ledger: writerLedger,
        modelGateway: model,
        memoryService: service,
      }),
    };
  }

  it.each(trials)(
    "does not persist Chat's old answer while correction holds the lock (trial %s)",
    async () => {
      const initial = await source();
      const target = (await memory.write(initial.input))[0];
      if (!target) throw new Error("Missing synthetic memory");
      const correction = await source("纠正，合成测试偏好是新绿色。");
      const model: ModelGateway = {
        async *stream(request) {
          yield {
            type: "delta",
            content: request.jsonOutput ? '{"intent":"none","history":false}' : "Old blue answer",
          };
          yield { type: "complete", inputTokens: 1, outputTokens: 1 };
        },
      };
      const { chat } = createChat(model);
      const request = { requestId: randomUUID(), message: "合成测试偏好是什么？" };
      const iterator = chat.stream(request)[Symbol.asyncIterator]();
      expect((await iterator.next()).value?.type).toBe("start");
      expect((await iterator.next()).value?.type).toBe("delta");
      const client = await pool.connect();
      await client.query("BEGIN");
      await client.query("SELECT id FROM violet_instances WHERE singleton = true FOR UPDATE");
      const answer = iterator.next();
      try {
        await waitForDatabaseLock();
        // Real repository correction on the already locked client; intentionally no service invalidation.
        const connect = vi.spyOn(pool, "connect").mockImplementation(
          async () =>
            new Proxy(client, {
              get(target, property) {
                if (property === "release") return () => {};
                if (property === "query")
                  return (text: string, values?: unknown[]) =>
                    text === "BEGIN" ? Promise.resolve({ rows: [] }) : target.query(text, values);
                const value = Reflect.get(target, property);
                return typeof value === "function" ? value.bind(target) : value;
              },
            }),
        );
        try {
          await memory.write({
            ...correction.input,
            writes: correction.input.writes.map((write) => ({
              ...write,
              target: { id: target.id, version: 1, action: "correct" as const },
            })),
          });
        } finally {
          connect.mockRestore();
        }
        expect((await answer).value).toMatchObject({
          type: "error",
          error: { code: "MEMORY_CONTEXT_CHANGED" },
        });
        expect(await ledger.findByRequest(request.requestId, "assistant")).toBeNull();
      } finally {
        await client.query("ROLLBACK");
        client.release();
        await answer;
        await iterator.return?.();
      }
    },
  );

  it.each(["source_reply", "revision", "confirmed"] as const)(
    "replays deletion preview ID without re-extraction and rejects changed impact: %s",
    async (change) => {
      const initial = await source();
      const target = (await memory.write(initial.input))[0];
      if (!target) throw new Error("Missing synthetic memory");
      let proposals = 0;
      const { chat } = createChat({
        async *stream() {
          proposals++;
          yield {
            type: "delta",
            content: JSON.stringify({ intent: "forget", id: target.id, version: 1 }),
          };
          yield { type: "complete", inputTokens: 1, outputTokens: 1 };
        },
      });
      const request = { requestId: randomUUID(), message: "请忘掉合成测试偏好。" };
      const first = await collect(chat.stream(request));
      const replay = await collect(chat.stream(request));
      const complete = first.at(-1);
      expect(first.at(-1)).toMatchObject({
        type: "complete",
        memoryDeletionPreviewId: request.requestId,
      });
      expect(replay.at(-1)).toMatchObject({
        type: "complete",
        memoryDeletionPreviewId: request.requestId,
        messageId: complete?.type === "complete" ? complete.messageId : undefined,
      });
      expect(proposals).toBe(1);
      if (change === "source_reply") {
        await ledger.append({
          content: "New synthetic source reply",
          requestId: initial.message.requestId,
          id: randomUUID(),
          role: "assistant",
          occurredAt: new Date(),
        });
      } else if (change === "revision") {
        await memory.write((await source("请记住，我喜欢合成测试新主题。")).input);
      } else {
        const preview = await memory.getDeletionPreview(request.requestId);
        if (!preview) throw new Error("Missing synthetic preview");
        await memory.confirmDeletion({
          id: preview.id,
          instanceId: preview.instanceId,
          minimumRestoreEpoch: preview.nextRestoreEpoch,
          deviceId: "synthetic-device",
        });
      }
      const stale = await collect(chat.stream(request));
      expect(stale).toMatchObject([
        {
          type: "error",
          error: {
            code: "MEMORY_CONTEXT_CHANGED",
            message: expect.stringContaining("重新预览"),
          },
        },
      ]);
      expect(proposals).toBe(1);
    },
  );
});

async function collect<T>(events: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const event of events) result.push(event);
  return result;
}
