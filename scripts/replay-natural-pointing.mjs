import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function validateFixture(fixture) {
  const image = fixture?.image;
  const point = fixture?.focusPoint;
  if (
    fixture?.schemaVersion !== 1 ||
    typeof fixture.question !== "string" ||
    !fixture.question.trim() ||
    !point ||
    probability(point.x) === false ||
    probability(point.y) === false ||
    typeof image?.data !== "string" ||
    image.data.length > 11_184_812 ||
    !["image/jpeg", "image/png", "image/webp"].includes(image.mediaType) ||
    !Number.isInteger(image.width) ||
    image.width <= 0 ||
    !Number.isInteger(image.height) ||
    image.height <= 0 ||
    image.width * image.height > 64 * 1024 * 1024 ||
    (fixture.expiresAt !== undefined && !(Date.parse(fixture.expiresAt) > Date.now()))
  ) {
    throw new Error("Invalid or expired replay fixture");
  }
  const bytes = Buffer.from(image.data, "base64");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (!bytes.length || bytes.toString("base64") !== image.data || sha256 !== image.sha256) {
    throw new Error("Replay image hash or encoding mismatch");
  }
  return { bytes, sha256 };
}

export function evaluateReplay(result, gate, expected) {
  if (
    !Array.isArray(expected?.includes) ||
    expected.includes.length === 0 ||
    expected.includes.some((value) => typeof value !== "string" || !value.trim())
  ) {
    throw new Error("Expected answer fragments are required");
  }
  const answer = typeof gate?.answer === "string" ? gate.answer : result?.answer;
  const normalizedAnswer = typeof answer === "string" ? answer.toLocaleLowerCase() : "";
  const matches = expected.includes.map((value) =>
    normalizedAnswer.includes(value.trim().toLocaleLowerCase()),
  );
  return {
    matches,
    passed: gate.status === "ready" && matches.every(Boolean),
  };
}

function probability(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

async function main() {
  const [casePath, expectedPath, outputPath, repetitions = "3"] = process.argv.slice(2);
  const repeat = Number(repetitions);
  if (
    !casePath ||
    !expectedPath ||
    !outputPath ||
    !Number.isInteger(repeat) ||
    repeat < 1 ||
    repeat > 20
  ) {
    throw new Error(
      "Usage: node scripts/replay-natural-pointing.mjs case.json expected.json results.json [1..20]",
    );
  }
  const fixture = JSON.parse(await readFile(casePath, "utf8"));
  const expected = JSON.parse(await readFile(expectedPath, "utf8"));
  const { bytes, sha256 } = validateFixture(fixture);
  evaluateReplay({}, {}, expected);
  const core = resolve(process.env.VIOLET_CORE_DIST ?? "services/core/dist");
  const { DeepSeekVisionUnderstandingPort } = await import(
    pathToFileURL(`${core}/context/deepseek-vision-understanding.js`)
  );
  const { formatVisualResult } = await import(
    pathToFileURL(`${core}/realtime/visual-grounding.js`)
  );
  const keyFile = process.env.VIOLET_MODEL_API_KEY_FILE;
  if (!keyFile) {
    throw new Error("VIOLET_MODEL_API_KEY_FILE is required; no credentials belong in the fixture");
  }
  const adapter = new DeepSeekVisionUnderstandingPort({
    apiKey: (await readFile(keyFile, "utf8")).trim(),
    baseUrl: process.env.DEEPSEEK_VISION_BASE_URL ?? "https://api.deepseek.com",
    model: process.env.DEEPSEEK_VISION_MODEL ?? "deepseek-v4-flash-vision-exp",
  });
  const outcomes = [];
  // Reserve a private result file before spending model calls; never overwrite prior evidence.
  await writeFile(outputPath, "[]\n", { flag: "wx", mode: 0o600 });
  for (let iteration = 0; iteration < repeat; iteration += 1) {
    const started = Date.now();
    const requestId = randomUUID();
    try {
      const result = await adapter.understand(
        {
          payload: {
            focusPoint: fixture.focusPoint,
            image: { ...fixture.image, bytes },
            type: "screen.snapshot",
          },
          question: fixture.question,
          requestId,
        },
        AbortSignal.timeout(120_000),
      );
      const gate = JSON.parse(
        formatVisualResult({
          ...result,
          eventId: requestId,
          expiresAt: new Date(Date.now() + 60_000),
          sessionId: requestId,
        }),
      );
      const { matches, passed } = evaluateReplay(result, gate, expected);
      outcomes.push({
        iteration,
        sha256,
        elapsedMs: Date.now() - started,
        passed,
        matches,
        gate,
        result,
      });
      process.stdout.write(
        `${JSON.stringify({
          iteration,
          elapsedMs: Date.now() - started,
          passed,
          status: gate.status,
          matches,
        })}\n`,
      );
    } catch (error) {
      outcomes.push({
        iteration,
        sha256,
        elapsedMs: Date.now() - started,
        passed: false,
        error: error instanceof Error ? error.message : "unknown",
      });
      process.stdout.write(
        `${JSON.stringify({ iteration, passed: false, error: "Replay failed; see private results" })}\n`,
      );
    }
    await writeFile(outputPath, `${JSON.stringify(outcomes, null, 2)}\n`, { mode: 0o600 });
  }
  process.exitCode = outcomes.every((outcome) => outcome.passed) ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
