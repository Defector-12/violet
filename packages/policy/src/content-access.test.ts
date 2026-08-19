import { describe, expect, it } from "vitest";

import { evaluateContentAccess } from "./index.js";

describe("evaluateContentAccess", () => {
  it("rejects unauthenticated access before considering seal state", () => {
    expect(evaluateContentAccess({ authenticated: false, sealed: true })).toEqual({
      allowed: false,
      code: "UNAUTHENTICATED",
      retryable: false,
      status: 401,
    });
  });

  it("rejects authenticated content access while sealed", () => {
    expect(evaluateContentAccess({ authenticated: true, sealed: true })).toEqual({
      allowed: false,
      code: "CORE_SEALED",
      retryable: true,
      status: 423,
    });
  });

  it("allows authenticated content access when ready", () => {
    expect(evaluateContentAccess({ authenticated: true, sealed: false })).toEqual({
      allowed: true,
    });
  });
});
