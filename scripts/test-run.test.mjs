import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createRun,
  parseEvents,
  purgeRuns,
  redactCommandOutput,
  renderReport,
  runCommand,
  workingTreeFingerprint,
} from "./test-run.mjs";

const roots = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const manifest = {
  runId: "run",
  source: "human",
  testCase: "pdf",
  createdAt: "2026-09-12T00:00:00Z",
  activeUntil: "2026-09-12T00:30:00Z",
  expiresAt: "2026-09-13T00:00:00Z",
};
const event = (type, data = {}, source = "core") => ({
  schemaVersion: 1,
  runId: "run",
  type,
  data,
  source,
  recordedAt: "2026-09-12T00:01:00Z",
  sequence: 1,
  file: "core.ndjson",
  line: 1,
});

describe("test-run reporting", () => {
  it("creates unique private runs without overwriting earlier results", async () => {
    const root = await mkdtemp(resolve(".local-acceptance/report-unit-"));
    roots.push(root);
    const first = await createRun(root, "human", "first");
    const second = await createRun(root, "human", "second");
    expect(first).not.toBe(second);
    expect((await stat(join(first, "manifest.json"))).mode & 0o777).toBe(0o600);
    expect(await readFile(join(root, "README.md"), "utf8")).toContain("first");
    expect(await readFile(join(first, "REPORT.md"), "utf8")).toContain("not yet verified");
  });

  it("preserves parse gaps instead of dropping malformed log lines", () => {
    const result = parseEvents(
      `${JSON.stringify(event("capture.failed"))}\n{"partial":`,
      "core.ndjson",
    );
    expect(result.events).toHaveLength(1);
    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0]).toContain("core.ndjson:2");
  });

  it("reports the question, cancellation and final answer as distinct events", () => {
    const report = renderReport(manifest, [
      event("trace.ready", {}, "mac"),
      event("trace.ready"),
      event("runtime.output", {
        type: "transcript",
        final: true,
        turnId: "TURN",
        text: "Which gate?",
      }),
      event("answer.cancelled", { turnId: "turn", responseId: "tool", text: "" }),
      event("answer.completed", { turnId: "turn", responseId: "answer", text: "Eastern gate." }),
    ]);
    expect(report).toContain("Which gate?");
    expect(report).toContain("Eastern gate.");
    expect(report).toContain("answer.cancelled");
    expect(report).toContain("not a product PASS");
  });

  it("marks an absent Core recorder missing", () => {
    expect(renderReport(manifest, [event("trace.ready", {}, "mac")])).toContain(
      "MISSING: Core trace",
    );
  });

  it("[defect-probing] reports a capture with no terminal outcome even when both recorders started", () => {
    const report = renderReport(manifest, [
      event("trace.ready", {}, "mac"),
      event("trace.ready"),
      event("capture.requested", { turnId: "turn", requestId: "capture" }),
    ]);
    expect(report).toContain("MISSING: capture");
  });

  it("reports HTTP-only questions, answers and terminal outcomes by request ID", () => {
    const requestId = "12345678-1234-4123-8123-123456789012";
    const report = renderReport({ ...manifest, source: "automation" }, [
      event("trace.ready"),
      event("http.receive", {
        path: "/v1/chat/stream",
        body: { requestId, message: "Which gate?" },
      }),
      event("chat.completed", { requestId, text: "Eastern gate." }),
    ]);

    expect(report).toContain(`Request ID: \`${requestId}\``);
    expect(report).toContain("Which gate?");
    expect(report).toContain("Eastern gate.");
    expect(report).toContain("Terminal Status: completed");
    expect(report).not.toContain(`MISSING: request ${requestId}`);
  });

  it("marks HTTP and realtime runs without terminal evidence incomplete", () => {
    const requestId = "12345678-1234-4123-8123-123456789012";
    const report = renderReport({ ...manifest, source: "automation" }, [
      event("trace.ready"),
      event("http.receive", {
        path: "/v1/chat/stream",
        body: { requestId, message: "Which gate?" },
      }),
      event("core.receive", { type: "session.configure" }),
    ]);

    expect(report).toContain(`MISSING: request ${requestId}: no terminal outcome recorded.`);
    expect(report).toContain("MISSING: Realtime session closure is missing.");
  });

  it("purges expired raw evidence automatically while retaining conclusions", async () => {
    const root = await mkdtemp(resolve(".local-acceptance/purge-unit-"));
    roots.push(root);
    const runId = "expired-run";
    const directory = join(root, runId);
    await mkdir(join(directory, "server"), { recursive: true });
    await writeFile(
      join(directory, "manifest.json"),
      JSON.stringify({
        ...manifest,
        purpose: "violet-test-trace",
        runId,
        expiresAt: "2026-09-13T00:00:00Z",
      }),
    );
    for (const name of [
      "acceptance.ndjson",
      "core.ndjson",
      "ledger.ndjson",
      "capture-example.json",
      "stdout.log",
      "stderr.log",
      "failure.json",
    ]) {
      await writeFile(join(directory, name), "raw");
    }
    await writeFile(join(directory, "result.json"), '{"status":"retained"}');
    await writeFile(join(directory, "server", "raw.ndjson"), "raw");

    await purgeRuns(root, Date.parse("2026-09-14T00:00:00Z"));

    expect(await readdir(directory)).toEqual(
      expect.arrayContaining(["manifest.json", "REPORT.md", "result.json"]),
    );
    expect(await readdir(directory)).not.toEqual(
      expect.arrayContaining(["acceptance.ndjson", "core.ndjson", "server"]),
    );
    expect(await readFile(join(directory, "REPORT.md"), "utf8")).toContain("Raw evidence expired");
  });

  it("records command failures, stdout and stderr without logging credentials", async () => {
    const root = await mkdtemp(resolve(".local-acceptance/command-unit-"));
    roots.push(root);
    const code = await runCommand(root, [
      process.execPath,
      "-e",
      "console.log('synthetic output');console.error('password=synthetic-secret');process.exit(3)",
    ]);
    expect(code).toBe(3);
    const { readdir } = await import("node:fs/promises");
    const dir = (await readdir(root, { withFileTypes: true })).find((entry) => entry.isDirectory());
    const path = join(root, dir.name);
    expect(await readFile(join(path, "stdout.log"), "utf8")).toContain("synthetic output");
    expect(await readFile(join(path, "stderr.log"), "utf8")).not.toContain("synthetic-secret");
    expect(JSON.parse(await readFile(join(path, "result.json"), "utf8")).exitCode).toBe(3);
  });

  it("redacts labeled secrets and credential-bearing URLs", () => {
    expect(
      redactCommandOutput(
        [
          "https://user:private@example.test",
          "postgresql://violet:database-secret@postgres:5432/violet",
          "token=private-value",
          "TOS_SECRET_ACCESS_KEY=tos-secret",
          "AWS_ACCESS_KEY_ID=aws-key",
          '{"password":"json-secret","api_key":"json-api-key"}',
        ].join(" "),
      ),
    ).not.toContain("private");
    expect(
      redactCommandOutput(
        'postgresql://violet:database-secret@postgres:5432/violet TOS_SECRET_ACCESS_KEY=tos-secret AWS_ACCESS_KEY_ID=aws-key {"password":"json-secret","api_key":"json-api-key"}',
      ),
    ).not.toMatch(/database-secret|tos-secret|aws-key|json-(?:secret|api-key)/u);
  });

  it("fingerprints untracked source content", async () => {
    const path = resolve(`fingerprint-unit-${randomUUID()}.txt`);
    try {
      await writeFile(path, "first");
      const first = await workingTreeFingerprint(resolve("."));
      await writeFile(path, "second");
      const second = await workingTreeFingerprint(resolve("."));
      expect(second).not.toBe(first);
    } finally {
      await rm(path, { force: true });
    }
  });
});
