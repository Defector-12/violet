import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runs = join(root, ".local-acceptance/test-runs");
const purpose = "violet-test-trace";

export async function createRun(base, source, testCase, now = new Date()) {
  if (!["human", "agent", "automation"].includes(source)) throw new Error("Invalid test source");
  const runId = randomUUID();
  const directory = join(base, runId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const manifest = {
    schemaVersion: 1,
    purpose,
    runId,
    source,
    testCase: redactCommandOutput(testCase),
    createdAt: now.toISOString(),
    activeUntil: new Date(+now + 30 * 60_000).toISOString(),
    expiresAt: new Date(+now + 24 * 60 * 60_000).toISOString(),
    node: process.version,
  };
  if (base === runs) {
    manifest.commit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    manifest.diffHash = await workingTreeFingerprint(root);
  }
  await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest, null, 2), {
    flag: "wx",
    mode: 0o600,
  });
  await writeFile(
    join(directory, "REPORT.md"),
    "# Test Run\n\nPREPARED, not yet verified. No result is implied.\n",
    { flag: "wx", mode: 0o600 },
  );
  await updateIndex(base);
  return directory;
}

export async function workingTreeFingerprint(repositoryRoot = root) {
  const hash = createHash("sha256");
  hash.update("tracked\0");
  hash.update(
    execFileSync("git", ["diff", "--binary", "HEAD", "--"], {
      cwd: repositoryRoot,
      maxBuffer: 32 * 1024 * 1024,
    }),
  );
  const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  })
    .split("\0")
    .filter(Boolean)
    .sort();
  for (const path of untracked) {
    const absolutePath = join(repositoryRoot, path);
    const metadata = await lstat(absolutePath);
    hash.update(`\0untracked\0${path}\0${metadata.mode & 0o777}\0`);
    if (metadata.isSymbolicLink()) {
      hash.update(`symlink\0${await readlink(absolutePath)}`);
    } else if (metadata.isFile()) {
      hash.update("file\0");
      hash.update(await readFile(absolutePath));
    } else {
      hash.update("other");
    }
  }
  return hash.digest("hex");
}

export function parseEvents(source, filename) {
  const events = [];
  const gaps = [];
  source.split("\n").forEach((line, index) => {
    if (!line.trim()) return;
    try {
      const event = JSON.parse(line);
      if (event.schemaVersion !== 1 || typeof event.type !== "string") throw new Error("schema");
      events.push({ ...event, file: filename, line: index + 1 });
    } catch {
      gaps.push(`${filename}:${index + 1}: unreadable event; retained in the original file`);
    }
  });
  return { events, gaps };
}

const lower = (value) => (typeof value === "string" ? value.toLowerCase() : "");
const quote = (value) =>
  `\n\`\`\`\`text\n${String(value ?? "[NOT RECORDED]").replaceAll("````", "` ` ` `")}\n\`\`\`\`\n`;

export function renderReport(manifest, events, initialGaps = []) {
  const gaps = [...initialGaps];
  const mapping = new Map();
  for (const event of events) {
    const d = event.data ?? {};
    if (event.type === "qwen.response.mapping") {
      mapping.set(d.providerResponseId, lower(d.turnId));
      mapping.set(d.responseId, lower(d.turnId));
    }
    if (d.responseId && d.turnId) mapping.set(lower(d.responseId), lower(d.turnId));
  }
  const turns = new Map();
  const requests = new Map();
  for (const event of events) {
    const d = event.data ?? {};
    const turnId =
      lower(event.turnId || d.turnId) ||
      mapping.get(d.response_id) ||
      mapping.get(lower(d.responseId)) ||
      mapping.get(d.response?.id);
    if (turnId && d.type !== "input.audio") {
      const turn = turns.get(turnId) ?? { events: [], answers: new Map() };
      turn.events.push(event);
      if ((d.type === "transcript" || d.type === "input.transcript") && d.final === true)
        turn.question = d.text;
      if (d.type === "input.text") turn.question = d.text;
      if (event.type === "answer.completed") turn.answers.set(lower(d.responseId), d.text);
      turns.set(turnId, turn);
    }

    const requestId = lower(d.requestId || d.body?.requestId || event.requestId);
    const isChatEvent =
      event.type.startsWith("chat.") ||
      (event.type === "http.receive" && d.path === "/v1/chat/stream");
    if (!requestId || !isChatEvent) continue;
    const request = requests.get(requestId) ?? {
      events: [],
      answers: new Set(),
      terminalStatuses: new Set(),
    };
    request.events.push(event);
    if (event.type === "chat.send") request.question = d.message;
    if (event.type === "http.receive") request.question = d.body?.message;
    if (event.type === "chat.completed" && typeof d.text === "string") {
      request.answers.add(d.text);
    }
    if (
      ["chat.completed", "chat.incomplete", "chat.failed", "chat.cancelled"].includes(event.type)
    ) {
      request.terminalStatuses.add(event.type.slice("chat.".length));
    }
    requests.set(requestId, request);
  }
  const hasMac = events.some((event) => event.source === "mac" && event.type === "trace.ready");
  const hasCore = events.some((event) => event.source === "core" && event.type === "trace.ready");
  if (manifest.source === "human" && !hasMac) gaps.push("Mac recorder readiness is missing.");
  if (manifest.source !== "automation" && !hasCore)
    gaps.push("Core trace is missing; do not call this a complete end-to-end run.");
  for (const event of events.filter((entry) => entry.type === "capture.requested")) {
    const requestId = lower(event.data?.requestId);
    const outcomes = events.filter(
      (entry) =>
        lower(entry.data?.requestId || entry.requestId) === requestId &&
        (["tool.result", "capture.failed", "capture.rejected", "capture.cancelled"].includes(
          entry.type,
        ) ||
          entry.data?.type === "context.capture.failed"),
    );
    if (!outcomes.length) gaps.push(`capture ${requestId}: no terminal outcome recorded.`);
  }
  for (const [turnId, turn] of turns) {
    if (!turn.question) gaps.push(`turn ${turnId}: final question not recorded.`);
    if (!turn.answers.size)
      gaps.push(`turn ${turnId}: no completed answer; check cancellation or failure events.`);
  }
  for (const [requestId, request] of requests) {
    if (!request.question) gaps.push(`request ${requestId}: question not recorded.`);
    if (!request.terminalStatuses.size) {
      gaps.push(`request ${requestId}: no terminal outcome recorded.`);
    }
    if (request.terminalStatuses.has("completed") && !request.answers.size) {
      gaps.push(`request ${requestId}: completed without a final answer.`);
    }
  }
  const hasRealtimeSession = events.some((event) => {
    const d = event.data ?? {};
    return ["core.receive", "mac.send"].includes(event.type) && d.type === "session.configure";
  });
  if (hasRealtimeSession && !events.some((event) => event.type === "trace.closed")) {
    gaps.push("Realtime session closure is missing.");
  }
  if (events.some((entry) => entry.type === "core.trace.collection.failed")) {
    gaps.push("A Core collection failed; verify the server snapshot before discarding this run.");
  }
  const lines = [
    "# Test Run",
    "",
    `Run: \`${manifest.runId}\``,
    `Source: ${manifest.source}`,
    `Case: ${manifest.testCase}`,
    `Created: ${manifest.createdAt}`,
    `Recording Deadline: ${manifest.activeUntil}`,
    `Raw Evidence Expires: ${manifest.expiresAt}`,
    "",
    "## Evidence Status",
    "",
    "Recorder coverage is not a product PASS. Compare actual answers with the case's expected result.",
    ...gaps.map((gap) => `- MISSING: ${gap}`),
    ...(gaps.length === 0 ? ["- Available recorder sources were collected."] : []),
  ];
  let number = 0;
  for (const [turnId, turn] of turns) {
    lines.push(
      "",
      `## Turn ${++number}`,
      "",
      `Turn ID: \`${turnId}\``,
      "",
      "### Question",
      quote(turn.question),
    );
    lines.push(
      "### Final Answer",
      ...([...turn.answers.values()].length
        ? [...turn.answers.values()].map(quote)
        : [quote("[NO COMPLETED ANSWER RECORDED]")]),
    );
    lines.push("### Timeline", "", "| Time | Source | Event | Evidence |", "|---|---|---|---|");
    for (const event of turn.events) {
      const d = event.data ?? {};
      const status = d.reason ?? d.result?.message ?? d.result?.status ?? d.status ?? d.type ?? "";
      lines.push(
        `| ${event.recordedAt ?? ""} | ${event.source} | ${event.type} | ${String(status).replaceAll("|", "\\|").replaceAll("\n", " ")} |`,
      );
    }
    for (const event of turn.events.filter(
      (entry) =>
        [
          "capture.requested",
          "core.receive",
          "grounding.result",
          "tool.result",
          "vision.receive",
          "capture.failed",
          "capture.filtered",
        ].includes(entry.type) && entry.data?.type !== "input.audio",
    )) {
      lines.push(
        "",
        `### ${event.type}`,
        `Source: ${event.file}:${event.line}`,
        quote(JSON.stringify(event.data, null, 2)),
      );
    }
  }
  let requestNumber = 0;
  for (const [requestId, request] of requests) {
    lines.push(
      "",
      `## Chat Request ${++requestNumber}`,
      "",
      `Request ID: \`${requestId}\``,
      `Terminal Status: ${[...request.terminalStatuses].join(", ") || "[NOT RECORDED]"}`,
      "",
      "### Question",
      quote(request.question),
      "### Final Answer",
      ...([...request.answers].length
        ? [...request.answers].map(quote)
        : [quote("[NO COMPLETED ANSWER RECORDED]")]),
      "### Timeline",
      "",
      "| Time | Source | Event | Evidence |",
      "|---|---|---|---|",
    );
    for (const event of request.events) {
      const d = event.data ?? {};
      const status = d.error ?? d.status ?? d.type ?? "";
      lines.push(
        `| ${event.recordedAt ?? ""} | ${event.source} | ${event.type} | ${String(status).replaceAll("|", "\\|").replaceAll("\n", " ")} |`,
      );
    }
  }
  lines.push(
    "",
    "## Raw Files",
    "",
    ...[...new Set(events.map((event) => event.file))]
      .filter(Boolean)
      .map((file) => `- [${file}](./${file})`),
  );
  return `${lines.join("\n")}\n`;
}

export async function reportRun(directory) {
  const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
  if (manifest.purpose !== purpose) throw new Error("Not a test-run directory");
  const events = [];
  const gaps = [];
  for (const file of (await readdir(directory))
    .filter((name) => /^(?:mac-|core).*\.ndjson$/u.test(name))
    .sort()) {
    const parsed = parseEvents(await readFile(join(directory, file), "utf8"), file);
    for (const event of parsed.events) {
      if (event.runId === manifest.runId) events.push(event);
      else gaps.push(`${file}:${event.line}: run mismatch`);
    }
    gaps.push(...parsed.gaps);
  }
  events.sort(
    (a, b) => String(a.recordedAt).localeCompare(String(b.recordedAt)) || a.sequence - b.sequence,
  );
  await writeFile(join(directory, "REPORT.md"), renderReport(manifest, events, gaps), {
    mode: 0o600,
  });
  await updateIndex(dirname(directory));
  return { events: events.length, gaps, path: join(directory, "REPORT.md") };
}

async function updateIndex(base) {
  const rows = [];
  for (const entry of await readdir(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const m = JSON.parse(await readFile(join(base, entry.name, "manifest.json"), "utf8"));
      if (m.purpose === purpose) rows.push(m);
    } catch {
      /* Do not infer results from unrelated directories. */
    }
  }
  rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  await writeFile(
    join(base, "README.md"),
    [
      "# Test Runs",
      "",
      "Each run retains its own evidence; report coverage is not a PASS.",
      "",
      ...rows.map((m) => `- [${m.createdAt} ${m.source} ${m.testCase}](./${m.runId}/REPORT.md)`),
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
}

export async function runCommand(base, args) {
  if (!args.length) throw new Error("Command is required after --");
  const directory = await createRun(base, "automation", args.join(" "));
  const stdout = await open(join(directory, "stdout.log"), "wx", 0o600);
  const stderr = await open(join(directory, "stderr.log"), "wx", 0o600);
  console.log(`Test evidence: ${directory}`);
  const sanitize = redactCommandOutput;
  const child = spawn(args[0], args.slice(1), { cwd: root, stdio: ["inherit", "pipe", "pipe"] });
  let writing = Promise.resolve();
  let writeFailed = false;
  const capture = (stream, file, terminal) => {
    let pending = "";
    let total = 0;
    let insideKey = false;
    const flush = (line) => {
      if (line.includes("-----BEGIN") && line.includes("PRIVATE KEY-----")) insideKey = true;
      const safe = insideKey ? "[REDACTED_PRIVATE_KEY]\n" : sanitize(line);
      if (line.includes("-----END") && line.includes("PRIVATE KEY-----")) insideKey = false;
      writing = writing
        .then(() => file.write(safe))
        .then(() => undefined)
        .catch(() => {
          writeFailed = true;
          child.kill();
        });
      terminal.write(safe);
    };
    stream.on("data", (chunk) => {
      pending += chunk;
      total += chunk.length;
      if (total > 16 * 1024 * 1024) child.kill();
      let index = pending.indexOf("\n");
      while (index !== -1) {
        flush(pending.slice(0, index + 1));
        pending = pending.slice(index + 1);
        index = pending.indexOf("\n");
      }
    });
    stream.on("end", () => {
      if (pending) flush(pending);
    });
  };
  capture(child.stdout, stdout, process.stdout);
  capture(child.stderr, stderr, process.stderr);
  const stop = () => child.kill("SIGTERM");
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const result = await new Promise((done) => {
    child.once("error", (error) => done({ exitCode: 1, error: sanitize(error.message) }));
    child.once("close", (code, signal) => done({ exitCode: code, signal }));
  });
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
  await writing;
  await stdout.close();
  await stderr.close();
  if (writeFailed) result.recordingError = "OUTPUT_WRITE_FAILED";
  if (base === runs) {
    result.postDiffHash = await workingTreeFingerprint(root);
  }
  await writeFile(join(directory, "result.json"), JSON.stringify(result, null, 2), {
    flag: "wx",
    mode: 0o600,
  });
  await writeFile(
    join(directory, "REPORT.md"),
    [
      "# Command Test",
      "",
      `Command: \`${sanitize(args.join(" "))}\``,
      `Exit Code: ${result.exitCode ?? "none"}`,
      `Signal: ${result.signal ?? "none"}`,
      "",
      "[stdout](./stdout.log)",
      "[stderr](./stderr.log)",
      "",
      "Exit code is evidence of this command only, not an end-to-end acceptance verdict.",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  return writeFailed ? 1 : (result.exitCode ?? 1);
}

export function redactCommandOutput(value) {
  return value
    .replaceAll(/\b(?:sk|ak)-[A-Za-z0-9_-]{16,}\b/gu, "[REDACTED]")
    .replaceAll(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu, "[REDACTED]")
    .replaceAll(
      /["']?(?:password|passwd|token|secret|api[_-]?key|device[_-]?token|access[_-]?token|验证码)["']?\s*[:=：]\s*["']?[^"'\s,;}]+["']?/giu,
      "[REDACTED]",
    )
    .replaceAll(/\bBearer\s+\S+/giu, "Bearer [REDACTED]")
    .replaceAll(/https?:\/\/[^\s/@]+:[^\s/@]+@/gu, "https://[REDACTED]@");
}

export async function purgeRuns(base = runs, now = Date.now()) {
  await mkdir(base, { recursive: true, mode: 0o700 });
  for (const entry of await readdir(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = join(base, entry.name);
    let m;
    try {
      m = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
    } catch {
      continue;
    }
    if (m.purpose !== purpose || m.runId !== entry.name || !(Date.parse(m.expiresAt) <= now))
      continue;
    for (const name of await readdir(directory)) {
      if (
        /^(?:mac-.*\.ndjson|core\.ndjson|ledger\.ndjson|acceptance\.ndjson|capture-.*\.json|stdout\.log|stderr\.log|failure\.json)$/u.test(
          name,
        )
      ) {
        await rm(join(directory, name));
      }
      if (name === "server") await rm(join(directory, name), { recursive: true });
    }
    await writeFile(
      join(directory, "REPORT.md"),
      "# Test Run\n\nRaw evidence expired and was purged. Consult the acceptance document for retained conclusions.\n",
      { mode: 0o600 },
    );
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  await purgeRuns();
  if (command === "create") {
    console.log(await createRun(runs, args[0] ?? "human", args[1] ?? "manual-test"));
  } else if (command === "report") {
    console.log(JSON.stringify(await reportRun(resolve(args[0]))));
  } else if (command === "command") {
    process.exitCode = await runCommand(runs, args[0] === "--" ? args.slice(1) : args);
  } else if (command === "purge") {
    console.log("Expired raw test evidence purged.");
  } else {
    throw new Error(
      "Usage: test-run.mjs create [human|agent] [case] | report <run-dir> | command -- <cmd> | purge",
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
