import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { EnvelopeCipher } from "@violet/crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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
    await Promise.all([
      ledger.append({
        content: "Question one",
        contextEpoch,
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
    const pendingAssistant = await ledger.append({
      content: "Pending answer",
      contextEpoch: concurrentEpoch,
      id: randomUUID(),
      occurredAt: concurrentEpoch.startedAt,
      requestId: pendingRequest,
      role: "assistant",
    });
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

      await expect(
        upgradePool.query<{ request_id: string }>(
          "SELECT request_id FROM conversation_turn_failures",
        ),
      ).resolves.toMatchObject({ rows: [{ request_id: requestId }] });
    } finally {
      await upgradePool.end();
      await admin.query(`DROP SCHEMA IF EXISTS "${upgradeSchema}" CASCADE`);
    }
  });
});
