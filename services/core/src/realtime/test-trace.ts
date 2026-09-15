import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const maximumDurationMs = 30 * 60_000;
const retentionMs = 24 * 60 * 60_000;
const maximumTraceBytes = 8 * 1024 * 1024;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

interface TraceScope {
  readonly trace: TestTrace;
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly requestId?: string;
}
const scope = new AsyncLocalStorage<TraceScope>();

export function withTestTrace<T>(trace: TestTrace | undefined, operation: () => T): T {
  return trace ? scope.run({ trace }, operation) : operation();
}

export function withTestTraceIds<T>(ids: Omit<TraceScope, "trace">, operation: () => T): T {
  const current = scope.getStore();
  return current ? scope.run({ ...current, ...ids }, operation) : operation();
}

export function recordTestTrace(type: string, data: unknown): void {
  const current = scope.getStore();
  if (current) {
    const { trace, ...ids } = current;
    trace.record(type, data, ids);
  }
}

export function testTraceEnabled(): boolean {
  return scope.getStore() !== undefined;
}

export class TestTraceError extends Error {
  constructor() {
    super("Test recording is unavailable, expired or full. Stop this test run.");
    this.name = "TestTraceError";
  }
}

interface RunManifest {
  readonly runId: string;
  readonly activeUntil: string;
  readonly expiresAt: string;
  readonly purpose: "violet-test-trace";
  readonly schemaVersion: 1;
}

export class TestTraceStore {
  readonly #root: string;
  readonly #now: () => number;
  readonly #active = new Map<string, TestTrace>();

  constructor(root: string, now: () => number = Date.now) {
    this.#root = root;
    this.#now = now;
    mkdirSync(root, { recursive: true, mode: 0o700 });
    if (lstatSync(root).isSymbolicLink()) throw new TestTraceError();
    chmodSync(root, 0o700);
    this.purgeExpired();
  }

  prepare(runId: string, activeUntil: string): RunManifest {
    const remaining = Date.parse(activeUntil) - this.#now();
    if (
      !uuid.test(runId) ||
      !Number.isFinite(remaining) ||
      remaining <= 0 ||
      remaining > maximumDurationMs
    ) {
      throw new TestTraceError();
    }
    const directory = join(this.#root, runId.toLowerCase());
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (lstatSync(directory).isSymbolicLink()) throw new TestTraceError();
    const path = join(directory, "manifest.json");
    if (existsSync(path)) {
      const stored = this.#manifest(runId);
      if (stored.activeUntil !== activeUntil) throw new TestTraceError();
      return stored;
    }
    const manifest: RunManifest = {
      runId: runId.toLowerCase(),
      activeUntil,
      expiresAt: new Date(this.#now() + retentionMs).toISOString(),
      purpose: "violet-test-trace",
      schemaVersion: 1,
    };
    writeFileSync(path, JSON.stringify(manifest), { flag: "wx", mode: 0o600 });
    return manifest;
  }

  open(runId: string, activeUntil: string, version: string): TestTrace {
    const manifest = this.prepare(runId, activeUntil);
    const existing = this.#active.get(manifest.runId);
    if (existing) {
      existing.assertActive();
      return existing;
    }
    const directory = join(this.#root, manifest.runId);
    const files = readdirSync(directory).filter((name) => name.endsWith(".ndjson"));
    if (files.length >= 4) throw new TestTraceError();
    const trace = new TestTrace(directory, manifest, version, this.#now);
    this.#active.set(manifest.runId, trace);
    return trace;
  }

  snapshot(runId: string): string {
    const manifest = this.#manifest(runId);
    if (Date.parse(manifest.expiresAt) <= this.#now()) {
      this.purgeExpired();
      throw new TestTraceError();
    }
    const directory = join(this.#root, manifest.runId);
    const files = readdirSync(directory).filter((name) => /^core-[0-9a-f-]+\.ndjson$/u.test(name));
    if (files.length > 4) throw new TestTraceError();
    let totalBytes = 0;
    return files
      .sort()
      .map((name) => {
        const path = join(directory, name);
        const stat = lstatSync(path);
        totalBytes += stat.size;
        if (!stat.isFile() || stat.size > maximumTraceBytes || totalBytes > 32 * 1024 * 1024) {
          throw new TestTraceError();
        }
        return readFileSync(path, "utf8");
      })
      .join("");
  }

  purgeExpired(): void {
    for (const name of readdirSync(this.#root)) {
      if (!uuid.test(name)) continue;
      try {
        const manifest = this.#manifest(name);
        if (Date.parse(manifest.expiresAt) <= this.#now()) {
          this.#active.delete(name);
          rmSync(join(this.#root, name), { recursive: true });
        }
      } catch {
        // Unknown files are not ours to remove.
      }
    }
  }

  #manifest(runId: string): RunManifest {
    if (!uuid.test(runId)) throw new TestTraceError();
    const directory = join(this.#root, runId.toLowerCase());
    const path = join(directory, "manifest.json");
    if (lstatSync(directory).isSymbolicLink() || !lstatSync(path).isFile())
      throw new TestTraceError();
    const value = JSON.parse(readFileSync(path, "utf8")) as RunManifest;
    if (
      value.runId !== runId.toLowerCase() ||
      value.purpose !== "violet-test-trace" ||
      value.schemaVersion !== 1 ||
      !Number.isFinite(Date.parse(value.expiresAt))
    )
      throw new TestTraceError();
    return value;
  }
}

export class TestTrace {
  readonly #file: string;
  readonly #manifest: RunManifest;
  readonly #recordingId = randomUUID();
  readonly #now: () => number;
  readonly #startedAt: number;
  #sequence = 0;
  #bytes = 0;
  #failed = false;
  readonly #failureListeners = new Set<() => void>();

  constructor(directory: string, manifest: RunManifest, version: string, now: () => number) {
    this.#file = join(directory, `core-${this.#recordingId}.ndjson`);
    this.#manifest = manifest;
    this.#now = now;
    this.#startedAt = now();
    writeFileSync(this.#file, "", { flag: "wx", mode: 0o600 });
    this.record("trace.ready", {
      version,
      activeUntil: manifest.activeUntil,
      expiresAt: manifest.expiresAt,
    });
  }

  onFailure(callback: () => void): () => void {
    this.#failureListeners.add(callback);
    if (this.#failed) callback();
    return () => this.#failureListeners.delete(callback);
  }

  assertActive(): void {
    if (this.#failed || this.#now() >= Date.parse(this.#manifest.activeUntil))
      throw new TestTraceError();
  }

  record(type: string, data: unknown, ids: Omit<TraceScope, "trace"> = {}): void {
    try {
      this.assertActive();
      const line = `${JSON.stringify({
        schemaVersion: 1,
        source: "core",
        runId: this.#manifest.runId,
        recordingId: this.#recordingId,
        sequence: ++this.#sequence,
        recordedAt: new Date(this.#now()).toISOString(),
        elapsedMs: this.#now() - this.#startedAt,
        ...ids,
        type,
        data: sanitizeTrace(data),
      })}\n`;
      this.#bytes += Buffer.byteLength(line);
      if (this.#bytes > maximumTraceBytes) throw new TestTraceError();
      const fd = openSync(
        this.#file,
        constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW,
      );
      try {
        fchmodSync(fd, 0o600);
        writeFileSync(fd, line);
      } finally {
        closeSync(fd);
      }
    } catch {
      this.#failed = true;
      for (const callback of this.#failureListeners) callback();
      // Async provider tasks may swallow errors; onFailure closes the test socket as well.
      throw new TestTraceError();
    }
  }
}

export function sanitizeTrace(value: unknown, key = "", depth = 0): unknown {
  if (depth > 20) return "[DEPTH_LIMIT]";
  if (
    /^(?:authorization|headers|api.?key|device.?token|password|secret|access.?token|reasoning_content)$/iu.test(
      key,
    )
  ) {
    return "[REDACTED]";
  }
  if (key === "history" && Array.isArray(value)) {
    return { count: value.length, content: "[PREEXISTING_HISTORY_OMITTED]" };
  }
  if (value instanceof Uint8Array) return { byteLength: value.byteLength };
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") {
    if (
      /^(?:turnId|sessionId|requestId|responseId|eventId|recordingId|runId|providerResponseId)$/u.test(
        key,
      ) &&
      uuid.test(value)
    ) {
      return value;
    }
    if (key === "audio" || key === "data" || key === "bytes") {
      return { byteLength: Buffer.byteLength(value, "base64"), content: "[BINARY_OMITTED]" };
    }
    if (value.startsWith("data:image/")) {
      const bytes = Buffer.from(value.slice(value.indexOf(",") + 1), "base64");
      return { sha256: createHash("sha256").update(bytes).digest("hex"), byteLength: bytes.length };
    }
    if (key === "url") {
      try {
        const url = new URL(value);
        return `${url.protocol}//${url.host}${url.pathname}`;
      } catch {
        return "[URL_OMITTED]";
      }
    }
    return redactTraceText(value);
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeTrace(item, "", depth + 1));
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const type = String(record["type"] ?? "");
    const partial =
      type.includes("delta") ||
      record["final"] === false ||
      type === "response.text" ||
      type === "response-text";
    return Object.fromEntries(
      Object.entries(record).map(([name, item]) => {
        if (
          (partial && ["text", "content", "delta", "stash", "arguments"].includes(name)) ||
          (type === "response.audio.delta" && name === "delta")
        ) {
          return [
            name,
            { length: typeof item === "string" ? item.length : 0, content: "[CHUNK_OMITTED]" },
          ];
        }
        return [name, sanitizeTrace(item, name, depth + 1)];
      }),
    );
  }
  return value;
}

export function redactTraceText(text: string): string {
  return text
    .replaceAll(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/gu,
      "[REDACTED_KEY]",
    )
    .replaceAll(/\b(?:sk|ak)-[A-Za-z0-9_-]{16,}\b/gu, "[REDACTED_KEY]")
    .replaceAll(
      /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu,
      "[REDACTED_JWT]",
    )
    .replaceAll(/\bBearer\s+\S+/giu, "Bearer [REDACTED]")
    .replaceAll(
      /["']?(?:password|passwd|token|secret|api[_-]?key|device[_-]?token|access[_-]?token|验证码)["']?\s*[:=：]\s*["']?[^"'\s,;}]+["']?/giu,
      "[REDACTED_SECRET]",
    )
    .replaceAll(/\b[1-9]\d{5}(?:18|19|20)\d{9}[\dXx]\b/gu, "[REDACTED_ID]")
    .replaceAll(/\b(?:\d[ -]?){13,19}\b/gu, "[REDACTED_NUMBER]");
}
