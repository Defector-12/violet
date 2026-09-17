import type { EncryptedEnvelope, EnvelopeCipher } from "@violet/crypto";
import type {
  AppendLedgerMessage,
  ConversationLedger,
  ConversationTurn,
  LedgerMessage,
  ListConversationTurns,
} from "@violet/domain";
import type { Pool, PoolClient } from "pg";

interface EventRow {
  readonly algorithm: "AES-256-GCM";
  readonly ciphertext: Buffer;
  readonly content_nonce: Buffer;
  readonly content_tag: Buffer;
  readonly context_epoch_id: string | null;
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
      const existing = await this.#findByRequestInTransaction(
        client,
        instanceId,
        input.requestId,
        input.role,
      );
      if (existing) {
        await client.query("COMMIT");
        return this.#toMessage(existing);
      }
      if (input.contextEpoch) {
        await client.query(
          `
            INSERT INTO context_epochs (
              instance_id, id, started_at, last_user_input_at
            )
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (instance_id, id) DO UPDATE
            SET last_user_input_at = CASE
              WHEN $5 = 'user'
                THEN GREATEST(context_epochs.last_user_input_at, EXCLUDED.last_user_input_at)
              ELSE context_epochs.last_user_input_at
            END
          `,
          [
            instanceId,
            input.contextEpoch.id,
            input.contextEpoch.startedAt,
            input.role === "user" ? input.occurredAt : input.contextEpoch.startedAt,
            input.role,
          ],
        );
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
            id, instance_id, request_id, sequence, role, context_epoch_id,
            algorithm, key_version,
            ciphertext, content_nonce, content_tag, wrapped_key, key_nonce, key_tag,
            occurred_at
          )
          VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8,
            $9, $10, $11, $12, $13, $14,
            $15
          )
          RETURNING *
        `,
        [
          input.id,
          instanceId,
          input.requestId,
          sequence,
          input.role,
          input.contextEpoch?.id ?? null,
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

  async findByRequest(
    requestId: string,
    role: "assistant" | "user",
  ): Promise<LedgerMessage | null> {
    const result = await this.#pool.query<EventRow>(
      `
        SELECT events.*
        FROM conversation_events AS events
        JOIN violet_instances AS instance ON instance.id = events.instance_id
        WHERE instance.singleton = true
          AND events.request_id = $1
          AND events.role = $2
      `,
      [requestId, role],
    );
    const row = result.rows[0];
    return row ? this.#toMessage(row) : null;
  }

  async isCompletePrefix(contextEpochId: string, throughSequence: number): Promise<boolean> {
    const result = await this.#pool.query<{ valid: boolean }>(
      `
        WITH current_instance AS (
          SELECT id
          FROM violet_instances
          WHERE singleton = true
        ),
        invalid_turn AS (
          SELECT events.request_id
          FROM conversation_events AS events
          JOIN current_instance AS instance ON instance.id = events.instance_id
          WHERE events.context_epoch_id = $1
          GROUP BY events.request_id
          HAVING MIN(events.sequence) <= $2
            AND (
              COUNT(*) FILTER (WHERE events.role = 'user') = 0
              OR COUNT(*) FILTER (WHERE events.role = 'assistant') = 0
              OR MAX(events.sequence) > $2
            )
          LIMIT 1
        )
        SELECT
          EXISTS (
            SELECT 1
            FROM conversation_events AS events
            JOIN current_instance AS instance ON instance.id = events.instance_id
            WHERE events.context_epoch_id = $1
              AND events.sequence = $2
          )
          AND NOT EXISTS (SELECT 1 FROM invalid_turn) AS valid
      `,
      [contextEpochId, throughSequence],
    );
    return result.rows[0]?.valid ?? false;
  }

  async latestSequence(contextEpochId: string): Promise<number> {
    const result = await this.#pool.query<{ latest_sequence: string }>(
      `
        SELECT COALESCE(MAX(events.sequence), 0) AS latest_sequence
        FROM conversation_events AS events
        JOIN violet_instances AS instance ON instance.id = events.instance_id
        WHERE instance.singleton = true
          AND events.context_epoch_id = $1
      `,
      [contextEpochId],
    );
    return Number(result.rows[0]?.latest_sequence ?? 0);
  }

  async listTurns(options: ListConversationTurns): Promise<readonly ConversationTurn[]> {
    const result = await this.#pool.query<EventRow>(
      `
        SELECT events.*
        FROM conversation_events AS events
        JOIN violet_instances AS instance ON instance.id = events.instance_id
        WHERE instance.singleton = true
          AND events.context_epoch_id = $1
          AND ($2::bigint IS NULL OR events.sequence > $2)
          AND ($3::bigint IS NULL OR events.sequence < $3)
        ORDER BY events.sequence
      `,
      [options.contextEpochId, options.afterSequence ?? null, options.beforeSequence ?? null],
    );
    return groupTurns(
      result.rows.map((row) => this.#toMessage(row)),
      options.completeOnly ?? false,
    );
  }

  async #findByRequestInTransaction(
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
      ...(row.context_epoch_id ? { contextEpochId: row.context_epoch_id } : {}),
      id: row.id,
      occurredAt: row.occurred_at,
      requestId: row.request_id,
      role: row.role,
      sequence: Number(row.sequence),
    };
  }
}

function groupTurns(
  messages: readonly LedgerMessage[],
  completeOnly: boolean,
): readonly ConversationTurn[] {
  const grouped = new Map<string, LedgerMessage[]>();
  for (const message of messages) {
    const turn = grouped.get(message.requestId) ?? [];
    turn.push(message);
    grouped.set(message.requestId, turn);
  }

  return [...grouped.entries()]
    .map(
      ([requestId, turnMessages]): ConversationTurn => ({
        completed:
          turnMessages.some((message) => message.role === "user") &&
          turnMessages.some((message) => message.role === "assistant"),
        messages: turnMessages,
        requestId,
        startSequence: turnMessages[0]?.sequence ?? 0,
        throughSequence: turnMessages.at(-1)?.sequence ?? 0,
      }),
    )
    .filter((turn) => !completeOnly || turn.completed);
}
