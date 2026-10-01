import { randomUUID } from "node:crypto";
import type {
  LedgerMessage,
  Memory,
  ModelGateway,
  ModelRequest,
  ModelStreamEvent,
} from "@violet/domain";
import { describe, expect, it } from "vitest";
import { proposeMemory, validateProposal } from "./memory-proposal.js";
import { parseRecallQuery, searchMemory } from "./memory-search.js";
import { buildMemorySummary } from "./memory-summary.js";

const source: LedgerMessage = {
  id: randomUUID(),
  requestId: randomUUID(),
  role: "user",
  sequence: 1,
  occurredAt: new Date("2026-09-20T00:00:00Z"),
  content: "请记住：我喜欢紫色 🪻",
};
const memory: Memory = {
  id: randomUUID(),
  version: 1,
  state: "current",
  origin: "explicit",
  kind: "preference",
  content: "我喜欢紫色 🪻",
  sensitivity: "normal",
  createdAt: source.occurredAt.toISOString(),
  updatedAt: source.occurredAt.toISOString(),
  sources: [{ eventId: source.id, startByte: 0, endByte: 1 }],
};

describe("memory proposal and bounded context", () => {
  it("rejects automatic governance proposals and prioritizes explicit summary entries", async () => {
    for (const proposal of [
      { intent: "forget", id: memory.id, version: 1 },
      { intent: "clarify" },
      {
        intent: "write",
        writes: [
          {
            content: memory.content,
            quote: memory.content,
            kind: memory.kind,
            targetId: memory.id,
            targetVersion: 1,
            action: "correct",
          },
        ],
      },
    ]) {
      expect(() => validateProposal(proposal, source, [memory], "automatic")).toThrow("Automatic");
    }
    expect(
      buildMemorySummary({
        instanceId: randomUUID(),
        revision: 1,
        deletionRevision: 0,
        restoreEpoch: 0,
        memories: [
          { ...memory, id: "automatic", origin: "automatic", updatedAt: "2026-09-29" },
          memory,
        ],
      })
        .content.split("\n")
        .map((line) => JSON.parse(line).id),
    ).toEqual([memory.id, "automatic"]);
    let calls = 0;
    const model: ModelGateway = {
      stream() {
        calls++;
        throw new Error("must not call");
      },
    };
    for (const content of [
      "请记住，我对花生过敏。",
      "我的密码是 synthetic-test-value",
      "我养了一只鸟，但不要保存这件事。",
      "I enjoy hiking, but don't remember this about me.",
    ]) {
      expect(
        await proposeMemory(model, { ...source, content }, [], undefined, "automatic"),
      ).toEqual({
        intent: "none",
        history: false,
      });
    }
    expect(calls).toBe(0);
  });

  it("keeps automatic new claims verbatim without changing explicit writes or duplicate identity", () => {
    const quote = "I hope to repair my aunt's bicycle";
    const input = { ...source, content: `${quote}.` };
    const proposal = {
      intent: "write",
      writes: [{ content: "He hopes to repair his aunt's bicycle", quote, kind: "goal" }],
    };
    expect(validateProposal(proposal, input, [], "automatic")).toMatchObject({
      writes: [{ content: quote, source: { quote, startByte: 0, endByte: quote.length } }],
    });
    expect(
      validateProposal(proposal, { ...input, content: `Please remember: ${quote}.` }, []),
    ).toMatchObject({
      writes: [{ content: proposal.writes[0]?.content }],
    });
    const duplicate = {
      intent: "write",
      writes: [{ content: memory.content, quote: memory.content, kind: memory.kind }],
    };
    expect(validateProposal(duplicate, source, [memory], "automatic")).toMatchObject({
      writes: [
        {
          content: memory.content,
          target: { id: memory.id, version: memory.version, action: "add_source" },
        },
      ],
    });
    for (const candidates of [
      [{ ...memory, content: `${memory.content}。` }],
      [{ ...memory, kind: "fact" as const }],
      [memory, { ...memory, id: randomUUID() }],
    ]) {
      const result = validateProposal(duplicate, source, candidates, "automatic");
      if (result.intent !== "write") throw new Error("Expected writes");
      expect(result.writes[0]?.target).toBeUndefined();
    }
    expect(() =>
      validateProposal(
        {
          ...duplicate,
          writes: [{ ...duplicate.writes[0], action: "supersede" }],
        },
        source,
        [memory],
        "automatic",
      ),
    ).toThrow("target");
  });

  it.each([
    "我平时喜欢用紫色书签",
    "我平常喜欢用橙色笔记本",
    "我平常喜欢用蓝色文件夹",
    "我现在喜欢橙色",
    "I prefer quiet rooms.",
    "我喜欢喝茶，但不要保存。",
    "I enjoy gardening, but don't remember this.",
  ])(
    "rejects an erroneous explicit write for a statement without authorization: %s",
    async (content) => {
      const model: ModelGateway = {
        async *stream(): AsyncIterable<ModelStreamEvent> {
          yield {
            type: "delta",
            content: JSON.stringify({
              intent: "write",
              writes: [{ content, quote: content, kind: "preference" }],
            }),
          };
          yield { type: "complete", inputTokens: 1, outputTokens: 1 };
        },
      };
      expect(await proposeMemory(model, { ...source, content }, [])).toEqual({
        intent: "none",
        history: false,
      });
      expect(
        validateProposal(
          {
            intent: "write",
            writes: [
              {
                content,
                quote: content,
                kind: "preference",
                targetId: memory.id,
                targetVersion: memory.version,
                action: "correct",
              },
            ],
          },
          { ...source, content },
          [memory],
        ),
      ).toEqual({ intent: "none", history: false });
    },
  );

  it("derives exact UTF-8 offsets from the final user's quote and rejects invented sources", () => {
    const proposal = {
      intent: "write",
      writes: [{ content: "我喜欢紫色 🪻", quote: "我喜欢紫色 🪻", kind: "preference" }],
    };
    const result = validateProposal(proposal, source, []);
    expect(result.intent).toBe("write");
    if (result.intent !== "write") throw new Error("Expected writes");
    const citation = result.writes[0]?.source;
    expect(citation).toMatchObject({ startByte: 12, endByte: Buffer.byteLength(source.content) });
    expect(() =>
      validateProposal(
        { ...proposal, writes: [{ ...proposal.writes[0], quote: "助手猜测用户喜欢蓝色" }] },
        source,
        [],
      ),
    ).toThrow("source");
    expect(() =>
      validateProposal({ intent: "forget", id: randomUUID(), version: 1 }, source, [memory]),
    ).toThrow("not current");
  });

  it("never sends a secret or explicitly controlled source to the extraction model", async () => {
    let calls = 0;
    const model: ModelGateway = {
      stream(): AsyncIterable<ModelStreamEvent> {
        calls++;
        throw new Error("Should not extract sensitive content");
      },
    };
    await expect(
      proposeMemory(model, { ...source, content: "请记住，我的密码是 synthetic-test-value" }, []),
    ).rejects.toThrow("credentials");
    const sensitive = { ...source, content: "请记住，我对花生过敏。" };
    const result = await proposeMemory(model, sensitive, []);
    expect(result).toMatchObject({
      intent: "write",
      writes: [
        {
          content: sensitive.content,
          sensitivity: "controlled",
          source: { quote: sensitive.content },
        },
      ],
    });
    expect(await proposeMemory(model, { ...sensitive, content: "我对花生过敏。" }, [])).toEqual({
      intent: "none",
      history: false,
    });
    expect(calls).toBe(0);
  });

  it.each(["现在改为晚上读诗", "纠正周末读诗习惯：现在改为晚上读诗。"])(
    "preserves the correction sentence without neighboring ordinary statements (quote=%s)",
    (quote) => {
      const clause = "纠正周末读诗习惯：现在改为晚上读诗。";
      const before = "今天阳光很好。";
      const correctedSource = {
        ...source,
        content: `${before}${clause}今天出门了。`,
      };
      const result = validateProposal(
        {
          intent: "write",
          writes: [
            {
              content: "晚上读诗",
              quote,
              kind: "fact",
              targetId: memory.id,
              targetVersion: 1,
              action: "correct",
            },
          ],
        },
        correctedSource,
        [memory],
      );
      expect(result).toMatchObject({
        intent: "write",
        writes: [
          {
            content: clause,
            kind: memory.kind,
            source: {
              startByte: Buffer.byteLength(before),
              endByte: Buffer.byteLength(before + clause),
              quote: clause,
            },
            target: { id: memory.id, version: 1, action: "correct" },
          },
        ],
      });
    },
  );

  it.each(["explicit", "automatic"] as const)(
    "uses only final user and normal candidates with the provider JSON contract (%s)",
    async (mode) => {
      let sent: ModelRequest | undefined;
      const model: ModelGateway = {
        async *stream(request): AsyncIterable<ModelStreamEvent> {
          if (request.jsonOutput && !request.messages.some((item) => /json/i.test(item.content)))
            throw new Error("400 Prompt must contain the word 'json'");
          sent = request;
          yield { type: "delta", content: '{"intent":"none","history":true}' };
          yield { type: "complete", inputTokens: 1, outputTokens: 1 };
        },
      };
      expect(
        await proposeMemory(
          model,
          source,
          [{ ...memory, sensitivity: "controlled", content: "诊断原文" }],
          undefined,
          mode,
        ),
      ).toEqual({ intent: "none", history: true });
      expect(JSON.stringify(sent)).not.toContain("诊断原文");
      expect(sent?.jsonOutput).toBe(true);
    },
  );

  it.each([
    "你记住我对花生过敏了吗？",
    "你记住我对花生过敏了吗",
    "你记住我对花生过敏了吗，请回答。",
    "你记住我对花生过敏了吗。请回答。",
    "你记住我对花生过敏了吗；请回答。",
    "你记住我对花生过敏了吗;请回答。",
    "你记住我对花生过敏了吗——请回答。",
    "你记住我对花生过敏了吗👉请回答。",
    "请记住，我对花生过敏吗？",
    "记住我对花生过敏没有",
    "记住我对花生过敏没有，请回答。",
    "不要记住我对花生过敏。",
    "请记住，我对花生过敏，但不要保存。",
    "请记住“我对花生过敏”这句话。",
    "请翻译：记住我对花生过敏。",
    "Remember I have an allergy to peanuts?",
    "Remember I have an allergy to peanuts, right",
    "Remember I have an allergy to peanuts, right, please answer.",
    "Remember I have an allergy to peanuts, right; please answer.",
    "Remember I have an allergy to peanuts, right—please answer.",
    "Please remember my allergy to peanuts, but do not save it.",
  ])("does not authorize controlled memory from ambiguous text: %s", async (content) => {
    let calls = 0;
    const model: ModelGateway = {
      stream(): AsyncIterable<ModelStreamEvent> {
        calls++;
        throw new Error("Sensitive text must not be extracted");
      },
    };
    expect(await proposeMemory(model, { ...source, content }, [])).toEqual({
      intent: "none",
      history: false,
    });
    expect(calls).toBe(0);
  });

  it.each([
    "请你帮我记住：我对花生过敏。",
    "记住原文：我对花生过敏。",
    "Please remember that I have an allergy to peanuts.",
    "请记住，我可能对花生过敏。",
    "请记住，我没有花生过敏病史。",
    "请记住，我可能对花生过敏。还没有确诊，复查后再更新。",
    "请记住，我对花生过敏。\n药物过敏目前没有。",
    "Please remember my medical history: I don't have diabetes.",
    "Please remember I may have an allergy. This is a guess.",
    "Please remember my medical history: I don’t have diabetes.",
  ])("preserves an explicit controlled statement verbatim: %s", async (content) => {
    const model: ModelGateway = {
      stream(): AsyncIterable<ModelStreamEvent> {
        throw new Error("Sensitive text must not be extracted");
      },
    };
    expect(await proposeMemory(model, { ...source, content }, [])).toMatchObject({
      intent: "write",
      writes: [
        {
          content,
          sensitivity: "controlled",
          source: { startByte: 0, endByte: Buffer.byteLength(content), quote: content },
        },
      ],
    });
  });

  it("bounds deterministic complete summary entries to 8,900 bytes and masks controlled text", () => {
    const memories = Array.from({ length: 150 }, (_, index) => ({
      ...memory,
      id: `memory-${index}`,
      content: `🪻${"紫色".repeat(50)}`,
    }));
    memories.unshift({ ...memory, content: "受控诊断原文", sensitivity: "controlled" });
    const snapshot = {
      instanceId: randomUUID(),
      revision: 3,
      deletionRevision: 0,
      restoreEpoch: 0,
      memories,
    };
    const summary = buildMemorySummary(snapshot);
    expect(summary).toEqual(buildMemorySummary({ ...snapshot, memories: [...memories].reverse() }));
    expect(Buffer.byteLength(summary.content)).toBeLessThanOrEqual(8_900);
    for (const line of summary.content.split("\n")) expect(() => JSON.parse(line)).not.toThrow();
    expect(summary.content).not.toContain("受控诊断原文");
  });

  it("normalizes Unicode, bounds Top-5, applies time, and excludes assistant/secret/controlled facts", () => {
    const candidates = Array.from({ length: 8 }, (_, index) => ({
      ...memory,
      id: `m-${index}`,
      content: `VIOLET　项目 ${index}`,
    }));
    const results = searchMemory({ query: "ｖｉｏｌｅｔ 项目" }, candidates, [
      { ...source, id: "assistant", role: "assistant", content: "violet 项目助手猜测" },
      { ...source, id: "secret", content: "violet token=synthetic-test-value" },
    ]);
    expect(results).toHaveLength(5);
    expect(results.every((item) => item.state === "current")).toBe(true);
    expect(searchMemory({ query: "violet", from: "2026-09-21T00:00:00Z" }, candidates, [])).toEqual(
      [],
    );
    expect(searchMemory({ query: "登山" }, candidates, [])).toEqual([]);
    expect(() => parseRecallQuery('{"query":"violet","from":"tomorrow"}')).toThrow();
    expect(() => parseRecallQuery('{"query":"violet","extra":true}')).toThrow();
  });

  it("retains single-character Chinese terms and requires the whole recall topic", () => {
    const events = [
      { ...source, id: "bucket", content: "以前讨论过雨水收集桶的摆放位置。" },
      { ...source, id: "running", content: "上次夜跑路线经过石拱桥。" },
      { ...source, id: "baking", content: "那天的烘焙实验使用了荞麦粉。" },
      { ...source, id: "game", content: "之前选的桌游是卡坦岛。" },
    ];
    for (const [query, expected] of [
      ["桶 摆放", "bucket"],
      ["夜跑 桥", "running"],
      ["桌游", "game"],
    ]) {
      expect(searchMemory({ query: query ?? "" }, [], events).map((item) => item.id)).toEqual([
        expected,
      ]);
    }
    expect(searchMemory({ query: "炼钢 实验" }, [], events)).toEqual([]);
    expect(searchMemory({ query: "烘焙 实验" }, [], events).map((item) => item.id)).toEqual([
      "baking",
    ]);
  });
});
