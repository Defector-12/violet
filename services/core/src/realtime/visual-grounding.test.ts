import type { ResolvedContext } from "@violet/domain";
import { describe, expect, it } from "vitest";

import { formatVisualResult } from "./visual-grounding.js";

function context(input: Partial<ResolvedContext> = {}): ResolvedContext {
  return {
    eventId: "event",
    expiresAt: new Date("2026-08-31T00:05:00.000Z"),
    sessionId: "session",
    summary: "Visible answer.",
    ...input,
  };
}

describe("formatVisualResult", () => {
  it("returns a reliable visual answer without re-grounding it", () => {
    expect(
      JSON.parse(
        formatVisualResult(
          context({
            answer: "The pointed triangle is labelled EMBER.",
            confidence: 0.86,
          }),
        ),
      ),
    ).toEqual({
      answer: "The pointed triangle is labelled EMBER.",
      confidence: 0.86,
      status: "ready",
    });
  });

  it("rejects a low-confidence visual answer", () => {
    expect(
      JSON.parse(formatVisualResult(context({ answer: "Maybe EMBER.", confidence: 0.69 }))),
    ).toMatchObject({ status: "unavailable" });
  });

  it("returns exact Accessibility text without requiring a model answer", () => {
    expect(
      JSON.parse(
        formatVisualResult(
          context({
            confidence: 1,
            summary: "Selected text:\nexplicit selection",
          }),
        ),
      ),
    ).toEqual({
      confidence: 1,
      evidence: "Selected text:\nexplicit selection",
      status: "ready",
    });
  });

  it("returns a reliable image summary for manually captured context", () => {
    expect(JSON.parse(formatVisualResult(context({ confidence: 0.95 })))).toEqual({
      confidence: 0.95,
      evidence: "Visible answer.",
      status: "ready",
    });
  });
});
