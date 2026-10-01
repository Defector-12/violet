import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { EnvelopeCipher } from "@violet/crypto";
import {
  MemoryConflictError,
  MemorySourceError,
  type MemoryWriteRequest,
  type ModelGateway,
  type ModelStreamEvent,
} from "@violet/domain";
import { MemorySecretError } from "@violet/policy";
import { VioletClient } from "@violet/sdk";
import Fastify from "fastify";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DeviceAuthenticator } from "../auth/device-authenticator.js";
import { ChatService } from "../conversation/chat-service.js";
import { ContextAssembler } from "../conversation/context-assembler.js";
import { ContextEpochManager } from "../conversation/context-epoch-manager.js";
import { registerMemoryRoutes } from "../http/memory-routes.js";
import { MemoryService } from "../memory/memory-service.js";
import { PostgresContextCheckpointRepository } from "./postgres-context-checkpoint-repository.js";
import { PostgresConversationLedger } from "./postgres-conversation-ledger.js";
import { PostgresMemoryRepository } from "./postgres-memory-repository.js";
import { initializeTestExtensions } from "./postgres-test-database.js";

const databaseUrl = process.env["VIOLET_TEST_DATABASE_URL"];
describe.skipIf(!databaseUrl)("PostgreSQL explicit memory", () => {
  const schema = `violet_memory_${randomUUID().replaceAll("-", "")}`;
  const cipher = new EnvelopeCipher({ key: randomBytes(32), keyVersion: "test-memory-v1" });
  let admin: Pool;
  let pool: Pool;
  let ledger: PostgresConversationLedger;
  let memory: PostgresMemoryRepository;

  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl, max: 1 });
    await initializeTestExtensions(admin);
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({
      connectionString: databaseUrl,
      max: 4,
      options: `-c search_path=${schema},public`,
    });
    for (const migration of [
      "0001_violet_seed.sql",
      "0002_context_checkpoints.sql",
      "0002b_context_turn_failures.sql",
      "0002c_context_event_ids.sql",
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
      instanceId: randomUUID(),
      constitutionVersion: "test",
    });
    await ledger.append({
      content: "升级前的普通原话",
      id: randomUUID(),
      requestId: randomUUID(),
      occurredAt: new Date(),
      role: "user",
    });
    await pool.query(
      await readFile(
        new URL("../../../../infra/migrations/0003_explicit_memory.sql", import.meta.url),
        "utf8",
      ),
    );
    await pool.query(
      await readFile(
        new URL("../../../../infra/migrations/0004_memory_jobs.sql", import.meta.url),
        "utf8",
      ),
    );
    memory = new PostgresMemoryRepository({ cipher, pool });
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin?.end();
  });

  async function source(content = "请记住：我喜欢紫色 🪻") {
    const requestId = randomUUID();
    const message = await ledger.append({
      content,
      requestId,
      id: randomUUID(),
      occurredAt: new Date(),
      role: "user",
      contextEpoch: { id: randomUUID(), startedAt: new Date(0) },
    });
    const state = await memory.state();
    const input: MemoryWriteRequest = {
      requestId,
      sourceEventId: message.id,
      expectedRevision: state.revision,
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

  it("starts empty without extracting any preexisting or ordinary user statements", async () => {
    await source("我平时喜欢阅读。");
    expect((await memory.snapshot()).memories).toEqual([]);
    expect(await memory.summary()).toBeNull();
  });

  it("encrypts semantic fields, verifies multibyte quotes, and reuses the committed outcome", async () => {
    const { input } = await source();
    const changes = await memory.write(input);
    expect(changes).toHaveLength(1);
    expect(await memory.write(input)).toEqual(changes);
    const id = changes[0]?.id ?? "";
    const stored = await memory.get(id);
    expect(stored).toMatchObject([
      {
        content: input.writes[0]?.content,
        version: 1,
        sources: [{ eventId: input.sourceEventId }],
      },
    ]);
    const raw = await pool.query(
      "SELECT row_to_json(m)::text AS value FROM memories m WHERE id = $1",
      [id],
    );
    expect(raw.rows[0]?.value).not.toContain("紫色");
    expect(raw.rows[0]?.value).not.toContain("preference");
    expect(raw.rows[0]?.value).not.toContain("normal");
    const different = await source();
    await expect(memory.write({ ...different.input, requestId: input.requestId })).rejects.toThrow(
      MemoryConflictError,
    );
  });

  it("rolls back a batch with one invalid quote, including a split emoji", async () => {
    const { input } = await source();
    const write = required(input.writes[0]);
    await expect(
      memory.write({
        ...input,
        writes: [
          write,
          { ...write, source: { ...write.source, endByte: write.source.endByte - 1 } },
        ],
      }),
    ).rejects.toThrow(MemorySourceError);
    expect(await memory.changesForRequest(input.requestId)).toBeNull();
    expect((await memory.state()).revision).toBe(input.expectedRevision);
  });

  it("rejects assistant, failed and cross-request sources", async () => {
    const { input, message } = await source();
    const assistant = await ledger.append({
      content: "助手猜测",
      requestId: input.requestId,
      id: randomUUID(),
      occurredAt: new Date(),
      role: "assistant",
    });
    await expect(memory.write({ ...input, sourceEventId: assistant.id })).rejects.toThrow(
      MemorySourceError,
    );
    await expect(memory.write({ ...input, requestId: randomUUID() })).rejects.toThrow(
      MemorySourceError,
    );
    const failed = await source();
    await ledger.markRequestFailed(
      failed.input.requestId,
      required(failed.message.contextEpochId),
      new Date(),
    );
    await expect(memory.write(failed.input)).rejects.toThrow(MemorySourceError);
    expect(message.role).toBe("user");
  });

  it("rejects secrets and requires controlled content to remain verbatim", async () => {
    const secret = await source("记住我的密码是 synthetic-not-a-real-password");
    await expect(memory.write(secret.input)).rejects.toThrow(MemorySecretError);
    const sensitive = await source("请记住，我对花生过敏。");
    await expect(memory.write(sensitive.input)).rejects.toThrow(MemorySourceError);
    const write = required(sensitive.input.writes[0]);
    const changes = await memory.write({
      ...sensitive.input,
      writes: [{ ...write, sensitivity: "controlled" }],
    });
    expect(await memory.get(required(changes[0]).id)).toMatchObject([
      { content: sensitive.message.content, sensitivity: "controlled" },
    ]);
  });

  it("appends a correction once and invalidates the summary and all checkpoints", async () => {
    const first = await source("请记住，我喜欢红色。");
    const created = required((await memory.write(first.input))[0]);
    const before = await memory.state();
    expect(await memory.saveSummary({ revision: before.revision, content: "旧摘要" })).toBe(true);
    const correction = await source("纠正一下，我现在喜欢蓝色。");
    const input: MemoryWriteRequest = {
      ...correction.input,
      writes: [
        {
          ...required(correction.input.writes[0]),
          target: { id: created.id, version: 1, action: "correct" },
        },
      ],
    };
    expect(await memory.write(input)).toEqual([{ id: created.id, version: 2, kind: "corrected" }]);
    expect(await memory.write(input)).toEqual([{ id: created.id, version: 2, kind: "corrected" }]);
    expect(await memory.get(created.id)).toMatchObject([
      { version: 2, state: "current" },
      { version: 1, state: "superseded" },
    ]);
    expect(await memory.summary()).toBeNull();
    expect(await memory.saveSummary({ revision: before.revision, content: "迟到旧摘要" })).toBe(
      false,
    );
    expect((await memory.state()).deletionRevision).toBe(before.deletionRevision + 1);
  });

  it("rejects stale preview confirmation before deleting anything, and requires a stored epoch", async () => {
    const { input } = await source();
    const created = required((await memory.write(input))[0]);
    const preview = await memory.previewDeletion(randomUUID(), {
      kind: "memory",
      id: created.id,
      version: 1,
    });
    await expect(
      memory.confirmDeletion({
        id: preview.id,
        instanceId: preview.instanceId,
        minimumRestoreEpoch: preview.restoreEpoch,
        deviceId: "test",
      }),
    ).rejects.toThrow("Persist the minimum");
    await ledger.append({
      content: "来源轮次新增回复，改变了预览影响范围",
      id: randomUUID(),
      requestId: input.requestId,
      occurredAt: new Date(),
      role: "assistant",
    });
    await expect(
      memory.confirmDeletion({
        id: preview.id,
        instanceId: preview.instanceId,
        minimumRestoreEpoch: preview.nextRestoreEpoch,
        deviceId: "test",
      }),
    ).rejects.toThrow("impact changed");
    expect(await memory.get(created.id)).toHaveLength(1);
  });

  it("deletes the entire source turn, rejects delayed writes, and is idempotent", async () => {
    const { input, message } = await source("请记住，我喜欢绿色。");
    const created = required((await memory.write(input))[0]);
    const assistant = await ledger.append({
      content: "记住了",
      requestId: input.requestId,
      id: randomUUID(),
      occurredAt: new Date(),
      role: "assistant",
    });
    const target = { kind: "memory" as const, id: created.id, version: 1 };
    const preview = await memory.previewDeletion(randomUUID(), target);
    expect(await memory.previewDeletion(preview.id, target)).toEqual(preview);
    expect(preview.eventIds).toEqual([message.id, assistant.id]);
    expect(preview.deletedMemoryIds).toEqual([created.id]);
    const confirm = {
      id: preview.id,
      instanceId: preview.instanceId,
      minimumRestoreEpoch: preview.nextRestoreEpoch,
      deviceId: "test",
    };
    const status = await memory.confirmDeletion(confirm);
    expect(status.status).toBe("pending");
    expect(await memory.confirmDeletion(confirm)).toEqual(status);
    expect(await ledger.findByRequest(input.requestId, "user")).toBeNull();
    expect(await ledger.findByRequest(input.requestId, "assistant")).toBeNull();
    expect(await memory.get(created.id)).toEqual([]);
    await expect(
      memory.write({ ...input, expectedRevision: (await memory.state()).revision }),
    ).rejects.toThrow(MemorySourceError);
    await expect(
      ledger.append({
        content: "迟到的助手回答",
        requestId: input.requestId,
        id: randomUUID(),
        occurredAt: new Date(),
        role: "assistant",
      }),
    ).rejects.toThrow("has been deleted");
    const failed = await memory.setCleanupStatus(preview.id, "failed", "BACKUP_UNAVAILABLE");
    expect(await memory.deletionStatus(preview.id)).toEqual(failed);
    expect((await memory.setCleanupStatus(preview.id, "pending")).status).toBe("pending");
    expect((await memory.state()).restoreEpoch).toBe(preview.nextRestoreEpoch);
  });

  it("keeps a memory with another source and never revives an old corrected version", async () => {
    const first = await source("请记住，我喜欢白色。");
    const created = required((await memory.write(first.input))[0]);
    const second = await source(first.message.content);
    await memory.write({
      ...second.input,
      writes: [
        {
          ...required(second.input.writes[0]),
          target: { id: created.id, version: 1, action: "add_source" },
        },
      ],
    });
    const preview = await memory.previewDeletion(randomUUID(), {
      kind: "source",
      eventId: first.message.id,
    });
    expect(preview.retainedMemoryIds).toEqual([created.id]);
    await memory.confirmDeletion({
      id: preview.id,
      instanceId: preview.instanceId,
      minimumRestoreEpoch: preview.nextRestoreEpoch,
      deviceId: "test",
    });
    expect((await memory.get(created.id))[0]?.sources).toHaveLength(1);
    const correction = await source("纠正，我喜欢黑色。");
    await memory.write({
      ...correction.input,
      writes: [
        {
          ...required(correction.input.writes[0]),
          target: { id: created.id, version: 1, action: "correct" },
        },
      ],
    });
    const removeCorrection = await memory.previewDeletion(randomUUID(), {
      kind: "source",
      eventId: correction.message.id,
    });
    await memory.confirmDeletion({
      id: removeCorrection.id,
      instanceId: removeCorrection.instanceId,
      minimumRestoreEpoch: removeCorrection.nextRestoreEpoch,
      deviceId: "test",
    });
    expect((await memory.snapshot()).memories.some((item) => item.id === created.id)).toBe(false);
    expect(await memory.get(created.id)).toMatchObject([{ version: 1, state: "superseded" }]);
  });

  it("serializes concurrent correction attempts without duplicate versions", async () => {
    const initial = await source("请记住，我的项目叫 A。");
    const created = required((await memory.write(initial.input))[0]);
    const one = await source("纠正，项目叫 B。");
    const two = await source("纠正，项目叫 C。");
    const results = await Promise.allSettled(
      [one, two].map(({ input }) =>
        memory.write({
          ...input,
          writes: [
            {
              ...required(input.writes[0]),
              target: { id: created.id, version: 1, action: "correct" },
            },
          ],
        }),
      ),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await memory.get(created.id)).toHaveLength(2);
  });

  it("clears learned memory and its sources while retaining unrelated conversation", async () => {
    const unrelated = await source("这个普通问题没有长期记忆");
    const preview = await memory.previewDeletion(randomUUID(), { kind: "all" });
    await memory.confirmDeletion({
      id: preview.id,
      instanceId: preview.instanceId,
      minimumRestoreEpoch: preview.nextRestoreEpoch,
      deviceId: "test",
    });
    expect((await memory.snapshot()).memories).toEqual([]);
    expect(await ledger.findByRequest(unrelated.input.requestId, "user")).not.toBeNull();
    expect(await memory.summary()).toBeNull();
    const tombstones = await pool.query(
      "SELECT row_to_json(t)::text AS value FROM deletion_tombstones t",
    );
    expect(tombstones.rows.every((row) => !row.value.includes("content"))).toBe(true);
  });

  it("serves authenticated governance through the SDK, masks sensitive sources, and enforces confirmation", async () => {
    const token = "synthetic-memory-test-device";
    const service = new MemoryService({
      repository: memory,
      ledger,
      epochManager: new ContextEpochManager({ generateId: randomUUID }),
    });
    const app = Fastify();
    registerMemoryRoutes(app, {
      authenticator: new DeviceAuthenticator({
        expectedHashHex: createHash("sha256").update(token).digest("hex"),
        expiresAt: new Date("2099-01-01T00:00:00Z"),
      }),
      sealed: false,
      memory: service,
    });
    const client = new VioletClient({
      baseUrl: "http://memory.test",
      deviceToken: token,
      fetch: async (url, init) => {
        const response = await app.inject({
          method: (init?.method ?? "GET") as "GET" | "POST",
          url: new URL(String(url)).pathname + new URL(String(url)).search,
          headers: init?.headers as Record<string, string>,
          ...(init?.body ? { payload: String(init.body) } : {}),
        });
        return new Response(response.body, {
          status: response.statusCode,
          headers: { "content-type": "application/json" },
        });
      },
    });
    try {
      expect((await app.inject({ url: "/v1/memories" })).statusCode).toBe(401);
      const settings = await client.getMemorySettings();
      expect(settings.enabled).toBe(false);
      const enable = {
        requestId: randomUUID(),
        expectedRevision: settings.revision,
        enabled: true,
      };
      expect((await client.updateMemorySettings(enable)).enabled).toBe(true);
      const disable = {
        requestId: randomUUID(),
        expectedRevision: settings.revision + 1,
        enabled: false,
      };
      expect((await client.updateMemorySettings(disable)).enabled).toBe(false);
      expect((await client.updateMemorySettings(enable)).enabled).toBe(false);
      await expect(
        client.updateMemorySettings({ ...enable, requestId: randomUUID() }),
      ).rejects.toMatchObject({ status: 409 });
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/v1/memory-settings",
            headers: { authorization: `Bearer ${token}` },
            payload: { ...enable, extra: true },
          })
        ).statusCode,
      ).toBe(400);
      const sensitive = await source("请记住，我对花生过敏。");
      const created = required(
        (
          await memory.write({
            ...sensitive.input,
            writes: [{ ...required(sensitive.input.writes[0]), sensitivity: "controlled" }],
          })
        )[0],
      );
      const list = await client.listMemories();
      expect(list.memories.find((item) => item.id === created.id)).toMatchObject({
        redacted: true,
      });
      expect(JSON.stringify(list)).not.toContain("花生");
      expect(JSON.stringify(await client.getMemory(created.id))).not.toContain("花生");
      expect(JSON.stringify(await client.getMemory(created.id, true))).toContain("花生");
      const correction = {
        requestId: randomUUID(),
        expectedVersion: 1,
        content: "纠正，我对核桃过敏。",
      };
      const changes = await client.correctMemory(created.id, correction);
      expect(changes.memoryChanges).toMatchObject([{ version: 2, kind: "corrected" }]);
      expect(await client.correctMemory(created.id, correction)).toEqual(changes);
      await expect(
        client.correctMemory(created.id, { ...correction, content: "不同内容" }),
      ).rejects.toThrow("different content");
      const preview = await client.previewMemoryDeletion({
        id: randomUUID(),
        target: { kind: "memory", id: created.id, version: 2 },
      });
      expect(preview.events.filter((event) => event.role === "user")).toHaveLength(2);
      expect(JSON.stringify(preview)).not.toContain("核桃");
      await expect(
        client.confirmMemoryDeletion(preview.id, {
          instanceId: preview.instanceId,
          minimumRestoreEpoch: Math.max(1, preview.restoreEpoch),
        }),
      ).rejects.toThrow("Persist the minimum");
      expect(
        (
          await client.confirmMemoryDeletion(preview.id, {
            instanceId: preview.instanceId,
            minimumRestoreEpoch: preview.nextRestoreEpoch,
          })
        ).status,
      ).toBe("pending");
      expect((await client.getMemoryDeletionStatus(preview.id)).restoreEpoch).toBe(
        preview.nextRestoreEpoch,
      );
      expect((await client.retryMemoryBackupCleanup(preview.id)).status).toBe("pending");
      await expect(client.getMemory(created.id)).rejects.toThrow("not found");
    } finally {
      await app.close();
    }
  });
  it("commits explicit chat memory before any success, replays one result, and leaves 20 ordinary turns unlearned", async () => {
    let proposals = 0;
    const model: ModelGateway = {
      async *stream(request): AsyncIterable<ModelStreamEvent> {
        if (request.jsonOutput) {
          proposals++;
          const data = JSON.parse(request.messages.at(-1)?.content ?? "{}");
          yield {
            type: "delta",
            content: JSON.stringify(
              data.finalUser.includes("请记住")
                ? {
                    intent: "write",
                    writes: [
                      { content: "我喜欢海蓝色", quote: "我喜欢海蓝色", kind: "preference" },
                    ],
                  }
                : { intent: "none", history: false },
            ),
          };
        } else yield { type: "delta", content: "普通回答" };
        yield { type: "complete", inputTokens: 1, outputTokens: 1 };
      },
    };
    const epochs = new ContextEpochManager({ generateId: randomUUID });
    const service = new MemoryService({ repository: memory, ledger, epochManager: epochs, model });
    const assembler = new ContextAssembler({
      checkpoints: new PostgresContextCheckpointRepository({ cipher, pool }),
      ledger,
      model,
      memoryService: service,
    });
    const chat = new ChatService({
      contextAssembler: assembler,
      epochManager: epochs,
      generateId: randomUUID,
      ledger,
      modelGateway: model,
      memoryService: service,
    });
    const request = { requestId: randomUUID(), message: "请记住，我喜欢海蓝色" };
    const events = [];
    for await (const event of chat.stream(request)) {
      if (event.type === "delta")
        expect(await memory.changesForRequest(request.requestId)).toHaveLength(1);
      events.push(event);
    }
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "complete",
        memoryChanges: [expect.objectContaining({ kind: "created" })],
      }),
    );
    const prior = await memory.changesForRequest(request.requestId);
    for await (const _event of chat.stream(request)) {
      /* consume idempotent replay */
    }
    expect(proposals).toBe(1);
    expect(await memory.changesForRequest(request.requestId)).toEqual(prior);
    const revision = (await memory.state()).revision;
    for (let index = 0; index < 20; index++) {
      for await (const event of chat.stream({
        requestId: randomUUID(),
        message: `普通陈述 ${index}`,
      })) {
        expect(event.type).not.toBe("error");
      }
    }
    expect((await memory.state()).revision).toBe(revision);
    expect((await service.context()).summary).toContain("海蓝色");
    const secretRequest = {
      requestId: randomUUID(),
      message: "请记住，密码是 synthetic-test-value",
    };
    for await (const event of chat.stream(secretRequest)) expect(event.type).toBe("error");
    expect(await ledger.findByRequest(secretRequest.requestId, "user")).toBeNull();
  });

  it("excludes superseded source turns from new contexts and recall, including after restart", async () => {
    const initial = await source("请记住，我的项目代号是陈旧橡树。");
    const created = required((await memory.write(initial.input))[0]);
    await ledger.append({
      id: randomUUID(),
      requestId: initial.input.requestId,
      content: "陈旧橡树",
      role: "assistant",
      occurredAt: new Date(),
    });
    const service = new MemoryService({
      repository: memory,
      ledger,
      epochManager: new ContextEpochManager({ generateId: randomUUID }),
    });
    await service.correct(created.id, {
      requestId: randomUUID(),
      expectedVersion: 1,
      content: "项目代号改成新生杉木。",
    });
    const restarted = new MemoryService({
      repository: new PostgresMemoryRepository({ cipher, pool }),
      ledger,
      epochManager: new ContextEpochManager({ generateId: randomUUID }),
    });
    const context = await restarted.context();
    expect(context.excludedRequests.has(initial.input.requestId)).toBe(true);
    expect(context.summary).not.toContain("陈旧橡树");
    expect(await restarted.recall({ query: "陈旧橡树" }, true)).toMatchObject({
      status: "not_found",
      items: [],
    });
    const assembler = new ContextAssembler({
      checkpoints: new PostgresContextCheckpointRepository({ cipher, pool }),
      ledger,
      memoryService: restarted,
      model: {
        stream(): AsyncIterable<ModelStreamEvent> {
          throw new Error("Should fit");
        },
      },
    });
    expect(
      JSON.stringify(
        await assembler.assemble({ contextEpochId: required(initial.message.contextEpochId) }),
      ),
    ).not.toContain("陈旧橡树");
    const disabled = new MemoryService({
      repository: memory,
      ledger,
      epochManager: new ContextEpochManager({ generateId: randomUUID }),
      injectionEnabled: false,
    });
    expect((await disabled.context()).summary).toBe("");
    expect((await disabled.context()).excludedRequests.has(initial.input.requestId)).toBe(true);
    expect(await disabled.recall({ query: "新生杉木" }, true)).toMatchObject({
      status: "not_found",
      items: [],
    });
    expect((await disabled.list()).memories.some((item) => item.id === created.id)).toBe(true);
  });

  it("does not commit a cancelled or failed proposal and makes a natural-language deletion preview confirmable", async () => {
    const controller = new AbortController();
    const candidate = await source("请记住，我喜欢玫瑰。");
    const model: ModelGateway = {
      async *stream(): AsyncIterable<ModelStreamEvent> {
        controller.abort();
        yield {
          type: "delta",
          content:
            '{"intent":"write","writes":[{"content":"我喜欢玫瑰","quote":"我喜欢玫瑰","kind":"preference"}]}',
        };
        yield { type: "complete", inputTokens: 1, outputTokens: 1 };
      },
    };
    const epochs = new ContextEpochManager({ generateId: randomUUID });
    const cancelled = new MemoryService({
      repository: memory,
      ledger,
      epochManager: epochs,
      model,
    });
    await expect(cancelled.prepareTurn(candidate.message, controller.signal)).rejects.toThrow();
    expect(await memory.changesForRequest(candidate.input.requestId)).toBeNull();
    const target = required((await memory.write(candidate.input))[0]);
    const deleting = new MemoryService({
      repository: memory,
      ledger,
      epochManager: epochs,
      model: {
        async *stream(): AsyncIterable<ModelStreamEvent> {
          yield {
            type: "delta",
            content: JSON.stringify({ intent: "forget", id: target.id, version: 1 }),
          };
          yield { type: "complete", inputTokens: 1, outputTokens: 1 };
        },
      },
    });
    const deletionSource = await source("请忘掉我喜欢玫瑰这件事。");
    const result = await deleting.prepareTurn(deletionSource.message);
    expect(result.deletionPreviewId).toBe(deletionSource.input.requestId);
    await ledger.append({
      id: randomUUID(),
      requestId: deletionSource.input.requestId,
      content: required(result.reply),
      role: "assistant",
      occurredAt: new Date(),
    });
    const preview = await deleting.getPreview(required(result.deletionPreviewId));
    expect(
      await deleting.confirm(
        preview.id,
        { instanceId: preview.instanceId, minimumRestoreEpoch: preview.nextRestoreEpoch },
        "test",
      ),
    ).toMatchObject({ status: "pending" });
    await expect(
      ledger.markRequestFailed(
        candidate.input.requestId,
        required(candidate.message.contextEpochId),
        new Date(),
      ),
    ).resolves.toBeUndefined();
    expect(await deleting.recall({ query: "玫瑰" }, false)).toMatchObject({ status: "not_found" });
  });

  it("cancels an in-flight answer on correction even if the provider ignores abort", async () => {
    const initial = await source("请记住，我的茶偏好是旧乌龙。");
    const target = required((await memory.write(initial.input))[0]);
    let release = () => {};
    let notifyStarted = () => {};
    const generated = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    const model: ModelGateway = {
      async *stream(request): AsyncIterable<ModelStreamEvent> {
        if (request.jsonOutput)
          yield { type: "delta", content: '{"intent":"none","history":false}' };
        else {
          notifyStarted();
          await generated;
          yield { type: "delta", content: "已过时的旧乌龙回答" };
        }
        yield { type: "complete", inputTokens: 1, outputTokens: 1 };
      },
    };
    const epochs = new ContextEpochManager({ generateId: randomUUID });
    const service = new MemoryService({ repository: memory, ledger, epochManager: epochs, model });
    const chat = new ChatService({
      contextAssembler: new ContextAssembler({
        checkpoints: new PostgresContextCheckpointRepository({ cipher, pool }),
        ledger,
        model,
        memoryService: service,
      }),
      epochManager: epochs,
      generateId: randomUUID,
      ledger,
      modelGateway: model,
      memoryService: service,
    });
    const requestId = randomUUID();
    const iterator = chat.stream({ requestId, message: "我喜欢什么茶？" })[Symbol.asyncIterator]();
    expect((await iterator.next()).value?.type).toBe("start");
    const answering = iterator.next();
    await started;
    await service.correct(target.id, {
      requestId: randomUUID(),
      expectedVersion: 1,
      content: "茶偏好纠正为新龙井。",
    });
    release();
    expect((await answering).value).toMatchObject({
      type: "error",
      error: { code: "MEMORY_CONTEXT_CHANGED" },
    });
    await iterator.next();
    expect(await ledger.findByRequest(requestId, "assistant")).toBeNull();
  });
});

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing expected test value");
  return value;
}
