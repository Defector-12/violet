import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const allowedKeys = new Set([
  "elapsedMilliseconds",
  "recordedAt",
  "reason",
  "responseId",
  "runId",
  "schemaVersion",
  "sequence",
  "sessionId",
  "triggerId",
  "turnId",
  "type",
]);

const eventTypes = new Set([
  "capture.started",
  "capture.stopped",
  "interruption.detected",
  "playback.stopped",
  "presence.presented",
  "presence.triggered",
  "response.audio.scheduled",
  "response.audio.started",
  "response.cancelled",
  "response.completed",
  "response.started",
  "session.ended",
  "session.start.requested",
  "session.stop.requested",
  "speech.started",
  "speech.stopped",
]);

const gateDefinitions = [
  {
    end: "presence.presented",
    key: (event) => keyOf(event, "triggerId"),
    maximumP95Milliseconds: 200,
    minimumSamples: 100,
    name: "presenceTrigger",
    start: "presence.triggered",
  },
  {
    end: "response.audio.started",
    key: (event) => keyOf(event, "sessionId", "turnId"),
    maximumP95Milliseconds: 2_000,
    minimumSamples: 30,
    name: "providerSpeechStopToAudio",
    start: "speech.stopped",
  },
  {
    end: "playback.stopped",
    key: (event) => keyOf(event, "sessionId", "reason", "responseId"),
    maximumP95Milliseconds: 300,
    minimumSamples: 30,
    name: "interruption",
    start: "interruption.detected",
  },
  {
    end: "capture.stopped",
    key: (event) => keyOf(event, "sessionId", "reason"),
    maximumP95Milliseconds: 1_000,
    minimumSamples: 50,
    name: "captureStop",
    start: "session.stop.requested",
  },
];

export function parseAcceptanceLog(source) {
  return source
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0)
    .map((line, index) => validateEvent(JSON.parse(line), index + 1));
}

export function buildAcceptanceReport(events) {
  const gates = Object.fromEntries(
    gateDefinitions.map((definition) => {
      const { attempts, samples } = pairedDurations(events, definition);
      const p95Milliseconds = percentile(samples, 0.95);
      return [
        definition.name,
        {
          maximumP95Milliseconds: definition.maximumP95Milliseconds,
          minimumSamples: definition.minimumSamples,
          attemptCount: attempts,
          p50Milliseconds: percentile(samples, 0.5),
          p95Milliseconds,
          passed:
            attempts >= definition.minimumSamples &&
            samples.length === attempts &&
            p95Milliseconds !== null &&
            p95Milliseconds <= definition.maximumP95Milliseconds,
          sampleCount: samples.length,
          successRate: attempts === 0 ? null : samples.length / attempts,
          worstMilliseconds: samples.length === 0 ? null : Math.max(...samples),
        },
      ];
    }),
  );
  const latePlaybackViolations = countLatePlayback(events);
  const failedSessions = events.filter(
    (event) => event.type === "session.ended" && event.reason === "failure",
  ).length;

  return {
    allPassed:
      Object.values(gates).every((gate) => gate.passed) &&
      latePlaybackViolations === 0 &&
      failedSessions === 0,
    failedSessions,
    gates,
    latePlaybackViolations,
    schemaVersion: 1,
    totalEvents: events.length,
  };
}

function validateEvent(value, lineNumber) {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error(`Line ${lineNumber}: event must be an object`);
  }
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`Line ${lineNumber}: unexpected field ${key}`);
    }
  }
  if (value.schemaVersion !== 1) {
    throw new Error(`Line ${lineNumber}: unsupported schemaVersion`);
  }
  if (!eventTypes.has(value.type)) {
    throw new Error(`Line ${lineNumber}: unsupported event type`);
  }
  if (!Number.isInteger(value.sequence) || value.sequence < 1) {
    throw new Error(`Line ${lineNumber}: invalid sequence`);
  }
  if (!Number.isInteger(value.elapsedMilliseconds) || value.elapsedMilliseconds < 0) {
    throw new Error(`Line ${lineNumber}: invalid elapsedMilliseconds`);
  }
  if (typeof value.recordedAt !== "string" || Number.isNaN(Date.parse(value.recordedAt))) {
    throw new Error(`Line ${lineNumber}: invalid recordedAt`);
  }
  if (typeof value.runId !== "string" || value.runId.length === 0) {
    throw new Error(`Line ${lineNumber}: invalid runId`);
  }
  return value;
}

function pairedDurations(events, definition) {
  const starts = new Map();
  const durations = [];
  let attempts = 0;
  for (const event of events) {
    if (event.type === definition.start) {
      const key = definition.key(event);
      if (key !== null) {
        starts.set(key, event.elapsedMilliseconds);
        attempts += 1;
      }
      continue;
    }
    if (event.type !== definition.end) {
      continue;
    }
    const key = definition.key(event);
    const start = key === null ? undefined : starts.get(key);
    if (start === undefined || event.elapsedMilliseconds < start) {
      continue;
    }
    durations.push(event.elapsedMilliseconds - start);
    starts.delete(key);
  }
  return { attempts, samples: durations };
}

function keyOf(event, ...fields) {
  const values = [event.runId, ...fields.map((field) => event[field])];
  return values.some((value) => typeof value !== "string" || value.length === 0)
    ? null
    : values.join(":");
}

function percentile(values, fraction) {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * fraction) - 1];
}

function countLatePlayback(events) {
  const stopped = new Map();
  let violations = 0;
  for (const event of events) {
    if (event.type === "playback.stopped" && event.responseId) {
      stopped.set(`${event.runId}:${event.responseId}`, event.sequence);
      continue;
    }
    if (event.type !== "response.audio.scheduled" || !event.responseId) {
      continue;
    }
    const stoppedAt = stopped.get(`${event.runId}:${event.responseId}`);
    if (stoppedAt !== undefined && event.sequence > stoppedAt) {
      violations += 1;
    }
  }
  return violations;
}

function main() {
  const path = process.argv[2] === "--" ? process.argv[3] : process.argv[2];
  if (!path) {
    throw new Error("Usage: pnpm acceptance:report -- <acceptance-log.ndjson>");
  }
  const report = buildAcceptanceReport(parseAcceptanceLog(readFileSync(path, "utf8")));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.allPassed ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
