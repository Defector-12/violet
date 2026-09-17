import { describe, expect, it } from "vitest";

import { InMemoryConversationLedger } from "./in-memory-conversation-ledger.js";

describe("InMemoryConversationLedger", () => {
  it("keeps concurrent retries idempotent", async () => {
    const ledger = new InMemoryConversationLedger();
    const message = {
      content: "Question",
      id: "user-a",
      occurredAt: new Date(),
      requestId: "request-a",
      role: "user" as const,
    };

    await Promise.all([ledger.append(message), ledger.append(message)]);

    await expect(ledger.list()).resolves.toHaveLength(1);
  });

  it("returns interleaved events as complete logical turns without splitting requests", async () => {
    const ledger = new InMemoryConversationLedger();
    const contextEpoch = {
      id: "00000000-0000-4000-8000-000000000001",
      startedAt: new Date("2026-09-16T00:00:00.000Z"),
    };
    const append = (id: string, requestId: string, role: "assistant" | "user", content: string) =>
      ledger.append({
        content,
        contextEpoch,
        id,
        occurredAt: new Date(),
        requestId,
        role,
      });

    await append("user-a", "request-a", "user", "Question A");
    await append("user-b", "request-b", "user", "Question B");
    await append("assistant-a", "request-a", "assistant", "Answer A");
    await append("assistant-b", "request-b", "assistant", "Answer B");
    await append("user-c", "request-c", "user", "Question C");

    const turns = await ledger.listTurns({
      completeOnly: true,
      contextEpochId: contextEpoch.id,
    });

    expect(turns).toHaveLength(2);
    expect(turns.map((turn) => turn.requestId)).toEqual(["request-a", "request-b"]);
    expect(turns[0]?.messages.map((message) => message.content)).toEqual([
      "Question A",
      "Answer A",
    ]);
    expect(turns[0]).toMatchObject({
      startSequence: 1,
      throughSequence: 3,
    });
    expect(turns[1]?.messages.map((message) => message.content)).toEqual([
      "Question B",
      "Answer B",
    ]);
  });

  it("filters complete turns by epoch and sequence boundaries", async () => {
    const ledger = new InMemoryConversationLedger();
    const firstEpoch = {
      id: "00000000-0000-4000-8000-000000000001",
      startedAt: new Date("2026-09-16T00:00:00.000Z"),
    };
    const secondEpoch = {
      id: "00000000-0000-4000-8000-000000000002",
      startedAt: new Date("2026-09-16T01:00:00.000Z"),
    };
    for (const [index, epoch] of [firstEpoch, secondEpoch].entries()) {
      await ledger.append({
        content: `Question ${index}`,
        contextEpoch: epoch,
        id: `user-${index}`,
        occurredAt: epoch.startedAt,
        requestId: `request-${index}`,
        role: "user",
      });
      await ledger.append({
        content: `Answer ${index}`,
        contextEpoch: epoch,
        id: `assistant-${index}`,
        occurredAt: epoch.startedAt,
        requestId: `request-${index}`,
        role: "assistant",
      });
    }

    await expect(
      ledger.listTurns({
        afterSequence: 2,
        completeOnly: true,
        contextEpochId: secondEpoch.id,
      }),
    ).resolves.toMatchObject([
      {
        requestId: "request-1",
        startSequence: 3,
        throughSequence: 4,
      },
    ]);
  });

  it("reports only boundaries that contain a complete logical prefix", async () => {
    const ledger = new InMemoryConversationLedger();
    const contextEpoch = {
      id: "00000000-0000-4000-8000-000000000001",
      startedAt: new Date("2026-09-16T00:00:00.000Z"),
    };
    for (const [id, requestId, role] of [
      ["user-a", "request-a", "user"],
      ["user-b", "request-b", "user"],
      ["assistant-b", "request-b", "assistant"],
      ["assistant-a", "request-a", "assistant"],
    ] as const) {
      await ledger.append({
        content: id,
        contextEpoch,
        id,
        occurredAt: new Date(),
        requestId,
        role,
      });
    }

    await expect(ledger.isCompletePrefix(contextEpoch.id, 3)).resolves.toBe(false);
    await expect(ledger.isCompletePrefix(contextEpoch.id, 4)).resolves.toBe(true);
    await expect(ledger.latestSequence(contextEpoch.id)).resolves.toBe(4);
  });

  it("allows a terminally failed request in a complete prefix without returning it as history", async () => {
    const ledger = new InMemoryConversationLedger();
    const contextEpoch = {
      id: "00000000-0000-4000-8000-000000000001",
      startedAt: new Date("2026-09-16T00:00:00.000Z"),
    };
    await ledger.append({
      content: "Failed question",
      contextEpoch,
      id: "user-failed",
      occurredAt: contextEpoch.startedAt,
      requestId: "request-failed",
      role: "user",
    });
    await ledger.markRequestFailed("request-failed", contextEpoch.id, contextEpoch.startedAt);
    await ledger.append({
      content: "Later question",
      contextEpoch,
      id: "user-later",
      occurredAt: contextEpoch.startedAt,
      requestId: "request-later",
      role: "user",
    });
    const laterAssistant = await ledger.append({
      content: "Later answer",
      contextEpoch,
      id: "assistant-later",
      occurredAt: contextEpoch.startedAt,
      requestId: "request-later",
      role: "assistant",
    });

    await expect(ledger.isCompletePrefix(contextEpoch.id, laterAssistant.sequence)).resolves.toBe(
      true,
    );
    await expect(
      ledger.listTurns({ completeOnly: true, contextEpochId: contextEpoch.id }),
    ).resolves.toMatchObject([{ requestId: "request-later" }]);
    await expect(ledger.listTurns({ contextEpochId: contextEpoch.id })).resolves.toMatchObject([
      { completed: false, failed: true, requestId: "request-failed" },
      { completed: true, failed: false, requestId: "request-later" },
    ]);
  });
});
