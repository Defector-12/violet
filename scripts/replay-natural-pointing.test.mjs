import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { evaluateReplay, validateFixture } from "./replay-natural-pointing.mjs";

describe("natural pointing replay", () => {
  const expected = { includes: ["EMBER"] };

  it("requires the expected answer content and a ready confidence gate", () => {
    const result = { answer: "The red triangle is labelled EMBER." };
    const ready = { answer: result.answer, confidence: 0.86, status: "ready" };

    expect(evaluateReplay(result, ready, expected).passed).toBe(true);
    expect(evaluateReplay(result, { status: "ready" }, expected).passed).toBe(true);
    expect(
      evaluateReplay(
        { answer: "The red triangle has no visible label." },
        { answer: "The red triangle has no visible label.", status: "ready" },
        expected,
      ).passed,
    ).toBe(false);
    expect(
      evaluateReplay(result, { answer: result.answer, status: "unavailable" }, expected).passed,
    ).toBe(false);
  });

  it("rejects corrupted or expired input before any model call", () => {
    const bytes = Buffer.from("image");
    const fixture = {
      schemaVersion: 1,
      question: "What is selected?",
      focusPoint: { x: 0.04, y: 0.92 },
      image: {
        data: bytes.toString("base64"),
        sha256: createHash("sha256").update(bytes).digest("hex"),
        width: 100,
        height: 100,
        mediaType: "image/jpeg",
      },
    };
    expect(validateFixture(fixture).bytes).toEqual(bytes);
    expect(validateFixture({ ...fixture, focusPoint: { x: 0, y: 0 } }).bytes).toEqual(bytes);
    expect(() =>
      validateFixture({ ...fixture, image: { ...fixture.image, data: "broken" } }),
    ).toThrow();
    expect(() => validateFixture({ ...fixture, focusPoint: { x: Number.NaN, y: 0.5 } })).toThrow();
    expect(() => validateFixture({ ...fixture, expiresAt: "2000-01-01T00:00:00Z" })).toThrow();
  });
});
