import { randomUUID } from "node:crypto";
import type { MemoryChange, MemoryRepository } from "@violet/domain";
import { describe, expect, it, vi } from "vitest";
import { ContextEpochManager } from "../conversation/context-epoch-manager.js";
import { InMemoryConversationLedger } from "../conversation/in-memory-conversation-ledger.js";
import { MemoryService } from "../memory/memory-service.js";

describe("Realtime memory transition contract", () => {
  it("uses the successful attempt's expected revision, not a later global revision", async () => {
    const h = await createMemory();
    const result = await h.memory.prepareRequest(h.requestId);
    expect(result).toMatchObject({
      changes: [{ kind: "created" }],
      memoryTransition: { previousRevision: 7, revision: 8 },
    });
    expect(h.write.mock.calls[0]?.[0]).toMatchObject({ expectedRevision: 7 });
    expect(h.state).not.toHaveBeenCalled();
  });

  it("does not recreate a transition when replaying a committed request", async () => {
    const h = await createMemory();
    const first = await h.memory.prepareRequest(h.requestId);
    const replay = await h.memory.prepareRequest(h.requestId);
    expect(replay).toEqual({ changes: first.changes, reply: first.reply });
    expect(replay).not.toHaveProperty("memoryTransition");
    expect(h.write).toHaveBeenCalledOnce();
    expect(h.state).not.toHaveBeenCalled();
  });

  it("does not return a transition for a failed commit", async () => {
    const h = await createMemory();
    h.write.mockRejectedValueOnce(new Error("Commit failed"));
    await expect(h.memory.prepareRequest(h.requestId)).rejects.toThrow("Commit failed");
    expect(await h.memory.replayTurn(h.requestId)).toBeNull();
  });
});

async function createMemory() {
  let revision = 7;
  let committed: readonly MemoryChange[] | null = null;
  const requestId = randomUUID();
  const ledger = new InMemoryConversationLedger(() => revision);
  const epochs = new ContextEpochManager({ generateId: randomUUID });
  const occurredAt = new Date();
  await ledger.append({
    id: randomUUID(),
    requestId,
    contextEpoch: epochs.acceptUserInput(occurredAt),
    occurredAt,
    role: "user",
    content: "Remember that I prefer violet.",
  });
  const state = vi.fn(async () => ({ revision }));
  const write = vi.fn<MemoryRepository["write"]>(async () => {
    committed = [{ id: randomUUID(), kind: "created", version: 1 }];
    // Another operation has already advanced state before this result is delivered.
    revision = 9;
    return committed;
  });
  const memory = new MemoryService({
    ledger,
    epochManager: epochs,
    model: {
      async *stream() {
        yield {
          type: "delta",
          content: JSON.stringify({
            intent: "write",
            writes: [
              {
                content: "I prefer violet",
                quote: "I prefer violet",
                kind: "preference",
                targetId: null,
                targetVersion: null,
                action: null,
              },
            ],
          }),
        };
        yield { type: "complete", inputTokens: 1, outputTokens: 1 };
      },
    },
    repository: {
      state,
      snapshot: async () => ({ revision, memories: [] }),
      changesForRequest: async () => committed,
      getDeletionPreview: async () => null,
      write,
    } as unknown as MemoryRepository,
  });
  return { memory, requestId, state, write };
}
