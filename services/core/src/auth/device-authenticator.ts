import { createHash, timingSafeEqual } from "node:crypto";

export class DeviceAuthenticator {
  readonly #expectedHash: Buffer;

  constructor(expectedHashHex: string) {
    if (!/^[a-f0-9]{64}$/i.test(expectedHashHex)) {
      throw new Error("device token hash must be a SHA-256 hex digest");
    }
    this.#expectedHash = Buffer.from(expectedHashHex, "hex");
  }

  authenticate(authorization: string | undefined): boolean {
    const token = authorization?.match(/^Bearer ([^\s]+)$/)?.[1];
    if (!token) {
      return false;
    }

    const actualHash = createHash("sha256").update(token, "utf8").digest();
    return timingSafeEqual(actualHash, this.#expectedHash);
  }
}

export function hashDeviceToken(token: string): string {
  if (token.length < 32) {
    throw new Error("device token must contain at least 32 characters");
  }
  return createHash("sha256").update(token, "utf8").digest("hex");
}
