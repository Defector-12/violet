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
    for (const migration of ["0001_violet_seed.sql", "0002_context_checkpoints.sql"]) {
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
});
