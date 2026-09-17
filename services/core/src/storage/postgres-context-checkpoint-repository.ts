import type { EncryptedEnvelope, EnvelopeCipher } from "@violet/crypto";
import type {
  ContextCheckpoint,
  ContextCheckpointRepository,
  SaveContextCheckpoint,
} from "@violet/domain";
import type { Pool } from "pg";

interface CheckpointRow {
  readonly algorithm: "AES-256-GCM";
  readonly ciphertext: Buffer;
  readonly content_nonce: Buffer;
  readonly content_tag: Buffer;
  readonly context_epoch_id: string;
  readonly deletion_revision: string;
  readonly from_sequence: string;
  readonly key_nonce: Buffer;
  readonly key_tag: Buffer;
  readonly key_version: string;
  readonly through_sequence: string;
  readonly updated_at: Date;
  readonly wrapped_key: Buffer;
}

export class PostgresContextCheckpointRepository implements ContextCheckpointRepository {
  readonly #cipher: EnvelopeCipher;
  readonly #pool: Pool;

  constructor(options: { readonly cipher: EnvelopeCipher; readonly pool: Pool }) {
    this.#cipher = options.cipher;
    this.#pool = options.pool;
  }

  async deletionRevision(): Promise<number> {
    const result = await this.#pool.query<{ deletion_revision: string }>(
      "SELECT deletion_revision FROM violet_instances WHERE singleton = true",
    );
    return Number(result.rows[0]?.deletion_revision ?? 0);
  }

  async get(contextEpochId: string): Promise<ContextCheckpoint | null> {
    const result = await this.#pool.query<CheckpointRow>(
      `
        SELECT checkpoint.*
        FROM context_checkpoints AS checkpoint
        JOIN violet_instances AS instance ON instance.id = checkpoint.instance_id
        WHERE instance.singleton = true
          AND checkpoint.context_epoch_id = $1
          AND checkpoint.deletion_revision = instance.deletion_revision
      `,
      [contextEpochId],
    );
    const row = result.rows[0];
    return row ? this.#toCheckpoint(row) : null;
  }

  async save(checkpoint: SaveContextCheckpoint): Promise<boolean> {
    const envelope = this.#cipher.encrypt(Buffer.from(checkpoint.content, "utf8"));
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const instance = await client.query<{ deletion_revision: string; id: string }>(
        `
          SELECT id, deletion_revision
          FROM violet_instances
          WHERE singleton = true
          FOR UPDATE
        `,
      );
      const current = instance.rows[0];
      if (!current || Number(current.deletion_revision) !== checkpoint.deletionRevision) {
        await client.query("ROLLBACK");
        return false;
      }
      const source = await client.query<{ valid: boolean }>(
        `
          WITH invalid_turn AS (
            SELECT request_id
            FROM conversation_events
            WHERE instance_id = $1
              AND context_epoch_id = $2
            GROUP BY instance_id, request_id
            HAVING MIN(sequence) <= $3
              AND (
                MAX(sequence) > $3
                OR (
                  (
                    COUNT(*) FILTER (WHERE role = 'user') = 0
                    OR COUNT(*) FILTER (WHERE role = 'assistant') = 0
                  )
                  AND NOT EXISTS (
                    SELECT 1
                    FROM conversation_turn_failures AS failure
                    WHERE failure.instance_id = conversation_events.instance_id
                      AND failure.context_epoch_id = $2
                      AND failure.request_id = conversation_events.request_id
                  )
                )
              )
            LIMIT 1
          )
          SELECT
            EXISTS (
              SELECT 1
              FROM conversation_events
              WHERE instance_id = $1
                AND context_epoch_id = $2
                AND sequence = $3
            )
            AND NOT EXISTS (SELECT 1 FROM invalid_turn) AS valid
        `,
        [current.id, checkpoint.contextEpochId, checkpoint.throughSequence],
      );
      if (!source.rows[0]?.valid) {
        await client.query("ROLLBACK");
        return false;
      }

      const result = await client.query(
        `
          INSERT INTO context_checkpoints (
            instance_id, context_epoch_id, from_sequence, through_sequence,
            deletion_revision, algorithm, key_version, ciphertext, content_nonce,
            content_tag, wrapped_key, key_nonce, key_tag, updated_at
          )
          VALUES (
            $1, $2, $3, $4,
            $5, $6, $7, $8, $9,
            $10, $11, $12, $13, $14
          )
          ON CONFLICT (instance_id, context_epoch_id) DO UPDATE SET
            from_sequence = EXCLUDED.from_sequence,
            through_sequence = EXCLUDED.through_sequence,
            deletion_revision = EXCLUDED.deletion_revision,
            algorithm = EXCLUDED.algorithm,
            key_version = EXCLUDED.key_version,
            ciphertext = EXCLUDED.ciphertext,
            content_nonce = EXCLUDED.content_nonce,
            content_tag = EXCLUDED.content_tag,
            wrapped_key = EXCLUDED.wrapped_key,
            key_nonce = EXCLUDED.key_nonce,
            key_tag = EXCLUDED.key_tag,
            updated_at = EXCLUDED.updated_at
          WHERE context_checkpoints.through_sequence <= EXCLUDED.through_sequence
          RETURNING context_epoch_id
        `,
        [
          current.id,
          checkpoint.contextEpochId,
          checkpoint.fromSequence,
          checkpoint.throughSequence,
          checkpoint.deletionRevision,
          envelope.algorithm,
          envelope.keyVersion,
          envelope.ciphertext,
          envelope.contentNonce,
          envelope.contentTag,
          envelope.wrappedKey,
          envelope.keyNonce,
          envelope.keyTag,
          checkpoint.updatedAt,
        ],
      );
      if (result.rowCount !== 1) {
        await client.query("ROLLBACK");
        return false;
      }
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  #toCheckpoint(row: CheckpointRow): ContextCheckpoint {
    const envelope: EncryptedEnvelope = {
      algorithm: row.algorithm,
      ciphertext: row.ciphertext,
      contentNonce: row.content_nonce,
      contentTag: row.content_tag,
      keyNonce: row.key_nonce,
      keyTag: row.key_tag,
      keyVersion: row.key_version,
      wrappedKey: row.wrapped_key,
    };
    return {
      content: this.#cipher.decrypt(envelope).toString("utf8"),
      contextEpochId: row.context_epoch_id,
      deletionRevision: Number(row.deletion_revision),
      fromSequence: Number(row.from_sequence),
      throughSequence: Number(row.through_sequence),
      updatedAt: row.updated_at,
    };
  }
}
