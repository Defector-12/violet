import { randomUUID } from "node:crypto";
import type { EncryptedEnvelope, EnvelopeCipher } from "@violet/crypto";
import {
  type Memory,
  type MemoryChange,
  MemoryConflictError,
  type MemoryContent,
  type MemoryDeletionPreview,
  type MemoryDeletionStatus,
  type MemoryDeletionTarget,
  type MemoryRepository,
  type MemorySnapshot,
  type MemorySource,
  MemorySourceError,
  type MemoryState,
  type MemorySummary,
  type MemoryWriteRequest,
} from "@violet/domain";
import { assertMemoryContentAllowed, classifyMemoryContent } from "@violet/policy";
import type { Pool, PoolClient } from "pg";
import { decryptJson, encryptJson } from "./encrypted-json.js";

interface InstanceRow {
  id: string;
  memory_revision: string;
  deletion_revision: string;
  restore_epoch: string;
  next_event_sequence: string;
}

interface MemoryRow {
  id: string;
  version: number;
  state: Memory["state"];
  origin: "explicit";
  envelope: ReturnType<typeof encryptJson>;
  created_at: Date;
  updated_at: Date;
  sources: MemorySource[];
}

interface DeletionRow {
  id: string;
  instance_id: string;
  preview: MemoryDeletionPreview;
  restore_epoch: string | null;
  status: MemoryDeletionStatus["status"] | "preview";
  failure_code: string | null;
}

const memorySelection = `
  SELECT m.*, COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'eventId', s.event_id, 'startByte', s.start_byte, 'endByte', s.end_byte
    ) ORDER BY s.event_id, s.start_byte)
    FROM memory_sources s
    WHERE s.instance_id = m.instance_id AND s.memory_id = m.id AND s.memory_version = m.version
  ), '[]'::jsonb) AS sources
  FROM memories m
  JOIN violet_instances i ON i.id = m.instance_id
  WHERE i.singleton = true
`;

export class PostgresMemoryRepository implements MemoryRepository {
  readonly #pool: Pool;
  readonly #cipher: EnvelopeCipher;

  constructor(input: { readonly pool: Pool; readonly cipher: EnvelopeCipher }) {
    this.#pool = input.pool;
    this.#cipher = input.cipher;
  }

  async state(): Promise<MemoryState> {
    const row = await this.#instance(this.#pool);
    return toState(row);
  }

  async snapshot(): Promise<MemorySnapshot> {
    return this.#transaction(async (client, instance) => {
      const result = await client.query<MemoryRow>(
        `${memorySelection} AND m.state = 'current' ORDER BY m.updated_at DESC, m.id`,
      );
      return { ...toState(instance), memories: result.rows.map((row) => this.#memory(row)) };
    });
  }

  async get(id: string): Promise<readonly Memory[]> {
    const result = await this.#pool.query<MemoryRow>(
      `${memorySelection} AND m.id = $1 ORDER BY m.version DESC`,
      [id],
    );
    return result.rows.map((row) => this.#memory(row));
  }

  async changesForRequest(requestId: string): Promise<readonly MemoryChange[] | null> {
    const result = await this.#pool.query<{ changes: MemoryChange[] }>(
      `SELECT o.changes FROM memory_operations o
       JOIN violet_instances i ON i.id = o.instance_id
       WHERE i.singleton = true AND o.request_id = $1`,
      [requestId],
    );
    return result.rows[0]?.changes ?? null;
  }

  async supersededSourceEventIds(): Promise<readonly string[]> {
    const result = await this.#pool.query<{ event_id: string }>(
      `SELECT DISTINCT s.event_id FROM memory_sources s
       JOIN memories m ON m.instance_id = s.instance_id AND m.id = s.memory_id
         AND m.version = s.memory_version
       JOIN violet_instances i ON i.id = m.instance_id
       WHERE i.singleton = true AND m.state = 'superseded'`,
    );
    return result.rows.map((row) => row.event_id);
  }

  async write(input: MemoryWriteRequest, signal?: AbortSignal): Promise<readonly MemoryChange[]> {
    return this.#transaction(async (client, instance) => {
      const previous = await client.query<{ changes: MemoryChange[]; source_event_id: string }>(
        "SELECT changes, source_event_id FROM memory_operations WHERE instance_id = $1 AND request_id = $2",
        [instance.id, input.requestId],
      );
      if (previous.rows[0]) {
        if (previous.rows[0].source_event_id !== input.sourceEventId.toLowerCase()) {
          throw new MemoryConflictError("Request ID already belongs to a different source");
        }
        return previous.rows[0].changes;
      }
      if (Number(instance.memory_revision) !== input.expectedRevision) {
        throw new MemoryConflictError();
      }
      const source = await this.#source(client, instance.id, input.sourceEventId, input.requestId);
      assertMemoryContentAllowed(source);
      const bytes = Buffer.from(source, "utf8");
      const changes: MemoryChange[] = [];
      const touched = new Set<string>();
      let corrected = false;
      for (const write of input.writes) {
        assertMemoryContentAllowed(write.content);
        if (
          write.source.eventId.toLowerCase() !== input.sourceEventId.toLowerCase() ||
          !Number.isInteger(write.source.startByte) ||
          !Number.isInteger(write.source.endByte) ||
          write.source.startByte < 0 ||
          write.source.endByte > bytes.length ||
          write.source.endByte <= write.source.startByte ||
          !bytes
            .subarray(write.source.startByte, write.source.endByte)
            .equals(Buffer.from(write.source.quote, "utf8")) ||
          !write.source.quote ||
          !write.content.trim() ||
          Buffer.byteLength(write.content, "utf8") > 8_000
        ) {
          throw new MemorySourceError("Memory source quote or byte range does not match");
        }
        if (
          (classifyMemoryContent(source) === "controlled" || write.sensitivity === "controlled") &&
          (write.content !== source ||
            write.source.quote !== source ||
            write.sensitivity !== "controlled")
        ) {
          throw new MemorySourceError("Controlled sensitive memory must preserve the user's words");
        }
        let id = randomUUID() as string;
        let version = 1;
        let createdAt = new Date();
        let kind: MemoryChange["kind"] = "created";
        if (write.target) {
          id = write.target.id.toLowerCase();
          if (touched.has(id)) {
            throw new MemoryConflictError("One operation cannot change a memory twice");
          }
          const result = await client.query<MemoryRow>(
            `${memorySelection} AND m.id = $1 AND m.state = 'current'`,
            [id],
          );
          const current = result.rows[0];
          if (!current || current.version !== write.target.version) {
            throw new MemoryConflictError();
          }
          version = current.version;
          createdAt = current.created_at;
          if (write.target.action === "correct") {
            await client.query(
              "UPDATE memories SET state = 'superseded' WHERE instance_id = $1 AND id = $2 AND version = $3",
              [instance.id, id, version],
            );
            version += 1;
            corrected = true;
            kind = "corrected";
          } else {
            const existing = this.#memory(current);
            if (
              existing.content !== write.content ||
              existing.kind !== write.kind ||
              existing.sensitivity !== write.sensitivity
            ) {
              throw new MemoryConflictError("Adding a source cannot change memory content");
            }
            kind = "source_added";
          }
        }
        touched.add(id);
        if (kind !== "source_added") {
          const content: MemoryContent = {
            content: write.content,
            kind: write.kind,
            sensitivity: write.sensitivity,
          };
          await client.query(
            `INSERT INTO memories (
              instance_id, id, version, state, origin, envelope, created_at, updated_at
            ) VALUES ($1, $2, $3, 'current', 'explicit', $4, $5, now())`,
            [instance.id, id, version, encryptJson(this.#cipher, content), createdAt],
          );
        } else {
          await client.query(
            "UPDATE memories SET updated_at = now() WHERE instance_id = $1 AND id = $2 AND version = $3",
            [instance.id, id, version],
          );
        }
        await client.query(
          `INSERT INTO memory_sources (
            instance_id, memory_id, memory_version, event_id, start_byte, end_byte
          ) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
          [
            instance.id,
            id,
            version,
            input.sourceEventId,
            write.source.startByte,
            write.source.endByte,
          ],
        );
        changes.push({ id, version, kind });
      }
      await client.query(
        "INSERT INTO memory_operations (instance_id, request_id, source_event_id, changes) VALUES ($1, $2, $3, $4)",
        [instance.id, input.requestId, input.sourceEventId, JSON.stringify(changes)],
      );
      if (changes.length > 0) {
        await this.#invalidate(client, instance.id, corrected);
      }
      return changes;
    }, signal);
  }

  async summary(): Promise<MemorySummary | null> {
    const result = await this.#pool.query<{
      memory_revision: string;
      envelope: ReturnType<typeof encryptJson>;
    }>(
      `SELECT s.* FROM memory_summary s JOIN violet_instances i ON i.id = s.instance_id
       WHERE i.singleton = true AND s.memory_revision = i.memory_revision`,
    );
    const row = result.rows[0];
    return row
      ? {
          content: decryptJson<string>(this.#cipher, row.envelope),
          revision: Number(row.memory_revision),
        }
      : null;
  }

  async saveSummary(summary: MemorySummary): Promise<boolean> {
    if (Buffer.byteLength(summary.content, "utf8") > 8_900) {
      throw new Error("Memory summary exceeds 8900 UTF-8 bytes");
    }
    return this.#transaction(async (client, instance) => {
      if (Number(instance.memory_revision) !== summary.revision) {
        return false;
      }
      await client.query(
        `INSERT INTO memory_summary (instance_id, memory_revision, envelope) VALUES ($1, $2, $3)
         ON CONFLICT (instance_id) DO UPDATE SET
         memory_revision = EXCLUDED.memory_revision, envelope = EXCLUDED.envelope`,
        [instance.id, summary.revision, encryptJson(this.#cipher, summary.content)],
      );
      return true;
    });
  }

  async previewDeletion(id: string, target: MemoryDeletionTarget): Promise<MemoryDeletionPreview> {
    return this.#transaction(async (client, instance) => {
      const previous = await this.#deletion(client, id);
      if (previous) {
        const priorTarget = previous.preview.target;
        if (
          priorTarget.kind !== target.kind ||
          (target.kind === "memory" &&
            (priorTarget.kind !== "memory" ||
              priorTarget.id.toLowerCase() !== target.id.toLowerCase() ||
              priorTarget.version !== target.version)) ||
          (target.kind === "source" &&
            (priorTarget.kind !== "source" ||
              priorTarget.eventId.toLowerCase() !== target.eventId.toLowerCase()))
        ) {
          throw new MemoryConflictError("Deletion ID already belongs to another target");
        }
        return previous.preview;
      }
      if (target.kind === "memory") {
        const current = await client.query(
          "SELECT 1 FROM memories WHERE instance_id = $1 AND id = $2 AND version = $3 AND state = 'current'",
          [instance.id, target.id, target.version],
        );
        if (current.rowCount !== 1) {
          throw new MemoryConflictError();
        }
      }
      const sources = await client.query<{ request_id: string }>(
        `SELECT DISTINCT e.request_id FROM memory_sources s
         JOIN conversation_events e ON e.id = s.event_id AND e.instance_id = s.instance_id
         WHERE s.instance_id = $1
           AND ($2::text = 'all'
             OR ($2 = 'memory' AND s.memory_id = $3::uuid)
             OR ($2 = 'source' AND s.event_id = $4::uuid))
         ORDER BY e.request_id`,
        [
          instance.id,
          target.kind,
          target.kind === "memory" ? target.id : null,
          target.kind === "source" ? target.eventId : null,
        ],
      );
      const requestIds = sources.rows.map((row) => row.request_id);
      if (requestIds.length === 0 && target.kind !== "all") {
        throw new MemorySourceError();
      }
      const events = await client.query<{ id: string }>(
        "SELECT id FROM conversation_events WHERE instance_id = $1 AND request_id = ANY($2::uuid[]) ORDER BY sequence",
        [instance.id, requestIds],
      );
      const eventIds = events.rows.map((row) => row.id);
      const affected = await client.query<{ memory_id: string; retained: boolean }>(
        `SELECT s.memory_id, bool_or(NOT (s.event_id = ANY($2::uuid[]))) AS retained
         FROM memory_sources s WHERE s.instance_id = $1
         GROUP BY s.memory_id HAVING bool_or(s.event_id = ANY($2::uuid[]))
         ORDER BY s.memory_id`,
        [instance.id, eventIds],
      );
      const preview: MemoryDeletionPreview = {
        ...toState(instance),
        id,
        target,
        nextRestoreEpoch: Number(instance.restore_epoch) + 1,
        eventSequence: Number(instance.next_event_sequence),
        requestIds,
        eventIds,
        deletedMemoryIds: affected.rows.filter((row) => !row.retained).map((row) => row.memory_id),
        retainedMemoryIds: affected.rows.filter((row) => row.retained).map((row) => row.memory_id),
        createdAt: new Date().toISOString(),
      };
      await client.query(
        "INSERT INTO memory_deletions (instance_id, id, preview) VALUES ($1, $2, $3)",
        [instance.id, id, preview],
      );
      return preview;
    });
  }

  async getDeletionPreview(id: string): Promise<MemoryDeletionPreview | null> {
    return (await this.#deletion(this.#pool, id))?.preview ?? null;
  }

  async confirmDeletion(input: {
    readonly id: string;
    readonly instanceId: string;
    readonly minimumRestoreEpoch: number;
    readonly deviceId: string;
  }): Promise<MemoryDeletionStatus> {
    return this.#transaction(async (client, instance) => {
      const deletion = await this.#deletion(client, input.id);
      if (!deletion || input.instanceId.toLowerCase() !== instance.id) {
        throw new MemoryConflictError("Deletion preview or instance does not match");
      }
      const preview = deletion.preview;
      if (input.minimumRestoreEpoch < preview.nextRestoreEpoch) {
        throw new MemoryConflictError("Persist the minimum restore epoch before confirming");
      }
      if (deletion.status !== "preview") {
        return toStatus(deletion);
      }
      if (
        Number(instance.memory_revision) !== preview.revision ||
        Number(instance.deletion_revision) !== preview.deletionRevision ||
        Number(instance.restore_epoch) !== preview.restoreEpoch
      ) {
        throw new MemoryConflictError("Deletion impact changed; refresh the preview");
      }
      const currentEvents = await client.query<{ id: string }>(
        "SELECT id FROM conversation_events WHERE instance_id = $1 AND request_id = ANY($2::uuid[]) ORDER BY sequence",
        [instance.id, preview.requestIds],
      );
      if (
        JSON.stringify(currentEvents.rows.map((row) => row.id)) !== JSON.stringify(preview.eventIds)
      ) {
        throw new MemoryConflictError("Deletion impact changed; refresh the preview");
      }
      await client.query(
        `INSERT INTO deletion_tombstones (instance_id, request_id, deletion_id)
         SELECT $1, unnest($2::uuid[]), $3 ON CONFLICT DO NOTHING`,
        [instance.id, preview.requestIds, input.id],
      );
      await client.query(
        "DELETE FROM conversation_turn_failures WHERE instance_id = $1 AND request_id = ANY($2::uuid[])",
        [instance.id, preview.requestIds],
      );
      // Source and idempotency references cascade. Never promote an older memory version.
      await client.query(
        "DELETE FROM conversation_events WHERE instance_id = $1 AND request_id = ANY($2::uuid[])",
        [instance.id, preview.requestIds],
      );
      await client.query(
        `DELETE FROM memories m WHERE m.instance_id = $1 AND NOT EXISTS (
           SELECT 1 FROM memory_sources s WHERE s.instance_id = m.instance_id
           AND s.memory_id = m.id AND s.memory_version = m.version
         )`,
        [instance.id],
      );
      await this.#invalidate(client, instance.id, true);
      await client.query(
        "UPDATE violet_instances SET restore_epoch = restore_epoch + 1 WHERE id = $1",
        [instance.id],
      );
      const result = await client.query<DeletionRow>(
        `UPDATE memory_deletions SET status = 'pending', restore_epoch = $3,
         device_id = $4, confirmed_at = now() WHERE instance_id = $1 AND id = $2 RETURNING *`,
        [instance.id, input.id, preview.nextRestoreEpoch, input.deviceId],
      );
      const row = result.rows[0];
      if (!row) {
        throw new Error("Deletion status was not returned");
      }
      return toStatus(row);
    });
  }

  async deletionStatus(id: string): Promise<MemoryDeletionStatus | null> {
    const row = await this.#deletion(this.#pool, id);
    return row && row.status !== "preview" ? toStatus(row) : null;
  }

  async setCleanupStatus(
    id: string,
    status: MemoryDeletionStatus["status"],
    failureCode?: string,
  ): Promise<MemoryDeletionStatus> {
    const result = await this.#pool.query<DeletionRow>(
      `UPDATE memory_deletions d SET status = $2, failure_code = $3
       FROM violet_instances i WHERE i.id = d.instance_id AND i.singleton = true
       AND d.id = $1 AND d.status <> 'preview' AND d.status <> 'complete' RETURNING d.*`,
      [id, status, failureCode ?? null],
    );
    const row = result.rows[0];
    const previous = row ? toStatus(row) : await this.deletionStatus(id);
    if (!previous) {
      throw new MemoryConflictError("Confirmed deletion not found");
    }
    return previous;
  }

  async #invalidate(client: PoolClient, instanceId: string, context: boolean): Promise<void> {
    await client.query(
      "UPDATE violet_instances SET memory_revision = memory_revision + 1, deletion_revision = deletion_revision + $2 WHERE id = $1",
      [instanceId, context ? 1 : 0],
    );
    await client.query("DELETE FROM memory_summary WHERE instance_id = $1", [instanceId]);
    if (context) {
      await client.query("DELETE FROM context_checkpoints WHERE instance_id = $1", [instanceId]);
    }
  }

  async #source(
    client: PoolClient,
    instanceId: string,
    eventId: string,
    requestId: string,
  ): Promise<string> {
    const result = await client.query<{
      algorithm: "AES-256-GCM";
      ciphertext: Buffer;
      content_nonce: Buffer;
      content_tag: Buffer;
      wrapped_key: Buffer;
      key_nonce: Buffer;
      key_tag: Buffer;
      key_version: string;
    }>(
      `SELECT e.* FROM conversation_events e
       WHERE e.instance_id = $1 AND e.id = $2 AND e.role = 'user'
         AND e.request_id = $3
         AND NOT EXISTS (SELECT 1 FROM deletion_tombstones t
           WHERE t.instance_id = e.instance_id AND t.request_id = e.request_id)
         AND NOT EXISTS (SELECT 1 FROM conversation_turn_failures f
           WHERE f.instance_id = e.instance_id AND f.request_id = e.request_id)`,
      [instanceId, eventId, requestId],
    );
    const row = result.rows[0];
    if (!row) {
      throw new MemorySourceError();
    }
    const envelope: EncryptedEnvelope = {
      algorithm: row.algorithm,
      ciphertext: row.ciphertext,
      contentNonce: row.content_nonce,
      contentTag: row.content_tag,
      wrappedKey: row.wrapped_key,
      keyNonce: row.key_nonce,
      keyTag: row.key_tag,
      keyVersion: row.key_version,
    };
    return this.#cipher.decrypt(envelope).toString("utf8");
  }

  #memory(row: MemoryRow): Memory {
    return {
      ...decryptJson<MemoryContent>(this.#cipher, row.envelope),
      id: row.id,
      version: row.version,
      state: row.state,
      origin: row.origin,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      sources: row.sources,
    };
  }

  async #deletion(client: Pool | PoolClient, id: string): Promise<DeletionRow | null> {
    const result = await client.query<DeletionRow>(
      `SELECT d.* FROM memory_deletions d JOIN violet_instances i ON i.id = d.instance_id
       WHERE i.singleton = true AND d.id = $1`,
      [id],
    );
    return result.rows[0] ?? null;
  }

  async #instance(client: Pool | PoolClient, lock = false): Promise<InstanceRow> {
    const result = await client.query<InstanceRow>(
      `SELECT * FROM violet_instances WHERE singleton = true${lock ? " FOR UPDATE" : ""}`,
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error("Violet instance is unavailable");
    }
    return row;
  }

  async #transaction<T>(
    operation: (client: PoolClient, instance: InstanceRow) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    signal?.throwIfAborted();
    const client = await this.#pool.connect();
    try {
      signal?.throwIfAborted();
      await client.query("BEGIN");
      const instance = await this.#instance(client, true);
      signal?.throwIfAborted();
      const result = await operation(client, instance);
      // COMMIT dispatch is the linearization point; do not reject after it succeeds.
      signal?.throwIfAborted();
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

function toState(row: InstanceRow): MemoryState {
  return {
    instanceId: row.id,
    revision: Number(row.memory_revision),
    deletionRevision: Number(row.deletion_revision),
    restoreEpoch: Number(row.restore_epoch),
  };
}

function toStatus(row: DeletionRow): MemoryDeletionStatus {
  if (row.status === "preview" || row.restore_epoch === null) {
    throw new MemoryConflictError("Deletion has not been confirmed");
  }
  return {
    id: row.id,
    instanceId: row.instance_id,
    restoreEpoch: Number(row.restore_epoch),
    status: row.status,
    ...(row.failure_code ? { failureCode: row.failure_code } : {}),
  };
}
