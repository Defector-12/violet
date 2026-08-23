import { describe, expect, it } from "vitest";

import { buildAcceptanceReport, parseAcceptanceLog } from "./report-realtime-acceptance.mjs";

describe("realtime acceptance report", () => {
  it("passes only after every Release 1B sample gate is satisfied", () => {
    const events = [];
    let elapsed = 0;
    let sequence = 0;
    const add = (type, fields = {}) => {
      events.push(event(++sequence, elapsed, type, fields));
    };
    const addPair = (start, end, duration, fields) => {
      add(start, fields);
      elapsed += duration;
      add(end, fields);
      elapsed += 1;
    };

    for (let index = 0; index < 100; index += 1) {
      addPair("presence.triggered", "presence.presented", 100, {
        triggerId: `trigger-${index}`,
      });
    }
    for (let index = 0; index < 30; index += 1) {
      addPair("speech.stopped", "response.audio.started", 1_500, {
        responseId: `response-${index}`,
        sessionId: `voice-session-${index}`,
        turnId: `turn-${index}`,
      });
      addPair("interruption.detected", "playback.stopped", 200, {
        reason: "local_speech",
        responseId: `response-${index}`,
        sessionId: `voice-session-${index}`,
      });
    }
    for (let index = 0; index < 50; index += 1) {
      addPair("session.stop.requested", "capture.stopped", 100, {
        reason: "popover_closed",
        sessionId: `stop-session-${index}`,
      });
    }

    const report = buildAcceptanceReport(events);

    expect(report.allPassed).toBe(true);
    expect(report.gates.presenceTrigger.attemptCount).toBe(100);
    expect(report.gates.presenceTrigger.sampleCount).toBe(100);
    expect(report.gates.presenceTrigger.successRate).toBe(1);
    expect(report.gates.providerSpeechStopToAudio.p95Milliseconds).toBe(1_500);
    expect(report.gates.interruption.p95Milliseconds).toBe(200);
    expect(report.gates.captureStop.sampleCount).toBe(50);
    expect(report.latePlaybackViolations).toBe(0);
  });

  it("fails incomplete runs and detects playback after cancellation", () => {
    const events = [
      event(1, 0, "interruption.detected", {
        reason: "local_speech",
        responseId: "response-1",
        sessionId: "session-1",
      }),
      event(2, 200, "playback.stopped", {
        reason: "local_speech",
        responseId: "response-1",
        sessionId: "session-1",
      }),
      event(3, 300, "response.audio.scheduled", {
        responseId: "response-1",
        sessionId: "session-1",
        turnId: "turn-1",
      }),
    ];

    const report = buildAcceptanceReport(events);

    expect(report.allPassed).toBe(false);
    expect(report.gates.interruption.sampleCount).toBe(1);
    expect(report.latePlaybackViolations).toBe(1);
  });

  it("rejects fields that could contain conversation content", () => {
    const unsafe = JSON.stringify({
      ...event(1, 0, "speech.started", {
        sessionId: "session-1",
        turnId: "turn-1",
      }),
      text: "must not be stored",
    });

    expect(() => parseAcceptanceLog(unsafe)).toThrow("unexpected field text");
  });
});

function event(sequence, elapsedMilliseconds, type, fields = {}) {
  return {
    elapsedMilliseconds,
    recordedAt: "2026-08-23T00:00:00.000Z",
    runId: "run-1",
    schemaVersion: 1,
    sequence,
    type,
    ...fields,
  };
}
