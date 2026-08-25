import { describe, expect, it } from "vitest";

import { evaluateContextAccess } from "./context-access.js";

const now = new Date("2026-08-24T00:00:00.000Z");

describe("context access policy", () => {
  it("accepts a short-lived explicitly filtered context", () => {
    expect(
      evaluateContextAccess({
        capturedAt: now,
        controlledSensitiveAllowed: false,
        expiresAt: new Date(now.getTime() + 300_000),
        now,
        sensitivity: "personal",
      }),
    ).toEqual({ allowed: true });
  });

  it("rejects expired and overlong contexts", () => {
    expect(
      evaluateContextAccess({
        capturedAt: new Date(now.getTime() - 60_000),
        controlledSensitiveAllowed: false,
        expiresAt: now,
        now,
        sensitivity: "public",
      }),
    ).toMatchObject({ allowed: false, code: "CONTEXT_EXPIRED", status: 410 });
    expect(
      evaluateContextAccess({
        capturedAt: now,
        controlledSensitiveAllowed: false,
        expiresAt: new Date(now.getTime() + 300_001),
        now,
        sensitivity: "public",
      }),
    ).toMatchObject({
      allowed: false,
      code: "CONTEXT_LIFETIME_EXCEEDED",
      status: 400,
    });
  });

  it("requires explicit authorization for controlled sensitive content", () => {
    expect(
      evaluateContextAccess({
        capturedAt: now,
        controlledSensitiveAllowed: false,
        expiresAt: new Date(now.getTime() + 60_000),
        now,
        sensitivity: "controlled",
      }),
    ).toMatchObject({
      allowed: false,
      code: "CONTEXT_NOT_AUTHORIZED",
      status: 400,
    });
  });
});
