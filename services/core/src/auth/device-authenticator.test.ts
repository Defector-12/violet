import { describe, expect, it } from "vitest";

import { DeviceAuthenticator, hashDeviceToken } from "./device-authenticator.js";

const token = "test-device-token-that-is-at-least-32-characters";
const expiresAt = new Date("2027-01-01T00:00:00.000Z");

describe("DeviceAuthenticator", () => {
  it("accepts the configured token before expiration", () => {
    const authenticator = createAuthenticator(new Date("2026-12-31T23:59:59.999Z"));

    expect(authenticator.authenticate(`Bearer ${token}`)).toBe(true);
  });

  it("rejects a different token", () => {
    const authenticator = createAuthenticator(new Date("2026-12-31T23:59:59.999Z"));

    expect(
      authenticator.authenticate("Bearer another-device-token-that-is-at-least-32-characters"),
    ).toBe(false);
  });

  it("rejects the configured token at expiration", () => {
    const authenticator = createAuthenticator(expiresAt);

    expect(authenticator.authenticate(`Bearer ${token}`)).toBe(false);
  });
});

function createAuthenticator(now: Date): DeviceAuthenticator {
  return new DeviceAuthenticator({
    expectedHashHex: hashDeviceToken(token),
    expiresAt,
    now: () => now,
  });
}
