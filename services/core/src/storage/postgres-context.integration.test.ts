import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { EnvelopeCipher } from "@violet/crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ContextEpochManager } from "../conversation/context-epoch-manager.js";
import { PostgresContextCheckpointRepository } from "./postgres-context-checkpoint-repository.js";
import { PostgresConversationLedger } from "./postgres-conversation-ledger.js";

const databaseUrl = process.env["VIOLET_TEST_DATABASE_URL"];
const integration = describe.skipIf(!databaseUrl);

integration("PostgreSQL conversation context", () => {
  const schema = `violet_test_${randomUUID().replaceAll("-", "")}`;
  let admin: Pool;
  let pool: Pool;

  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl, max: 1 });
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
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin?.end();
  });

  it("upgrades 0001, groups interleaved turns, and encrypts a rolling checkpoint", async () => {
    const cipher = new EnvelopeCipher({
      key: randomBytes(32),
      keyVersion: "test-content-v1",
    });
    const ledger = new PostgresConversationLedger({
      cipher,
      constitutionVersion: "test",
      instanceId: randomUUID(),
      pool,
    });
    const contextEpoch = {
      id: randomUUID(),
      startedAt: new Date("2026-09-16T00:00:00.000Z"),
    };
    const firstRequest = randomUUID();
    const secondRequest = randomUUID();
    const contextEventId = randomUUID();
    const contextSourceId = randomUUID();
    await Promise.all([
      ledger.append({
        content: "Question one",
        contextEpoch,
        contextEventId,
        contextSourceId,
        id: randomUUID(),
        occurredAt: contextEpoch.startedAt,
        requestId: firstRequest,
        role: "user",
      }),
      ledger.append({
        content: "Question two",
        contextEpoch,
        id: randomUUID(),
        occurredAt: contextEpoch.startedAt,
        requestId: secondRequest,
        role: "user",
      }),
    ]);
    await Promise.all([
      ledger.append({
        content: "Answer one",
        contextEpoch,
        id: randomUUID(),
        occurredAt: new Date(contextEpoch.startedAt.getTime() + 1_000),
        requestId: firstRequest,
        role: "assistant",
      }),
      ledger.append({
        content: "Answer two",
        contextEpoch,
        id: randomUUID(),
        occurredAt: new Date(contextEpoch.startedAt.getTime() + 1_000),
        requestId: secondRequest,
        role: "assistant",
      }),
    ]);

    const turns = await ledger.listTurns({
      completeOnly: true,
      contextEpochId: contextEpoch.id,
    });
    expect(turns).toHaveLength(2);
    expect(turns.every((turn) => turn.messages.length === 2)).toBe(true);
    expect(turns.map((turn) => new Set(turn.messages.map((message) => message.requestId)))).toEqual(
      [new Set([turns[0]?.requestId]), new Set([turns[1]?.requestId])],
    );
    await expect(ledger.findByRequest(firstRequest, "user")).resolves.toMatchObject({
      contextEventId,
      contextSourceId,
    });
    await expect(
      ledger.append({
        content: "Invalid assistant context",
        contextEventId,
        contextSourceId,
        id: randomUUID(),
        occurredAt: contextEpoch.startedAt,
        requestId: randomUUID(),
        role: "assistant",
      }),
    ).rejects.toThrow("Context references require a user event ID and source ID");

    const checkpoints = new PostgresContextCheckpointRepository({ cipher, pool });
    const saved = await checkpoints.save({
      content: "Encrypted checkpoint",
      contextEpochId: contextEpoch.id,
      deletionRevision: 0,
      fromSequence: Math.min(...turns.map((turn) => turn.startSequence)),
      throughSequence: Math.max(...turns.map((turn) => turn.throughSequence)),
      updatedAt: new Date("2026-09-16T00:01:00.000Z"),
    });
    expect(saved).toBe(true);
    await expect(checkpoints.get(contextEpoch.id)).resolves.toMatchObject({
      content: "Encrypted checkpoint",
      deletionRevision: 0,
    });

    const raw = await pool.query<{ ciphertext: Buffer }>(
      "SELECT ciphertext FROM context_checkpoints WHERE context_epoch_id = $1",
      [contextEpoch.id],
    );
    expect(raw.rows[0]?.ciphertext.toString("utf8")).not.toContain("Encrypted checkpoint");

    const concurrentEpoch = {
      id: randomUUID(),
      startedAt: new Date("2026-09-16T00:03:00.000Z"),
    };
    const pendingRequest = randomUUID();
    const laterRequest = randomUUID();
    const pendingUser = await ledger.append({
      content: "Pending question",
      contextEpoch: concurrentEpoch,
      id: randomUUID(),
      occurredAt: concurrentEpoch.startedAt,
      requestId: pendingRequest,
      role: "user",
    });
    await ledger.append({
      content: "Later question",
      contextEpoch: concurrentEpoch,
      id: randomUUID(),
      occurredAt: concurrentEpoch.startedAt,
      requestId: laterRequest,
      role: "user",
    });
    const laterAssistant = await ledger.append({
      content: "Later answer",
      contextEpoch: concurrentEpoch,
      id: randomUUID(),
      occurredAt: concurrentEpoch.startedAt,
      requestId: laterRequest,
      role: "assistant",
    });
    await expect(
      checkpoints.save({
        content: "Must not cross an incomplete turn",
        contextEpochId: concurrentEpoch.id,
        deletionRevision: 0,
        fromSequence: pendingUser.sequence,
        throughSequence: laterAssistant.sequence,
        updatedAt: new Date("2026-09-16T00:04:00.000Z"),
      }),
    ).resolves.toBe(false);
    await ledger.markRequestFailed(
      pendingRequest,
      concurrentEpoch.id,
      new Date("2026-09-16T00:04:30.000Z"),
    );
    await expect(ledger.listTurns({ contextEpochId: concurrentEpoch.id })).resolves.toMatchObject([
      { completed: false, failed: true, requestId: pendingRequest },
      { completed: true, failed: false, requestId: laterRequest },
    ]);
    await expect(
      checkpoints.save({
        content: "Complete prefix with a terminal failure",
        contextEpochId: concurrentEpoch.id,
        deletionRevision: 0,
        fromSequence: pendingUser.sequence,
        throughSequence: laterAssistant.sequence,
        updatedAt: new Date("2026-09-16T00:04:31.000Z"),
      }),
    ).resolves.toBe(true);
    await ledger.clearRequestFailure(pendingRequest);
    await expect(
      ledger.isCompletePrefix(concurrentEpoch.id, laterAssistant.sequence),
    ).resolves.toBe(false);
    await expect(
      ledger.isCompletePrefix(concurrentEpoch.id, laterAssistant.sequence, [pendingRequest]),
    ).resolves.toBe(true);
    const pendingAssistant = await ledger.append({
      content: "Pending answer",
      contextEpoch: concurrentEpoch,
      id: randomUUID(),
      occurredAt: concurrentEpoch.startedAt,
      requestId: pendingRequest,
      role: "assistant",
    });
    await expect(
      ledger.isCompletePrefix(concurrentEpoch.id, laterAssistant.sequence, [pendingRequest]),
    ).resolves.toBe(true);
    await expect(
      checkpoints.save({
        content: "Complete contiguous prefix",
        contextEpochId: concurrentEpoch.id,
        deletionRevision: 0,
        fromSequence: pendingUser.sequence,
        throughSequence: pendingAssistant.sequence,
        updatedAt: new Date("2026-09-16T00:05:00.000Z"),
      }),
    ).resolves.toBe(true);

    await pool.query("UPDATE violet_instances SET deletion_revision = 1 WHERE singleton = true");
    await expect(checkpoints.get(contextEpoch.id)).resolves.toBeNull();
    await expect(
      checkpoints.save({
        content: "Stale checkpoint",
        contextEpochId: contextEpoch.id,
        deletionRevision: 0,
        fromSequence: 1,
        throughSequence: 4,
        updatedAt: new Date("2026-09-16T00:02:00.000Z"),
      }),
    ).resolves.toBe(false);
  });

  it("backfills existing user-only turns as terminal failures during upgrade", async () => {
    const upgradeSchema = `violet_upgrade_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE SCHEMA "${upgradeSchema}"`);
    const upgradePool = new Pool({
      connectionString: databaseUrl,
      max: 1,
      options: `-c search_path=${upgradeSchema},public`,
    });
    try {
      for (const migration of ["0001_violet_seed.sql", "0002_context_checkpoints.sql"]) {
        await upgradePool.query(
          await readFile(
            new URL(`../../../../infra/migrations/${migration}`, import.meta.url),
            "utf8",
          ),
        );
      }
      const cipher = new EnvelopeCipher({
        key: randomBytes(32),
        keyVersion: "test-content-v1",
      });
      const instanceId = randomUUID();
      const epochId = randomUUID();
      const requestId = randomUUID();
      const envelope = cipher.encrypt(Buffer.from("Interrupted request", "utf8"));
      await upgradePool.query(
        `
          INSERT INTO violet_instances (
            singleton, id, name, constitution_version, next_event_sequence, created_at
          )
          VALUES (true, $1, 'Violet', 'test', 2, $2)
        `,
        [instanceId, new Date("2026-09-16T00:00:00.000Z")],
      );
      await upgradePool.query(
        `
          INSERT INTO context_epochs (
            instance_id, id, started_at, last_user_input_at
          )
          VALUES ($1, $2, $3, $3)
        `,
        [instanceId, epochId, new Date("2026-09-16T00:00:00.000Z")],
      );
      await upgradePool.query(
        `
          INSERT INTO conversation_events (
            id, instance_id, request_id, sequence, role, context_epoch_id,
            algorithm, key_version, ciphertext, content_nonce, content_tag,
            wrapped_key, key_nonce, key_tag, occurred_at
          )
          VALUES (
            $1, $2, $3, 1, 'user', $4,
            $5, $6, $7, $8, $9,
            $10, $11, $12, $13
          )
        `,
        [
          randomUUID(),
          instanceId,
          requestId,
          epochId,
          envelope.algorithm,
          envelope.keyVersion,
          envelope.ciphertext,
          envelope.contentNonce,
          envelope.contentTag,
          envelope.wrappedKey,
          envelope.keyNonce,
          envelope.keyTag,
          new Date("2026-09-16T00:00:00.000Z"),
        ],
      );

      await upgradePool.query(
        await readFile(
          new URL("../../../../infra/migrations/0002b_context_turn_failures.sql", import.meta.url),
          "utf8",
        ),
      );
      await upgradePool.query(
        await readFile(
          new URL("../../../../infra/migrations/0002c_context_event_ids.sql", import.meta.url),
          "utf8",
        ),
      );

      await expect(
        upgradePool.query<{ request_id: string }>(
          "SELECT request_id FROM conversation_turn_failures",
        ),
      ).resolves.toMatchObject({ rows: [{ request_id: requestId }] });
      await expect(
        upgradePool.query<{ column_name: string }>(
          `
            SELECT column_name
            FROM information_schema.columns
            WHERE table_schema = $1
              AND table_name = 'conversation_events'
              AND column_name IN ('context_event_id', 'context_source_id')
            ORDER BY column_name
          `,
          [upgradeSchema],
        ),
      ).resolves.toMatchObject({
        rows: [{ column_name: "context_event_id" }, { column_name: "context_source_id" }],
      });
      await expect(
        upgradePool.query<{ convalidated: boolean }>(
          `
            SELECT constraint_record.convalidated
            FROM pg_constraint AS constraint_record
            JOIN pg_namespace AS namespace
              ON namespace.oid = constraint_record.connamespace
            WHERE namespace.nspname = $1
              AND constraint_record.conname = 'conversation_events_context_event_user_only'
          `,
          [upgradeSchema],
        ),
      ).resolves.toMatchObject({ rows: [{ convalidated: false }] });
    } finally {
      await upgradePool.end();
      await admin.query(`DROP SCHEMA IF EXISTS "${upgradeSchema}" CASCADE`);
    }
  });

  it("persists a delayed cross-modal input without violating the epoch timestamp constraint", async () => {
    const cipher = new EnvelopeCipher({
      key: randomBytes(32),
      keyVersion: "test-content-v1",
    });
    const ledger = new PostgresConversationLedger({
      cipher,
      constitutionVersion: "test",
      instanceId: randomUUID(),
      pool,
    });
    const epochManager = new ContextEpochManager({ generateId: randomUUID });
    const earlierAt = new Date("2026-09-16T00:00:00.000Z");
    const laterAt = new Date("2026-09-16T00:00:01.000Z");
    const epoch = epochManager.acceptUserInput(laterAt);

    await ledger.append({
      content: "Later input admitted first",
      contextEpoch: epoch,
      id: randomUUID(),
      occurredAt: laterAt,
      requestId: randomUUID(),
      role: "user",
    });
    const delayedEpoch = epochManager.acceptUserInput(earlierAt);

    await expect(
      ledger.append({
        content: "Earlier input persisted later",
        contextEpoch: delayedEpoch,
        id: randomUUID(),
        occurredAt: earlierAt,
        requestId: randomUUID(),
        role: "user",
      }),
    ).resolves.toMatchObject({
      content: "Earlier input persisted later",
      contextEpochId: epoch.id,
    });
  });

  it("recovers persisted user-only turns after a process restart", async () => {
    const cipher = new EnvelopeCipher({
      key: randomBytes(32),
      keyVersion: "test-content-v1",
    });
    const ledger = new PostgresConversationLedger({
      cipher,
      constitutionVersion: "test",
      instanceId: randomUUID(),
      pool,
    });
    const contextEpoch = {
      id: randomUUID(),
      startedAt: new Date("2026-09-16T00:10:00.000Z"),
    };
    const requestId = randomUUID();
    await ledger.append({
      content: "Interrupted before the previous process exited",
      contextEpoch,
      id: randomUUID(),
      occurredAt: contextEpoch.startedAt,
      requestId,
      role: "user",
    });

    await expect(ledger.recoverIncompleteRequests(new Date())).resolves.toBeGreaterThan(0);
    await expect(ledger.listTurns({ contextEpochId: contextEpoch.id })).resolves.toMatchObject([
      { completed: false, failed: true, requestId },
    ]);
    await expect(ledger.recoverIncompleteRequests(new Date())).resolves.toBe(0);

    const completedRequestId = randomUUID();
    await ledger.append({
      content: "Question completed while failure recovery runs",
      contextEpoch,
      id: randomUUID(),
      occurredAt: contextEpoch.startedAt,
      requestId: completedRequestId,
      role: "user",
    });
    await Promise.all([
      ledger.markRequestFailed(completedRequestId, contextEpoch.id, new Date()),
      ledger.append({
        content: "Completed answer",
        contextEpoch,
        id: randomUUID(),
        occurredAt: new Date(),
        requestId: completedRequestId,
        role: "assistant",
      }),
    ]);
    await expect(
      pool.query("SELECT 1 FROM conversation_turn_failures WHERE request_id = $1", [
        completedRequestId,
      ]),
    ).resolves.toMatchObject({ rowCount: 0 });
  });

  it("waits for a concurrent failure-marker clear before validating a checkpoint prefix", async () => {
    const cipher = new EnvelopeCipher({
      key: randomBytes(32),
      keyVersion: "test-content-v1",
    });
    const ledger = new PostgresConversationLedger({
      cipher,
      constitutionVersion: "test",
      instanceId: randomUUID(),
      pool,
    });
    const contextEpoch = {
      id: randomUUID(),
      startedAt: new Date("2026-09-16T00:20:00.000Z"),
    };
    const failedRequestId = randomUUID();
    const completedRequestId = randomUUID();
    await ledger.append({
      content: "Failed question",
      contextEpoch,
      id: randomUUID(),
      occurredAt: contextEpoch.startedAt,
      requestId: failedRequestId,
      role: "user",
    });
    await ledger.markRequestFailed(failedRequestId, contextEpoch.id, contextEpoch.startedAt);
    await ledger.append({
      content: "Later question",
      contextEpoch,
      id: randomUUID(),
      occurredAt: contextEpoch.startedAt,
      requestId: completedRequestId,
      role: "user",
    });
    const laterAssistant = await ledger.append({
      content: "Later answer",
      contextEpoch,
      id: randomUUID(),
      occurredAt: contextEpoch.startedAt,
      requestId: completedRequestId,
      role: "assistant",
    });

    const clearClient = await pool.connect();
    try {
      await clearClient.query("BEGIN");
      await clearClient.query("SELECT id FROM violet_instances WHERE singleton = true FOR UPDATE");
      await clearClient.query("DELETE FROM conversation_turn_failures WHERE request_id = $1", [
        failedRequestId,
      ]);
      let validationSettled = false;
      const validation = ledger
        .isCompletePrefix(contextEpoch.id, laterAssistant.sequence)
        .finally(() => {
          validationSettled = true;
        });

      await waitUntil(async () => {
        const waiting = await admin.query<{ waiting: boolean }>(
          `
            SELECT EXISTS (
              SELECT 1
              FROM pg_stat_activity
              WHERE datname = current_database()
                AND query LIKE '%FROM violet_instances WHERE singleton = true FOR SHARE%'
                AND wait_event_type = 'Lock'
            ) AS waiting
          `,
        );
        return waiting.rows[0]?.waiting === true;
      });
      expect(validationSettled).toBe(false);
      await clearClient.query("COMMIT");
      await expect(validation).resolves.toBe(false);
    } finally {
      await clearClient.query("ROLLBACK").catch(() => undefined);
      clearClient.release();
    }
  });
});

async function waitUntil(condition: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!(await condition())) {
    if (Date.now() >= deadline) {
      throw new Error("Database lock wait was not observed");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
