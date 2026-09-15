import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  recordTestTrace,
  redactTraceText,
  sanitizeTrace,
  TestTraceError,
  TestTraceStore,
  withTestTrace,
  withTestTraceIds,
} from "./test-trace.js";

const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(resolve(".local-acceptance/trace-unit-"));
  directories.push(root);
  let now = Date.parse("2026-09-12T00:00:00Z");
  const store = new TestTraceStore(root, () => now);
  const runId = randomUUID();
  const until = new Date(now + 60_000).toISOString();
  return {
    root,
    store,
    runId,
    until,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("test trace", () => {
  it("notifies active listeners on recording failure", () => {
    const f = fixture();
    const trace = f.store.open(f.runId, f.until, "test");
    let stopped = 0;
    const remove = trace.onFailure(() => {
      stopped++;
    });
    trace.onFailure(() => {
      stopped++;
    });
    remove();
    const file = readdirSync(join(f.root, f.runId)).find((name) => name.endsWith(".ndjson"));
    if (!file) throw new Error("Expected a trace file");
    rmSync(join(f.root, f.runId, file));
    expect(() => trace.record("missing", {})).toThrow();
    expect(stopped).toBe(1);
  });

  it("restores private permissions before appending to a trace", () => {
    const f = fixture();
    const trace = f.store.open(f.runId, f.until, "test");
    const file = readdirSync(join(f.root, f.runId)).find((name) => name.endsWith(".ndjson"));
    if (!file) throw new Error("Expected a trace file");
    const path = join(f.root, f.runId, file);
    chmodSync(path, 0o644);
    trace.record("after-permission-change", {});
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("does not record outside an explicitly scoped test", () => {
    expect(() => recordTestTrace("ordinary-session", { text: "nothing persisted" })).not.toThrow();
  });

  it("preserves session and turn identity across asynchronous work", async () => {
    const f = fixture();
    const trace = f.store.open(f.runId, f.until, "test-version");
    await withTestTrace(trace, () =>
      withTestTraceIds({ sessionId: "session", turnId: "first" }, async () => {
        recordTestTrace("input", { question: "Where?" });
        await withTestTraceIds({ requestId: "capture" }, async () => {
          await Promise.resolve();
          recordTestTrace("model", { result: "east" });
        });
        recordTestTrace("answer", { text: "east" });
      }),
    );
    const rows = f.store
      .snapshot(f.runId)
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(rows).toHaveLength(4);
    expect(rows[2]).toMatchObject({ sessionId: "session", turnId: "first", requestId: "capture" });
    expect(rows[3]).not.toHaveProperty("requestId");
    const file = readdirSync(join(f.root, f.runId)).find((name) => name.endsWith(".ndjson"));
    expect(statSync(join(f.root, f.runId, file ?? "")).mode & 0o777).toBe(0o600);
  });

  it("redacts secrets and binary payloads without altering the input object", () => {
    const value = {
      authorization: "Bearer private-value",
      apiKey: "secret-value",
      history: [{ content: "unrelated private conversation" }],
      text: "password=very-secret sk-12345678901234567890",
      audio: Buffer.from("private audio").toString("base64"),
      image: { data: Buffer.from("image").toString("base64"), width: 5 },
      reasoning_content: "unneeded provider internals",
    };
    const sanitized = JSON.stringify(sanitizeTrace(value));
    for (const secret of [
      "very-secret",
      "12345678901234567890",
      "private-value",
      "secret-value",
      "unrelated private",
      value.audio,
      value.image.data,
    ]) {
      expect(sanitized).not.toContain(secret);
    }
    expect(value.authorization).toBe("Bearer private-value");
    expect(sanitized).toContain("byteLength");
    expect(sanitized).not.toContain("unneeded provider internals");
  });

  it("redacts credentials embedded in JSON text", () => {
    const value = redactTraceText(
      '{"password":"synthetic-secret","api_key":"synthetic-api-value"}',
    );
    expect(value).not.toContain("synthetic-secret");
    expect(value).not.toContain("synthetic-api-value");
    expect(value).toContain("[REDACTED_SECRET]");
  });

  it("does not log split text chunks that can bypass secret redaction", () => {
    expect(
      JSON.stringify(sanitizeTrace({ type: "response.text.delta", delta: "sk-12345" })),
    ).not.toContain("sk-12345");
    expect(
      JSON.stringify(sanitizeTrace({ type: "transcript", final: false, text: "private-fragment" })),
    ).not.toContain("private-fragment");
  });

  it("preserves UUID correlation fields without exempting secrets or arbitrary text", () => {
    const id = "12345678-1234-4123-8123-123456789012";
    for (const key of ["turnId", "sessionId", "requestId", "responseId", "eventId"]) {
      expect(sanitizeTrace(id, key)).toBe(id);
      expect(sanitizeTrace("password=synthetic-secret", key)).not.toContain("synthetic-secret");
      expect(sanitizeTrace("1234567890123456", key)).not.toBe("1234567890123456");
    }
    expect(sanitizeTrace(id, "text")).not.toBe(id);
    expect(sanitizeTrace(id, "secret")).toBe("[REDACTED]");
  });

  it("reuses one run file and rejects expired or path-like run grants", () => {
    const f = fixture();
    expect(() => f.store.prepare("../escape", f.until)).toThrow();
    f.store
      .open(f.runId, f.until, "one")
      .record("original-failure", { error: "capture-unavailable" });
    f.store.open(f.runId, f.until, "two").record("retest", { result: "same run" });
    expect(f.store.snapshot(f.runId)).toContain("original-failure");
    expect(f.store.snapshot(f.runId)).toContain("retest");
    expect(
      readdirSync(join(f.root, f.runId)).filter((name) => name.endsWith(".ndjson")),
    ).toHaveLength(1);
    f.advance(60_001);
    expect(() => f.store.open(f.runId, f.until, "late")).toThrow(TestTraceError);
  });

  it("stops recording at the deadline and retains the earlier events", () => {
    const f = fixture();
    const trace = f.store.open(f.runId, f.until, "test");
    let notified = false;
    trace.onFailure(() => {
      notified = true;
    });
    f.advance(60_001);
    expect(() => trace.record("late", {})).toThrow(TestTraceError);
    expect(notified).toBe(true);
    expect(f.store.snapshot(f.runId)).toContain("trace.ready");
    expect(f.store.snapshot(f.runId)).not.toContain('"type":"late"');
  });

  it("purges only expired trace directories", () => {
    const f = fixture();
    f.store.open(f.runId, f.until, "test");
    const unrelated = join(f.root, "my-notes.txt");
    writeFileSync(unrelated, "keep");
    f.advance(86_400_001);
    f.store.purgeExpired();
    expect(existsSync(join(f.root, f.runId))).toBe(false);
    expect(readFileSync(unrelated, "utf8")).toBe("keep");
  });

  it("rejects symlink run directories", () => {
    const f = fixture();
    const id = randomUUID();
    symlinkSync(f.root, join(f.root, id), "dir");
    expect(() => f.store.prepare(id, f.until)).toThrow();
  });

  it("[defect-probing] stops rather than silently recreating a missing trace file", () => {
    const f = fixture();
    const trace = f.store.open(f.runId, f.until, "test");
    const name = readdirSync(join(f.root, f.runId)).find((file) => file.endsWith(".ndjson"));
    const path = join(f.root, f.runId, name ?? "");
    rmSync(path);
    let notified = false;
    trace.onFailure(() => {
      notified = true;
    });
    expect(() => trace.record("after-loss", { text: "not a new empty history" })).toThrow(
      TestTraceError,
    );
    expect(notified).toBe(true);
    expect(existsSync(path)).toBe(false);
  });
});
