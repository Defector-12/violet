import { randomUUID } from "node:crypto";
import type { RealtimeConversationInput, RealtimeConversationOutput } from "@violet/domain";
import type { RealtimeServerEvent } from "@violet/protocol";
import { describe, expect, it, vi } from "vitest";
import { ContextService } from "../context/context-service.js";
import { DeterministicContextUnderstandingPort } from "../context/deterministic-context-understanding.js";
import { InMemoryContextArtifactStore } from "../context/in-memory-context-artifact-store.js";
import { InMemoryContextSessionRepository } from "../context/in-memory-context-session-repository.js";
import { InMemoryConversationLedger } from "../conversation/in-memory-conversation-ledger.js";
import type { MemoryService, TurnMemoryResult } from "../memory/memory-service.js";
import { AsyncQueue } from "./async-queue.js";
import { RealtimeSession } from "./realtime-session.js";

describe("Realtime memory admission", () => {
  it.each(["created", "corrected", "failed"] as const)(
    "withholds provisional text/audio until Core resolves the final source (%s)",
    async (outcome) => {
      const failure = outcome === "failed";
      let revision = 7;
      const ledger = new InMemoryConversationLedger(() => revision);
      const append = vi.spyOn(ledger, "append");
      const sessionId = randomUUID();
      const turnId = randomUUID();
      const prematureId = randomUUID();
      const groundedId = randomUUID();
      const queue = new AsyncQueue<RealtimeConversationOutput>();
      const inputs: RealtimeConversationInput[] = [];
      let release = (_result: TurnMemoryResult) => {};
      let reject = (_error: Error) => {};
      let notifyStarted = () => {};
      let invalidate = (_exceptRequestId?: string) => {};
      const started = new Promise<void>((resolve) => {
        notifyStarted = resolve;
      });
      const result = new Promise<TurnMemoryResult>((resolve, fail) => {
        release = resolve;
        reject = fail;
      });
      const memory = {
        repository: { state: async () => ({ revision }) },
        async context() {
          return { revision, summary: "", excludedRequests: new Set<string>() };
        },
        onInvalidation: (handler: typeof invalidate) => {
          invalidate = handler;
          return () => {};
        },
        async prepareRequest(requestId: string) {
          expect(requestId).toBe(turnId);
          expect(await ledger.findByRequest(turnId, "user")).toMatchObject({
            content: "请记住我喜欢紫色",
          });
          notifyStarted();
          return result;
        },
      } as unknown as MemoryService;
      const session = new RealtimeSession({
        ledger,
        memoryService: memory,
        generateId: randomUUID,
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
        conversationPort: {
          async open() {
            return {
              capabilities: {
                inputModalities: ["audio"],
                outputModalities: ["audio", "text"],
                interruption: true,
                runtimeKind: "integrated",
                transcription: true,
                turnDetection: "server_vad",
                voiceKind: "preset",
              },
              async close() {
                queue.close();
              },
              async *outputs() {
                while (true) {
                  const event = await queue.next();
                  if (!event) return;
                  yield event;
                }
              },
              async send(input) {
                inputs.push(input);
                if (input.type === "memory-result") {
                  queue.push({ type: "response-started", responseId: groundedId, turnId });
                  queue.push({
                    type: "response-text",
                    responseId: groundedId,
                    turnId,
                    text: input.reply,
                  });
                  queue.push({
                    type: "response-completed",
                    responseId: groundedId,
                    turnId,
                    inputTokens: 1,
                    outputTokens: 1,
                  });
                  queue.close();
                }
              },
            };
          },
        },
      });
      for await (const _event of session.handle({
        type: "session.configure",
        eventId: randomUUID(),
        sessionId,
        sequence: 1,
        configuration: {
          protocolVersion: "1",
          inputModalities: ["audio"],
          outputModalities: ["text", "audio"],
          turnDetection: "server_vad",
        },
      })) {
        /* consume readiness */
      }
      queue.push({ type: "response-started", responseId: prematureId, turnId });
      queue.push({
        type: "response-text",
        responseId: prematureId,
        turnId,
        text: "未经确认的成功",
      });
      queue.push({
        type: "response-audio",
        responseId: prematureId,
        turnId,
        audio: new Uint8Array([1, 2]),
      });
      queue.push({
        type: "response-completed",
        responseId: prematureId,
        turnId,
        inputTokens: 1,
        outputTokens: 1,
      });
      queue.push({ type: "transcript", turnId, text: "请记住我喜欢紫色", final: true });
      const visible: RealtimeServerEvent[] = [];
      const output = (async () => {
        for await (const event of session.outputs()) {
          visible.push(event);
          // A client can stop consuming immediately after the terminal error.
          if (event.type === "error") break;
        }
      })();
      await started;
      expect(visible).toEqual([]);
      expect(await ledger.findByRequest(turnId, "assistant")).toBeNull();
      if (failure) reject(new Error("Synthetic database failure"));
      else {
        revision = 8;
        if (outcome === "corrected") invalidate(turnId);
        release({
          changes: [{ id: randomUUID(), version: 1, kind: outcome }],
          reply: "已记住。",
          memoryTransition: { previousRevision: 7, revision: 8 },
        });
      }
      await output;
      expect(JSON.stringify(visible)).not.toContain("未经确认");
      expect(visible.some((event) => event.type === "response.audio")).toBe(false);
      if (failure) {
        expect(visible).toMatchObject([{ type: "error", code: "MEMORY_PROCESSING_FAILED" }]);
        expect(session.closed).toBe(true);
        expect(
          (
            await ledger.listTurns({
              contextEpochId: (await ledger.findByRequest(turnId, "user"))?.contextEpochId ?? "",
            })
          )[0]?.failed,
        ).toBe(true);
      } else {
        expect(inputs).toContainEqual(
          expect.objectContaining({ type: "memory-result", reply: "已记住。" }),
        );
        expect(visible.find((event) => event.type === "response.completed")).toMatchObject({
          type: "response.completed",
          memoryChanges: [{ kind: outcome }],
        });
        if (outcome === "corrected") {
          expect(visible.slice(-2).map((event) => event.type)).toEqual([
            "response.completed",
            "session.end_requested",
          ]);
          expect(visible.at(-1)).toMatchObject({ reason: "memory_changed", turnId });
          expect(session.closed).toBe(true);
        } else {
          expect(visible.some((event) => event.type === "session.end_requested")).toBe(false);
          expect(session.closed).toBe(false);
        }
        expect(await ledger.findByRequest(turnId, "assistant")).toMatchObject({
          content: "已记住。",
        });
        expect(append.mock.calls.find(([input]) => input.role === "assistant")?.[0]).toMatchObject({
          expectedMemoryRevision: 8,
          signal: expect.any(AbortSignal),
        });
        expect(visible.find((event) => event.type === "response.completed")).not.toHaveProperty(
          "memoryRevision",
        );
      }
      await session.close();
    },
  );
});
