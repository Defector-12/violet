import type { EncryptedEnvelope, EnvelopeCipher } from "@violet/crypto";
import type { AppendLedgerMessage, ConversationLedger, LedgerMessage } from "@violet/domain";
import type { Pool, PoolClient } from "pg";

interface EventRow {
  readonly algorithm: "AES-256-GCM";
  readonly ciphertext: Buffer;
  readonly content_nonce: Buffer;
  readonly content_tag: Buffer;
  readonly id: string;
  readonly key_nonce: Buffer;
  readonly key_tag: Buffer;
  readonly key_version: string;
  readonly occurred_at: Date;
  readonly request_id: string;
  readonly role: "assistant" | "user";
  readonly sequence: string;
  readonly wrapped_key: Buffer;
}

export class PostgresConversationLedger implements ConversationLedger {
  readonly #cipher: EnvelopeCipher;
  readonly #constitutionVersion: string;
  readonly #instanceId: string;
  readonly #pool: Pool;

  constructor(input: {
    readonly cipher: EnvelopeCipher;
    readonly constitutionVersion: string;
    readonly instanceId: string;
    readonly pool: Pool;
  }) {
    this.#cipher = input.cipher;
    this.#constitutionVersion = input.constitutionVersion;
    this.#instanceId = input.instanceId;
    this.#pool = input.pool;
  }

  async append(input: AppendLedgerMessage): Promise<LedgerMessage> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const instanceId = await this.#lockInstance(client, input.occurredAt);
      const existing = await this.#findByRequest(client, instanceId, input.requestId, input.role);
      if (existing) {
        await client.query("COMMIT");
        return this.#toMessage(existing);
      }

      const sequenceResult = await client.query<{ next_event_sequence: string }>(
        `
          UPDATE violet_instances
          SET next_event_sequence = next_event_sequence + 1
          WHERE id = $1
          RETURNING next_event_sequence - 1 AS next_event_sequence
        `,
        [instanceId],
      );
      const sequence = sequenceResult.rows[0]?.next_event_sequence;
      if (!sequence) {
        throw new Error("Violet instance sequence could not be allocated");
      }

      const envelope = this.#cipher.encrypt(Buffer.from(input.content, "utf8"));
      const result = await client.query<EventRow>(
        `
          INSERT INTO conversation_events (
            id, instance_id, request_id, sequence, role, algorithm, key_version,
            ciphertext, content_nonce, content_tag, wrapped_key, key_nonce, key_tag,
            occurred_at
          )
          VALUES (
            $1, $2, $3, $4, $5, $6, $7,
            $8, $9, $10, $11, $12, $13,
            $14
          )
          RETURNING *
        `,
        [
          input.id,
          instanceId,
          input.requestId,
          sequence,
          input.role,
          envelope.algorithm,
          envelope.keyVersion,
          envelope.ciphertext,
          envelope.contentNonce,
          envelope.contentTag,
          envelope.wrappedKey,
          envelope.keyNonce,
          envelope.keyTag,
          input.occurredAt,
        ],
      );
      await client.query("COMMIT");
      const row = result.rows[0];
      if (!row) {
        throw new Error("conversation event was not returned after insert");
      }
      return this.#toMessage(row);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async list(): Promise<readonly LedgerMessage[]> {
    const result = await this.#pool.query<EventRow>(
      `
        SELECT events.*
        FROM conversation_events AS events
        JOIN violet_instances AS instance ON instance.id = events.instance_id
        WHERE instance.singleton = true
        ORDER BY events.sequence
      `,
    );
    return result.rows.map((row) => this.#toMessage(row));
  }

  async #findByRequest(
    client: PoolClient,
    instanceId: string,
    requestId: string,
    role: "assistant" | "user",
  ): Promise<EventRow | undefined> {
    const result = await client.query<EventRow>(
      `
        SELECT *
        FROM conversation_events
        WHERE instance_id = $1 AND request_id = $2 AND role = $3
      `,
      [instanceId, requestId, role],
    );
    return result.rows[0];
  }

  async #lockInstance(client: PoolClient, createdAt: Date): Promise<string> {
    await client.query(
      `
        INSERT INTO violet_instances (
          singleton, id, name, constitution_version, next_event_sequence, created_at
        )
        VALUES (true, $1, 'Violet', $2, 1, $3)
        ON CONFLICT (singleton) DO NOTHING
      `,
      [this.#instanceId, this.#constitutionVersion, createdAt],
    );
    const result = await client.query<{ id: string }>(
      "SELECT id FROM violet_instances WHERE singleton = true FOR UPDATE",
    );
    const id = result.rows[0]?.id;
    if (!id) {
      throw new Error("Violet instance is unavailable");
    }
    return id;
  }

  #toMessage(row: EventRow): LedgerMessage {
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
      id: row.id,
      occurredAt: row.occurred_at,
      requestId: row.request_id,
      role: row.role,
      sequence: Number(row.sequence),
    };
  }
}
