import type { ModelGateway, ModelStreamEvent } from "@violet/domain";
import { describe, expect, it } from "vitest";
import type { MemoryService } from "./memory-service.js";
import { streamWithRecall } from "./recall-memory-tool.js";

describe("shared recall tool loop", () => {
  it("disables recall tool registration when memory injection is rolled back", async () => {
    const memory = { injectionEnabled: false } as MemoryService;
    const model: ModelGateway = {
      async *stream(request): AsyncIterable<ModelStreamEvent> {
        expect(request.tools).toBeUndefined();
        yield { type: "complete", inputTokens: 1, outputTokens: 0 };
      },
    };
    for await (const _event of streamWithRecall(
      model,
      { requestId: "request", messages: [] },
      memory,
      true,
    )) {
      // No memory tool is registered and no repository lookup is attempted.
    }
  });

  it("keeps intermediate text private, correlates the result, and reports aggregate usage", async () => {
    let turns = 0;
    const queries: unknown[] = [];
    const memory = {
      async recall(query: unknown, history: boolean) {
        queries.push({ query, history });
        return { status: "not_found", items: [] };
      },
    } as unknown as MemoryService;
    const model: ModelGateway = {
      async *stream(request): AsyncIterable<ModelStreamEvent> {
        turns++;
        if (turns === 1) {
          yield { type: "delta", content: "未经检索的猜测" };
          yield {
            type: "complete",
            inputTokens: 4,
            outputTokens: 2,
            toolCalls: [
              {
                id: "call-1",
                name: "recall_memory",
                arguments: '{"query":"上次项目","from":"2026-09-01T00:00:00Z"}',
              },
            ],
          };
        } else {
          expect(request.messages.at(-1)).toMatchObject({
            role: "tool",
            toolCallId: "call-1",
          });
          expect(JSON.parse(request.messages.at(-1)?.content ?? "")).toMatchObject({
            status: "not_found",
            items: [],
            searchNote: expect.stringContaining("distinctive subject"),
          });
          yield { type: "delta", content: "想不起来了。" };
          yield { type: "complete", inputTokens: 8, outputTokens: 3 };
        }
      },
    };
    const events: ModelStreamEvent[] = [];
    for await (const event of streamWithRecall(
      model,
      {
        requestId: "request",
        messages: [{ role: "user", content: "上次的项目叫什么？" }],
      },
      memory,
      true,
    ))
      events.push(event);
    expect(events).toEqual([
      { type: "delta", content: "想不起来了。" },
      { type: "complete", inputTokens: 12, outputTokens: 5 },
    ]);
    expect(queries).toEqual([
      { query: { query: "上次项目", from: "2026-09-01T00:00:00Z" }, history: true },
    ]);
  });

  it("fails without exposing a guess if a recall result was invalidated", async () => {
    const memory = {
      async recall() {
        throw new Error("Memory changed");
      },
    } as unknown as MemoryService;
    const model: ModelGateway = {
      async *stream(): AsyncIterable<ModelStreamEvent> {
        yield { type: "delta", content: "过时猜测" };
        yield {
          type: "complete",
          inputTokens: 1,
          outputTokens: 1,
          toolCalls: [{ id: "call-1", name: "recall_memory", arguments: '{"query":"项目"}' }],
        };
      },
    };
    const events: ModelStreamEvent[] = [];
    await expect(
      (async () => {
        for await (const event of streamWithRecall(
          model,
          { requestId: "request", messages: [] },
          memory,
          false,
        ))
          events.push(event);
      })(),
    ).rejects.toThrow("Memory changed");
    expect(events).toEqual([]);
  });

  it("leaves an answer-only round after three searches instead of dropping the last result", async () => {
    let rounds = 0;
    const memory = {
      async recall() {
        return { status: "found", items: [{ id: "source", content: "The choice was Dunhuang." }] };
      },
    } as unknown as MemoryService;
    const model: ModelGateway = {
      async *stream(request): AsyncIterable<ModelStreamEvent> {
        rounds++;
        if (rounds <= 3) {
          expect(request.tools).toHaveLength(1);
          yield {
            type: "complete",
            inputTokens: 1,
            outputTokens: 1,
            toolCalls: [
              { id: `call-${rounds}`, name: "recall_memory", arguments: '{"query":"旅行"}' },
            ],
          };
        } else {
          expect(request.tools).toEqual([]);
          expect(request.messages.at(-1)?.content).toContain("Dunhuang");
          yield { type: "delta", content: "敦煌。" };
          yield { type: "complete", inputTokens: 1, outputTokens: 1 };
        }
      },
    };
    const events = [];
    for await (const event of streamWithRecall(
      model,
      { requestId: "request", messages: [] },
      memory,
      true,
    ))
      events.push(event);
    expect(rounds).toBe(4);
    expect(events).toEqual([
      { type: "delta", content: "敦煌。" },
      { type: "complete", inputTokens: 4, outputTokens: 4 },
    ]);
  });
});
