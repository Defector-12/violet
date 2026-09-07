import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { evaluateReplay, validateFixture } from "./replay-natural-pointing.mjs";

describe("natural pointing replay", () => {
  const bounds = { x: 0.03, y: 0.9, width: 0.4, height: 0.06 };
  const text = "  pnpm --filter @violet/core test \\\n  -- realtime-session.test.ts";
  const expected = { bounds, text };

  it("requires exact selected characters, a contained box, and a ready gate together", () => {
    const result = { target: { bounds, text } };
    expect(evaluateReplay(result, { status: "ready" }, expected).passed).toBe(true);
    expect(
      evaluateReplay({ target: { bounds, text: text.trim() } }, { status: "ready" }, expected)
        .passed,
    ).toBe(false);
    expect(
      evaluateReplay(
        { target: { bounds, text: `printf '%s\\n' '${text}'` } },
        { status: "ready" },
        expected,
      ).passed,
    ).toBe(false);
    expect(
      evaluateReplay(
        { target: { text, bounds: { ...bounds, width: 0.52 } } },
        { status: "ready" },
        expected,
      ).passed,
    ).toBe(false);
    expect(
      evaluateReplay(
        { target: { text, bounds: { x: 0.2, y: 0.92, width: 0.05, height: 0.01 } } },
        { status: "ready" },
        expected,
      ).passed,
    ).toBe(false);
    expect(evaluateReplay(result, { status: "unavailable" }, expected).passed).toBe(false);
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
    expect(() =>
      validateFixture({ ...fixture, image: { ...fixture.image, data: "broken" } }),
    ).toThrow();
    expect(() => validateFixture({ ...fixture, focusPoint: { x: Number.NaN, y: 0.5 } })).toThrow();
    expect(() => validateFixture({ ...fixture, expiresAt: "2000-01-01T00:00:00Z" })).toThrow();
  });
});
