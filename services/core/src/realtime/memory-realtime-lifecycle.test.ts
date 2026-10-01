import { randomUUID } from "node:crypto";
import type {
  RealtimeConversation,
  RealtimeConversationOutput,
  RealtimeConversationPort,
} from "@violet/domain";
import { describe, expect, it, vi } from "vitest";
import { ContextService } from "../context/context-service.js";
import { DeterministicContextUnderstandingPort } from "../context/deterministic-context-understanding.js";
import { InMemoryContextArtifactStore } from "../context/in-memory-context-artifact-store.js";
import { InMemoryContextSessionRepository } from "../context/in-memory-context-session-repository.js";
import { InMemoryConversationLedger } from "../conversation/in-memory-conversation-ledger.js";
import type { MemoryService, TurnMemoryResult } from "../memory/memory-service.js";
import { AsyncQueue } from "./async-queue.js";
import { RealtimeSession } from "./realtime-session.js";

describe("Realtime memory lifecycle", () => {
  it.each(["integrated", "pipeline"] as const)(
    "passes ordinary eligibility only at the committed %s answer boundary",
    async (runtimeKind) => {
      const h = createSession(undefined, runtimeKind);
      const append = vi.spyOn(h.ledger, "append");
      h.prepare.mockResolvedValue({ changes: [], automaticMemoryEligible: true });
      const iterator = h.session.outputs()[Symbol.asyncIterator]();
      try {
        await h.configure();
        await h.text();
        expect(append.mock.calls.filter(([input]) => input.role === "assistant")).toHaveLength(0);
        h.queue.push({ type: "response-started", turnId: h.turnId, responseId: h.responseId });
        h.queue.push({
          type: "response-text",
          turnId: h.turnId,
          responseId: h.responseId,
          text: "普通回答",
        });
        h.queue.push({
          type: "response-completed",
          turnId: h.turnId,
          responseId: h.responseId,
          inputTokens: 1,
          outputTokens: 1,
          memoryRevision: 7,
          ...(runtimeKind === "pipeline" ? { automaticMemoryEligible: true } : {}),
        });
        for (const type of ["response.started", "response.text", "response.completed"]) {
          expect((await iterator.next()).value?.type).toBe(type);
        }
        expect(append.mock.calls.find(([input]) => input.role === "assistant")?.[0]).toMatchObject({
          automaticMemoryEligible: true,
          expectedMemoryRevision: 7,
        });
      } finally {
        await h.session.close();
        await iterator.return?.();
      }
    },
  );

  it("advances an explicit confirmation across proven intervening automatic additions", async () => {
    const h = createSession();
    h.prepare.mockImplementationOnce(async () => {
      h.setRevision(9);
      return {
        changes: [{ id: randomUUID(), kind: "created", version: 1 }],
        reply: "Saved",
        memoryTransition: { previousRevision: 8, minimumPreviousRevision: 7, revision: 9 },
      };
    });
    const iterator = h.session.outputs()[Symbol.asyncIterator]();
    try {
      await h.configure();
      await h.text();
      h.respond(h.turnId, "Saved");
      for (const type of ["response.started", "response.text", "response.completed"]) {
        expect((await iterator.next()).value?.type).toBe(type);
      }
      expect(h.session.closed).toBe(false);
    } finally {
      await h.session.close();
      await iterator.return?.();
    }
  });

  it.each(["cancelled", "scoped-error", "unscoped-error"] as const)(
    "closes a corrected context before exposing confirmation %s",
    async (outcome) => {
      const h = createSession();
      const iterator = h.session.outputs()[Symbol.asyncIterator]();
      try {
        await h.configure();
        await h.text();
        h.invalidate(h.turnId);
        h.queue.push({ type: "response-started", turnId: h.turnId, responseId: h.responseId });
        expect((await iterator.next()).value?.type).toBe("response.started");
        h.queue.push(
          outcome === "cancelled"
            ? { type: "response-cancelled", responseId: h.responseId }
            : {
                type: "error",
                code: "SYNTHETIC_FAILURE",
                message: "Synthetic provider failure",
                retryable: false,
                terminal: false,
                ...(outcome === "scoped-error" ? { turnId: h.turnId } : {}),
              },
        );
        expect((await iterator.next()).value?.type).toBe(
          outcome === "cancelled" ? "response.cancelled" : "error",
        );
        // Cleanup must not depend on a client asking for another event.
        expect(h.session.closed).toBe(true);
        expect(h.runtime.close).toHaveBeenCalledOnce();
        expect(await h.ledger.findByRequest(h.turnId, "assistant")).toBeNull();
        expect((await h.ledger.listTurns({ contextEpochId: await h.epochId() }))[0]?.failed).toBe(
          true,
        );
      } finally {
        await h.session.close();
        await iterator.return?.();
      }
    },
  );

  it.each(["text", "audio", "commit", "speech", "transcript", "response"] as const)(
    "rejects a new %s turn while a correction confirmation is finishing",
    async (kind) => {
      const h = createSession();
      const nextTurnId = randomUUID();
      const iterator = h.session.outputs()[Symbol.asyncIterator]();
      try {
        await h.configure();
        await h.text();
        h.invalidate(h.turnId);
        if (kind === "text") {
          await h.text(nextTurnId);
        } else if (kind === "audio" || kind === "commit") {
          await collect(
            h.session.handle({
              ...h.clientEvent(),
              turnId: nextTurnId,
              ...(kind === "audio"
                ? { type: "input.audio", audio: "AQI=" }
                : { type: "input.commit" }),
            }),
          );
        } else {
          h.queue.push(
            kind === "speech"
              ? { type: "speech-started", turnId: nextTurnId }
              : kind === "transcript"
                ? { type: "transcript", turnId: nextTurnId, text: "Next turn", final: true }
                : { type: "response-started", turnId: nextTurnId, responseId: randomUUID() },
          );
          h.queue.close();
          const visible = await iterator.next();
          expect(visible.value?.type).not.toBe("input.speech.started");
          expect(visible.value?.type).not.toBe("input.transcript");
          expect(visible.value?.type).not.toBe("response.started");
        }
        expect(h.session.closed).toBe(true);
        expect(await h.ledger.findByRequest(nextTurnId, "user")).toBeNull();
        expect(h.runtime.send).toHaveBeenCalledTimes(1);
      } finally {
        await h.session.close();
        await iterator.return?.();
      }
    },
  );

  it("closes before reporting a failed confirmation send", async () => {
    const h = createSession();
    try {
      await h.configure();
      h.runtime.send.mockImplementationOnce(async () => {
        h.invalidate(h.turnId);
        throw new Error("Synthetic send failure");
      });
      const iterator = h.session
        .handle({
          ...h.clientEvent(),
          type: "input.text",
          turnId: h.turnId,
          text: "Correction",
        })
        [Symbol.asyncIterator]();
      expect((await iterator.next()).value).toMatchObject({ code: "REALTIME_INPUT_FAILED" });
      expect(h.session.closed).toBe(true);
      await iterator.return?.();
    } finally {
      await h.session.close();
    }
  });

  it.each(["corrected"] as const)(
    "preserves %s confirmation append and completed / memory_changed playback drain order",
    async (kind) => {
      const h = createSession();
      const append = vi.spyOn(h.ledger, "append");
      h.prepare.mockImplementationOnce(async () => {
        h.setRevision(8);
        if (kind === "corrected") h.invalidate(h.turnId);
        return {
          changes: [{ id: randomUUID(), kind, version: 1 }],
          reply: "Correction saved",
        };
      });
      const iterator = h.session.outputs()[Symbol.asyncIterator]();
      try {
        await h.configure();
        const streamId = randomUUID();
        const audioFrame = () =>
          collect(
            h.session.handle({
              ...h.clientEvent(),
              type: "input.audio",
              turnId: streamId,
              audio: "AQI=",
            }),
          );
        await audioFrame();
        await h.text();
        h.queue.push({ type: "response-started", turnId: h.turnId, responseId: h.responseId });
        h.queue.push({
          type: "response-text",
          turnId: h.turnId,
          responseId: h.responseId,
          text: "Correction saved",
        });
        h.queue.push({
          type: "response-audio",
          turnId: h.turnId,
          responseId: h.responseId,
          audio: new Uint8Array([1, 2]),
        });
        h.queue.push(h.completed());
        for (const type of [
          "response.started",
          "response.text",
          "response.audio",
          "response.completed",
        ]) {
          expect((await iterator.next()).value?.type).toBe(type);
          expect(await audioFrame()).toEqual([]);
          expect(h.session.closed).toBe(false);
        }
        const assistantInput = append.mock.calls.find(([input]) => input.role === "assistant")?.[0];
        expect(assistantInput).toMatchObject({
          signal: expect.any(AbortSignal),
          expectedMemoryRevision: 8,
        });
        expect(assistantInput?.signal?.aborted).toBe(false);
        expect(await h.ledger.findByRequest(h.turnId, "assistant")).toMatchObject({
          content: "Correction saved",
        });
        expect((await iterator.next()).value).toMatchObject({
          type: "session.end_requested",
          reason: "memory_changed",
        });
        expect(h.session.closed).toBe(false);
        expect((await iterator.next()).done).toBe(true);
        expect(h.session.closed).toBe(true);
      } finally {
        await h.session.close();
        await iterator.return?.();
      }
    },
  );

  it.each(["created", "source_added"] as const)(
    "continues after its own %s confirmation without requiring an exact acknowledgement",
    async (kind) => {
      const h = createSession();
      const append = vi.spyOn(h.ledger, "append");
      h.prepare.mockImplementationOnce(async () => {
        h.setRevision(8);
        return {
          changes: [{ id: randomUUID(), kind, version: 1 }],
          reply: "Saved",
          memoryTransition: { previousRevision: 7, revision: 8 },
        };
      });
      const iterator = h.session.outputs()[Symbol.asyncIterator]();
      try {
        await h.configure();
        h.state.mockClear();
        await h.text();
        h.respond(h.turnId, "Your preference is saved.");
        for (const type of ["response.started", "response.text", "response.completed"]) {
          expect((await iterator.next()).value?.type).toBe(type);
        }
        expect(h.session.closed).toBe(false);
        const nextTurn = randomUUID();
        expect(await h.text(nextTurn)).toEqual([]);
        h.respond(nextTurn, "Following up on that preference.");
        for (const type of ["response.started", "response.text", "response.completed"]) {
          expect((await iterator.next()).value?.type).toBe(type);
        }
        expect(
          append.mock.calls
            .filter(([input]) => input.role === "assistant")
            .map(([input]) => input.expectedMemoryRevision),
        ).toEqual([8, 8]);
        expect(h.state).not.toHaveBeenCalled();
        expect(h.runtime.close).not.toHaveBeenCalled();
      } finally {
        await h.session.close();
        await iterator.return?.();
      }
    },
  );

  it.each(["before-own-write", "after-own-write", "missing-transition"] as const)(
    "does not refresh a created-memory answer across an external change (%s)",
    async (timing) => {
      const h = createSession();
      const append = vi.spyOn(h.ledger, "append");
      h.prepare.mockImplementationOnce(async () => {
        h.setRevision(9);
        return {
          changes: [{ id: randomUUID(), kind: "created", version: 1 }],
          reply: "Saved",
          ...(timing === "missing-transition"
            ? {}
            : {
                memoryTransition:
                  timing === "before-own-write"
                    ? { previousRevision: 8, revision: 9 }
                    : { previousRevision: 7, revision: 8 },
              }),
        };
      });
      const iterator = h.session.outputs()[Symbol.asyncIterator]();
      try {
        await h.configure();
        await h.text();
        h.respond(h.turnId, "Saved");
        await iterator.next();
        await iterator.next();
        expect((await iterator.next()).value).toMatchObject({ code: "CONTEXT_SNAPSHOT_STALE" });
        expect(append.mock.calls.find(([input]) => input.role === "assistant")?.[0]).toMatchObject({
          expectedMemoryRevision: timing === "after-own-write" ? 8 : 7,
        });
        expect(await h.ledger.findByRequest(h.turnId, "assistant")).toBeNull();
        expect(h.session.closed).toBe(true);
      } finally {
        await h.session.close();
        await iterator.return?.();
      }
    },
  );

  it("uses its fresh context without advancing revision again on a created-memory replay", async () => {
    const h = createSession();
    h.setRevision(8);
    h.prepare.mockResolvedValueOnce({
      changes: [{ id: randomUUID(), kind: "created", version: 1 }],
      reply: "Saved",
    });
    const append = vi.spyOn(h.ledger, "append");
    const iterator = h.session.outputs()[Symbol.asyncIterator]();
    try {
      await h.configure();
      await h.text();
      h.respond(h.turnId, "Already saved.");
      await iterator.next();
      await iterator.next();
      expect((await iterator.next()).value?.type).toBe("response.completed");
      const nextTurn = randomUUID();
      expect(await h.text(nextTurn)).toEqual([]);
      h.respond(nextTurn, "Follow-up.");
      await iterator.next();
      await iterator.next();
      expect((await iterator.next()).value?.type).toBe("response.completed");
      expect(
        append.mock.calls
          .filter(([input]) => input.role === "assistant")
          .map(([input]) => input.expectedMemoryRevision),
      ).toEqual([8, 8]);
      expect(h.session.closed).toBe(false);
    } finally {
      await h.session.close();
      await iterator.return?.();
    }
  });

  it.each(["error", "cancel", "new-speech", "new-text", "client-cancel"] as const)(
    "clears a discarded final-transcript timer on %s",
    async (action) => {
      vi.useFakeTimers();
      const h = createSession();
      const iterator = h.session.outputs()[Symbol.asyncIterator]();
      try {
        await h.configure();
        h.queue.push({ type: "response-started", turnId: h.turnId, responseId: h.responseId });
        h.queue.push({ type: "speech-stopped", turnId: h.turnId });
        expect((await iterator.next()).value?.type).toBe("input.speech.stopped");
        expect(vi.getTimerCount()).toBe(1);
        if (action === "new-text") {
          await h.text(randomUUID());
        } else if (action === "client-cancel") {
          await collect(
            h.session.handle({
              ...h.clientEvent(),
              type: "response.cancel",
              responseId: h.responseId,
            }),
          );
        } else {
          h.queue.push(
            action === "error"
              ? {
                  type: "error",
                  turnId: h.turnId,
                  code: "TRANSCRIPTION_FAILED",
                  message: "Synthetic transcription failure",
                  retryable: false,
                  terminal: false,
                }
              : action === "cancel"
                ? { type: "response-cancelled", responseId: h.responseId }
                : { type: "speech-started", turnId: randomUUID() },
          );
          await iterator.next();
        }
        expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(30_001);
        expect(h.session.closed).toBe(false);
        expect(h.runtime.close).not.toHaveBeenCalled();
      } finally {
        await h.session.close();
        await iterator.return?.();
        vi.useRealTimers();
      }
    },
  );

  it("ignores an already queued timeout callback after its wait was discarded", async () => {
    vi.useFakeTimers();
    const timeout = vi.spyOn(globalThis, "setTimeout");
    const h = createSession();
    const iterator = h.session.outputs()[Symbol.asyncIterator]();
    try {
      await h.configure();
      h.queue.push({ type: "response-started", turnId: h.turnId, responseId: h.responseId });
      h.queue.push({ type: "speech-stopped", turnId: h.turnId });
      await iterator.next();
      const callback = timeout.mock.calls.find(([, delay]) => delay === 30_000)?.[0];
      expect(callback).toBeTypeOf("function");
      const nextTurnId = randomUUID();
      h.queue.push({ type: "speech-started", turnId: nextTurnId });
      await iterator.next();
      h.queue.push({ type: "response-started", turnId: nextTurnId, responseId: randomUUID() });
      h.queue.push({ type: "speech-stopped", turnId: nextTurnId });
      await iterator.next();
      if (typeof callback === "function") callback();
      expect(h.session.closed).toBe(false);
      expect(vi.getTimerCount()).toBe(1);
    } finally {
      await h.session.close();
      await iterator.return?.();
      timeout.mockRestore();
      vi.useRealTimers();
    }
  });

  it("still closes a turn that really is waiting for a final transcript", async () => {
    vi.useFakeTimers();
    const h = createSession();
    const iterator = h.session.outputs()[Symbol.asyncIterator]();
    try {
      await h.configure();
      h.queue.push({ type: "response-started", turnId: h.turnId, responseId: h.responseId });
      h.queue.push({ type: "speech-stopped", turnId: h.turnId });
      await iterator.next();
      await vi.advanceTimersByTimeAsync(30_001);
      expect(h.session.closed).toBe(true);
      expect(h.runtime.close).toHaveBeenCalledOnce();
    } finally {
      await h.session.close();
      await iterator.return?.();
      vi.useRealTimers();
    }
  });

  it.each(["invalidation", "close", "caller-abort"] as const)(
    "closes a late-opened runtime without readiness after %s",
    async (action) => {
      const entered = deferred<void>();
      const opened = deferred<RealtimeConversation>();
      let openSignal: AbortSignal | undefined;
      const h = createSession(async (_configuration, signal) => {
        openSignal = signal;
        entered.resolve();
        return opened.promise;
      });
      const controller = new AbortController();
      const configured = h.configure(controller.signal);
      try {
        await entered.promise;
        if (action === "invalidation") h.invalidate();
        else if (action === "close") await h.session.close();
        else controller.abort();
        const wasAborted = openSignal?.aborted;
        opened.resolve(h.runtime);
        expect(await configured).toEqual([]);
        expect(wasAborted).toBe(true);
        expect(h.runtime.close).toHaveBeenCalledOnce();
        expect(h.session.configured).toBe(false);
        expect(h.session.closed).toBe(true);
      } finally {
        opened.resolve(h.runtime);
        await configured;
        await h.session.close();
      }
    },
  );

  it("aborts an in-flight assistant append when external memory invalidates", async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    const h = createSession();
    const originalAppend = h.ledger.append.bind(h.ledger);
    let appendSignal: AbortSignal | undefined;
    vi.spyOn(h.ledger, "append").mockImplementation(async (input) => {
      if (input.role === "assistant") {
        appendSignal = input.signal;
        entered.resolve();
        await release.promise;
        input.signal?.throwIfAborted();
      }
      return originalAppend(input);
    });
    const iterator = h.session.outputs()[Symbol.asyncIterator]();
    try {
      await h.configure();
      await h.text();
      h.queue.push({ type: "response-started", turnId: h.turnId, responseId: h.responseId });
      h.queue.push({
        type: "response-text",
        turnId: h.turnId,
        responseId: h.responseId,
        text: "Old answer",
      });
      await iterator.next();
      await iterator.next();
      h.queue.push(h.completed());
      const completion = iterator.next();
      await entered.promise;
      h.invalidate();
      release.resolve();
      expect((await completion).done).toBe(true);
      expect(appendSignal?.aborted).toBe(true);
      expect(await h.ledger.findByRequest(h.turnId, "assistant")).toBeNull();
      await vi.waitFor(async () => {
        expect((await h.ledger.listTurns({ contextEpochId: await h.epochId() }))[0]?.failed).toBe(
          true,
        );
      });
    } finally {
      release.resolve();
      await h.session.close();
      await iterator.return?.();
    }
  });

  it.each(["integrated", "pipeline"] as const)(
    "rejects an in-flight %s answer when revision advances before invalidation is delivered",
    async (runtimeKind) => {
      const entered = deferred<void>();
      const release = deferred<void>();
      const h = createSession(undefined, runtimeKind);
      const originalAppend = h.ledger.append.bind(h.ledger);
      const expectedRevision = runtimeKind === "pipeline" ? 8 : 7;
      let observedRevision: number | undefined;
      let wasAborted: boolean | undefined;
      vi.spyOn(h.ledger, "append").mockImplementation(async (input) => {
        if (input.role === "assistant") {
          observedRevision = input.expectedMemoryRevision;
          entered.resolve();
          await release.promise;
          wasAborted = input.signal?.aborted;
        }
        return originalAppend(input);
      });
      const iterator = h.session.outputs()[Symbol.asyncIterator]();
      try {
        await h.configure();
        h.setRevision(expectedRevision);
        await h.text();
        h.queue.push({ type: "response-started", turnId: h.turnId, responseId: h.responseId });
        h.queue.push({
          type: "response-text",
          turnId: h.turnId,
          responseId: h.responseId,
          text: "Old answer",
        });
        await iterator.next();
        await iterator.next();
        h.queue.push({
          ...h.completed(),
          ...(runtimeKind === "pipeline" ? { memoryRevision: expectedRevision } : {}),
        });
        const completion = iterator.next();
        await entered.promise;
        h.setRevision(expectedRevision + 1);
        release.resolve();
        expect((await completion).value).toMatchObject({ code: "CONTEXT_SNAPSHOT_STALE" });
        expect(observedRevision).toBe(expectedRevision);
        expect(wasAborted).toBe(false);
        expect(h.session.closed).toBe(true);
        expect(await h.ledger.findByRequest(h.turnId, "assistant")).toBeNull();
        expect((await h.ledger.listTurns({ contextEpochId: await h.epochId() }))[0]?.failed).toBe(
          true,
        );
      } finally {
        release.resolve();
        await h.session.close();
        await iterator.return?.();
      }
    },
  );

  it.each(["ordinary", "paraphrased-confirmation"] as const)(
    "does not refresh the snapshot revision for an %s response",
    async (kind) => {
      const h = createSession();
      h.prepare.mockImplementationOnce(async () => {
        h.setRevision(8);
        return kind === "ordinary"
          ? { changes: [] }
          : {
              changes: [{ id: randomUUID(), kind: "corrected", version: 2 }],
              reply: "Correction saved",
            };
      });
      const guardedAppend = vi.spyOn(h.ledger, "append");
      const iterator = h.session.outputs()[Symbol.asyncIterator]();
      try {
        await h.configure();
        await h.text();
        h.queue.push({ type: "response-started", turnId: h.turnId, responseId: h.responseId });
        h.queue.push({
          type: "response-text",
          turnId: h.turnId,
          responseId: h.responseId,
          text: "Old facts",
        });
        h.queue.push(h.completed());
        await iterator.next();
        await iterator.next();
        expect((await iterator.next()).value).toMatchObject({ code: "CONTEXT_SNAPSHOT_STALE" });
        expect(
          guardedAppend.mock.calls.find(([input]) => input.role === "assistant")?.[0],
        ).toMatchObject({ expectedMemoryRevision: 7 });
        expect(await h.ledger.findByRequest(h.turnId, "assistant")).toBeNull();
        expect(h.session.closed).toBe(true);
      } finally {
        await h.session.close();
        await iterator.return?.();
      }
    },
  );

  it("does not send a confirmation when invalidation wins the post-write revision read", async () => {
    const h = createSession();
    const entered = deferred<void>();
    const release = deferred<void>();
    try {
      await h.configure();
      h.prepare.mockResolvedValueOnce({
        changes: [{ id: randomUUID(), kind: "corrected", version: 2 }],
        reply: "Saved",
      });
      h.state.mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
        return { revision: 8 };
      });
      const input = h.text();
      await entered.promise;
      h.invalidate();
      release.resolve();
      expect(await input).toMatchObject([{ code: "MEMORY_PROCESSING_FAILED" }]);
      expect(h.runtime.send).not.toHaveBeenCalled();
      expect(h.session.closed).toBe(true);
    } finally {
      release.resolve();
      await h.session.close();
    }
  });
});

function createSession(
  open?: RealtimeConversationPort["open"],
  runtimeKind: "integrated" | "pipeline" = "integrated",
) {
  let revision = 7;
  const ledger = new InMemoryConversationLedger(() => revision);
  const queue = new AsyncQueue<RealtimeConversationOutput>();
  const sessionId = randomUUID();
  const turnId = randomUUID();
  const responseId = randomUUID();
  let sequence = 1;
  const state = vi.fn(async () => ({ revision }));
  const prepare = vi.fn(async (): Promise<TurnMemoryResult> => ({ changes: [] }));
  let invalidate = (_exceptRequestId?: string) => {};
  const runtime = {
    capabilities: {
      inputModalities: ["text", "audio"],
      outputModalities: ["text", "audio"],
      interruption: true,
      runtimeKind,
      transcription: true,
      turnDetection: "server_vad",
      voiceKind: "preset",
    },
    close: vi.fn(async () => queue.close()),
    send: vi.fn(async () => {}),
    async *outputs() {
      while (true) {
        const output = await queue.next();
        if (!output) return;
        yield output;
      }
    },
  } satisfies RealtimeConversation;
  const memory = {
    repository: { state },
    async context() {
      return { revision, summary: "", excludedRequests: new Set<string>() };
    },
    onInvalidation(handler: typeof invalidate) {
      invalidate = handler;
      return () => {};
    },
    prepareRequest: prepare,
  } as unknown as MemoryService;
  const session = new RealtimeSession({
    ledger,
    memoryService: memory,
    generateId: randomUUID,
    conversationPort: { open: open ?? (async () => runtime) },
    conversationEndIntent: {
      async shouldEnd() {
        return false;
      },
    },
    contextService: new ContextService({
      artifactStore: new InMemoryContextArtifactStore(),
      repository: new InMemoryContextSessionRepository(),
      understanding: new DeterministicContextUnderstandingPort(),
    }),
  });
  const clientEvent = () => ({ eventId: randomUUID(), sessionId, sequence: sequence++ });
  return {
    session,
    prepare,
    state,
    setRevision: (value: number) => {
      revision = value;
    },
    ledger,
    runtime,
    queue,
    turnId,
    responseId,
    clientEvent,
    invalidate: (exceptRequestId?: string) => invalidate(exceptRequestId),
    respond: (id: string, text: string) => {
      const response = randomUUID();
      queue.push({ type: "response-started", turnId: id, responseId: response });
      queue.push({ type: "response-text", turnId: id, responseId: response, text });
      queue.push({
        type: "response-completed",
        turnId: id,
        responseId: response,
        inputTokens: 1,
        outputTokens: 1,
      });
    },
    epochId: async () => (await ledger.findByRequest(turnId, "user"))?.contextEpochId ?? "",
    configure: (signal?: AbortSignal) =>
      collect(
        session.handle(
          {
            ...clientEvent(),
            type: "session.configure",
            configuration: {
              protocolVersion: "1",
              inputModalities: ["text", "audio"],
              outputModalities: ["text", "audio"],
              turnDetection: "server_vad",
            },
          },
          signal,
        ),
      ),
    text: (id = turnId) =>
      collect(
        session.handle({
          ...clientEvent(),
          type: "input.text",
          turnId: id,
          text: "Correction",
        }),
      ),
    completed: (): RealtimeConversationOutput => ({
      type: "response-completed",
      turnId,
      responseId,
      inputTokens: 1,
      outputTokens: 1,
    }),
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of source) values.push(value);
  return values;
}
