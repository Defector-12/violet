import { randomUUID } from "node:crypto";
import {
  type ConversationLedger,
  type LedgerMessage,
  type Memory,
  type MemoryChange,
  MemoryConflictError,
  type MemoryRepository,
  type MemoryWriteRequest,
  type ModelGateway,
} from "@violet/domain";
import { assertMemoryContentAllowed, classifyMemoryContent } from "@violet/policy";
import type {
  MemoryCorrection,
  MemoryDeletionConfirmation,
  MemoryDeletionPreview,
  MemoryDeletionPreviewRequest,
  MemoryDeletionStatus,
  MemoryDetail,
  MemoryList,
} from "@violet/protocol";
import { boundUntrustedContext } from "../conversation/context-assembler.js";
import type { ContextEpochManager } from "../conversation/context-epoch-manager.js";
import { recordTestTrace } from "../realtime/test-trace.js";
import { proposeMemory } from "./memory-proposal.js";
import { type RecallQuery, searchMemory } from "./memory-search.js";
import { buildMemorySummary } from "./memory-summary.js";

export interface TurnMemoryResult {
  readonly changes: readonly MemoryChange[];
  /** This attempt's expected-to-committed revision; never synthesized on replay. */
  readonly memoryTransition?: {
    readonly previousRevision: number;
    readonly revision: number;
  };
  readonly reply?: string;
  readonly deletionPreviewId?: string;
  readonly history?: boolean;
}

export class MemoryNotFoundError extends Error {
  constructor() {
    super("Memory or deletion not found");
    this.name = "MemoryNotFoundError";
  }
}

export class MemoryService {
  readonly repository: MemoryRepository;
  readonly injectionEnabled: boolean;
  readonly #ledger: ConversationLedger;
  readonly #epochs: ContextEpochManager;
  readonly #model: ModelGateway | undefined;
  readonly #turns = new Map<string, Promise<TurnMemoryResult>>();
  readonly #invalidations = new Set<(exceptRequestId?: string) => void>();

  constructor(input: {
    readonly repository: MemoryRepository;
    readonly ledger: ConversationLedger;
    readonly epochManager: ContextEpochManager;
    readonly model?: ModelGateway;
    readonly injectionEnabled?: boolean;
  }) {
    this.repository = input.repository;
    this.#ledger = input.ledger;
    this.#epochs = input.epochManager;
    this.#model = input.model;
    this.injectionEnabled = input.injectionEnabled ?? true;
  }

  async prepareTurn(source: LedgerMessage, signal?: AbortSignal): Promise<TurnMemoryResult> {
    const pending = this.#turns.get(source.requestId);
    if (pending) return pending;
    const operation = this.#prepareTurn(source, signal);
    this.#turns.set(source.requestId, operation);
    try {
      return await operation;
    } finally {
      this.#turns.delete(source.requestId);
    }
  }

  async prepareRequest(requestId: string, signal?: AbortSignal): Promise<TurnMemoryResult> {
    const source = await this.#ledger.findByRequest(requestId, "user");
    if (!source) throw new MemoryConflictError("Final user source is unavailable");
    return this.prepareTurn(source, signal);
  }

  async #prepareTurn(source: LedgerMessage, signal?: AbortSignal): Promise<TurnMemoryResult> {
    assertMemoryContentAllowed(source.content);
    signal?.throwIfAborted();
    const previous = await this.replayTurn(source.requestId);
    if (previous) return previous;
    if (!this.#model) return { changes: [] };
    const started = performance.now();
    const snapshot = await this.repository.snapshot();
    const boundedSignal = AbortSignal.any([
      AbortSignal.timeout(30_000),
      ...(signal ? [signal] : []),
    ]);
    const proposal = await proposeMemory(this.#model, source, snapshot.memories, boundedSignal);
    boundedSignal.throwIfAborted();
    recordTestTrace("memory.proposal", {
      requestId: source.requestId,
      sourceEventId: source.id,
      intent: proposal.intent,
      elapsedMs: performance.now() - started,
    });
    if (proposal.intent === "none") return { changes: [], history: proposal.history };
    if (proposal.intent === "clarify") {
      return { changes: [], reply: "请明确要记住的原话，或在记忆窗口选择要纠正、删除的内容。" };
    }
    if (proposal.intent === "forget") {
      await this.#assertRevision(snapshot.revision);
      await this.repository.previewDeletion(source.requestId, {
        kind: "memory",
        id: proposal.id,
        version: proposal.version,
      });
      return {
        changes: [],
        reply: "已准备好删除预览，请在记忆窗口查看影响范围并确认。",
        deletionPreviewId: source.requestId,
      };
    }
    const changes = await this.commit(
      {
        requestId: source.requestId,
        sourceEventId: source.id,
        expectedRevision: snapshot.revision,
        writes: proposal.writes,
      },
      boundedSignal,
    );
    recordTestTrace("memory.committed", {
      requestId: source.requestId,
      changes,
      elapsedMs: performance.now() - started,
    });
    return {
      ...writeResult(changes),
      ...(changes.length
        ? {
            memoryTransition: {
              previousRevision: snapshot.revision,
              revision: snapshot.revision + 1,
            },
          }
        : {}),
    };
  }

  async replayTurn(requestId: string): Promise<TurnMemoryResult | null> {
    const previous = await this.repository.changesForRequest(requestId);
    if (previous?.length) return writeResult(previous);
    const preview = await this.repository.getDeletionPreview(requestId);
    if (preview) {
      const state = await this.repository.state();
      const events = await this.#ledger.sourceTurns(preview.eventIds);
      if (
        state.instanceId !== preview.instanceId ||
        state.revision !== preview.revision ||
        state.deletionRevision !== preview.deletionRevision ||
        state.restoreEpoch !== preview.restoreEpoch ||
        JSON.stringify(events.map((event) => event.id)) !== JSON.stringify(preview.eventIds)
      ) {
        throw new MemoryConflictError("Deletion preview expired; request a new preview");
      }
      await this.#assertRevision(preview.revision);
      return {
        changes: [],
        reply: "已准备好删除预览，请在记忆窗口查看影响范围并确认。",
        deletionPreviewId: preview.id,
      };
    }
    return null;
  }

  async context(): Promise<{
    readonly revision: number;
    readonly summary: string;
    readonly excludedRequests: ReadonlySet<string>;
  }> {
    const snapshot = await this.repository.snapshot();
    const cached = this.injectionEnabled ? await this.repository.summary() : null;
    const summary = !this.injectionEnabled
      ? { content: "", revision: snapshot.revision }
      : cached?.revision === snapshot.revision
        ? cached
        : buildMemorySummary(snapshot);
    if (
      this.injectionEnabled &&
      cached?.revision !== snapshot.revision &&
      !(await this.repository.saveSummary(summary))
    ) {
      throw new MemoryConflictError();
    }
    const events = await this.#ledger.sourceTurns(await this.repository.supersededSourceEventIds());
    await this.#assertRevision(snapshot.revision);
    return {
      revision: snapshot.revision,
      summary: summary.content,
      excludedRequests: new Set(events.map((event) => event.requestId)),
    };
  }

  async recall(input: RecallQuery, history: boolean, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (!this.injectionEnabled) return { status: "not_found" as const, items: [] };
    const started = performance.now();
    const snapshot = await this.repository.snapshot();
    const superseded = await this.#ledger.sourceTurns(
      await this.repository.supersededSourceEventIds(),
    );
    const excluded = new Set(superseded.map((event) => event.requestId));
    const events = history ? await this.#ledger.list() : [];
    const completed = new Set(
      events.filter((event) => event.role === "assistant").map((event) => event.requestId),
    );
    const items = searchMemory(
      input,
      snapshot.memories,
      events.filter((event) => completed.has(event.requestId) && !excluded.has(event.requestId)),
    );
    signal?.throwIfAborted();
    await this.#assertRevision(snapshot.revision);
    recordTestTrace("memory.recall", {
      count: items.length,
      elapsedMs: performance.now() - started,
    });
    return {
      status: items.length ? ("found" as const) : ("not_found" as const),
      items: items.map((item) => ({
        ...item,
        content: boundUntrustedContext(item.content, item.id, 8_000),
      })),
    };
  }

  onInvalidation(listener: (exceptRequestId?: string) => void): () => void {
    this.#invalidations.add(listener);
    return () => this.#invalidations.delete(listener);
  }

  async commit(input: MemoryWriteRequest, signal?: AbortSignal): Promise<readonly MemoryChange[]> {
    const changes = await this.repository.write(input, signal);
    if (changes.some((change) => change.kind === "corrected")) {
      this.#invalidate(input.requestId);
    }
    return changes;
  }

  async list(): Promise<MemoryList> {
    const snapshot = await this.repository.snapshot();
    return { ...snapshot, memories: snapshot.memories.map((memory) => maskMemory(memory, false)) };
  }

  async detail(id: string, reveal = false): Promise<MemoryDetail> {
    const state = await this.repository.state();
    const versions = await this.repository.get(id);
    if (versions.length === 0) throw new MemoryNotFoundError();
    const events = await this.#ledger.sourceTurns(
      versions.flatMap((item) => item.sources.map((source) => source.eventId)),
    );
    await this.#assertRevision(state.revision);
    const sensitiveRequests = new Set(
      events
        .filter((event) =>
          versions.some(
            (version) =>
              version.sensitivity === "controlled" &&
              version.sources.some((source) => source.eventId === event.id),
          ),
        )
        .map((event) => event.requestId),
    );
    return {
      instanceId: state.instanceId,
      revision: state.revision,
      versions: versions.map((memory) => maskMemory(memory, reveal)),
      events: events.map((event) =>
        maskEvent(event, reveal, sensitiveRequests.has(event.requestId)),
      ),
    };
  }

  async correct(id: string, input: MemoryCorrection): Promise<readonly MemoryChange[]> {
    assertMemoryContentAllowed(input.content);
    if (!input.content.trim()) throw new MemoryConflictError("Correction cannot be empty");
    const requestId = input.requestId.toLowerCase();
    const previous = await this.repository.changesForRequest(requestId);
    const priorSource = await this.#ledger.findByRequest(requestId, "user");
    if (priorSource && priorSource.content !== input.content) {
      throw new MemoryConflictError("Request ID already belongs to different content");
    }
    if (previous) {
      if (
        previous.length !== 1 ||
        previous[0]?.id !== id.toLowerCase() ||
        previous[0].version !== input.expectedVersion + 1
      ) {
        throw new MemoryConflictError("Request ID already belongs to another correction");
      }
      if (priorSource) await this.#completeCorrection(priorSource);
      return previous;
    }
    const snapshot = await this.repository.snapshot();
    const current = snapshot.memories.find((memory) => memory.id === id.toLowerCase());
    if (!current || current.version !== input.expectedVersion) throw new MemoryConflictError();
    const occurredAt = new Date();
    const contextEpoch = this.#epochs.acceptUserInput(occurredAt);
    const source =
      priorSource ??
      (await this.#ledger.append({
        content: input.content,
        contextEpoch,
        id: randomUUID(),
        occurredAt,
        requestId,
        role: "user",
      }));
    if (source.content !== input.content) throw new MemoryConflictError();
    await this.#ledger.clearRequestFailure(requestId);
    try {
      const changes = await this.commit({
        expectedRevision: snapshot.revision,
        requestId,
        sourceEventId: source.id,
        writes: [
          {
            content: input.content,
            kind: current.kind,
            sensitivity:
              current.sensitivity === "controlled" ||
              classifyMemoryContent(input.content) === "controlled"
                ? "controlled"
                : "normal",
            source: {
              eventId: source.id,
              startByte: 0,
              endByte: Buffer.byteLength(input.content),
              quote: input.content,
            },
            target: { id: current.id, version: current.version, action: "correct" },
          },
        ],
      });
      if (
        changes.length !== 1 ||
        changes[0]?.id !== current.id ||
        changes[0].version !== current.version + 1
      ) {
        throw new MemoryConflictError("Request ID already belongs to another correction");
      }
      await this.#completeCorrection(source);
      return changes;
    } catch (error) {
      if (source.contextEpochId) {
        await this.#ledger.markRequestFailed(requestId, source.contextEpochId, new Date());
      }
      throw error;
    }
  }

  async preview(input: MemoryDeletionPreviewRequest): Promise<MemoryDeletionPreview> {
    await this.repository.previewDeletion(input.id, input.target);
    return this.getPreview(input.id);
  }

  async getPreview(id: string): Promise<MemoryDeletionPreview> {
    const preview = await this.repository.getDeletionPreview(id);
    if (!preview) throw new MemoryNotFoundError();
    await this.#assertRevision(preview.revision);
    const ids = [...preview.deletedMemoryIds, ...preview.retainedMemoryIds];
    const memories: Memory[] = [];
    for (const memoryId of ids) memories.push(...(await this.repository.get(memoryId)));
    const events = await this.#ledger.sourceTurns(preview.eventIds);
    await this.#assertRevision(preview.revision);
    const sensitiveEventIds = new Set(
      memories
        .filter((memory) => memory.sensitivity === "controlled")
        .flatMap((memory) => memory.sources.map((source) => source.eventId)),
    );
    const sensitiveRequests = new Set(
      events.filter((event) => sensitiveEventIds.has(event.id)).map((event) => event.requestId),
    );
    return {
      ...preview,
      requestIds: [...preview.requestIds],
      eventIds: [...preview.eventIds],
      deletedMemoryIds: [...preview.deletedMemoryIds],
      retainedMemoryIds: [...preview.retainedMemoryIds],
      memories: memories.map((memory) => maskMemory(memory, false)),
      events: events.map((event) =>
        maskEvent(event, false, sensitiveRequests.has(event.requestId)),
      ),
    };
  }

  async confirm(
    id: string,
    input: MemoryDeletionConfirmation,
    deviceId: string,
  ): Promise<MemoryDeletionStatus> {
    const status = await this.repository.confirmDeletion({ id, ...input, deviceId });
    this.#invalidate();
    return status;
  }

  async deletionStatus(id: string): Promise<MemoryDeletionStatus> {
    const status = await this.repository.deletionStatus(id);
    if (!status) throw new MemoryNotFoundError();
    return status;
  }

  async retryCleanup(id: string): Promise<MemoryDeletionStatus> {
    const status = await this.deletionStatus(id);
    return status.status === "failed" ? this.repository.setCleanupStatus(id, "pending") : status;
  }

  async #completeCorrection(source: LedgerMessage): Promise<void> {
    await this.#ledger.append({
      content: "已纠正这条记忆。",
      ...(source.contextEpochId
        ? { contextEpoch: { id: source.contextEpochId, startedAt: source.occurredAt } }
        : {}),
      id: randomUUID(),
      occurredAt: new Date(),
      requestId: source.requestId,
      role: "assistant",
    });
  }

  async #assertRevision(expected: number): Promise<void> {
    if ((await this.repository.state()).revision !== expected) throw new MemoryConflictError();
  }

  #invalidate(exceptRequestId?: string): void {
    for (const listener of this.#invalidations) listener(exceptRequestId);
  }
}

function writeResult(changes: readonly MemoryChange[]): TurnMemoryResult {
  return {
    changes,
    reply: changes.some((change) => change.kind === "corrected") ? "已纠正这条记忆。" : "已记住。",
  };
}

function maskMemory(memory: Memory, reveal: boolean): MemoryList["memories"][number] {
  if (memory.sensitivity === "controlled" && !reveal) {
    return { ...memory, sources: [...memory.sources], content: "受控敏感内容", redacted: true };
  }
  return { ...memory, sources: [...memory.sources] };
}

function maskEvent(
  event: LedgerMessage,
  reveal: boolean,
  sensitive: boolean,
): MemoryDetail["events"][number] {
  const classification = classifyMemoryContent(event.content);
  const redacted =
    classification === "secret" || (!reveal && (sensitive || classification === "controlled"));
  return {
    id: event.id,
    requestId: event.requestId,
    role: event.role,
    content: redacted ? "敏感内容已遮挡" : event.content,
    ...(redacted ? { redacted: true } : {}),
    occurredAt: event.occurredAt.toISOString(),
  };
}
