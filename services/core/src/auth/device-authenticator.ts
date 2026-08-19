import { createHash, timingSafeEqual } from "node:crypto";

export class DeviceAuthenticator {
  readonly #expectedHash: Buffer;
  readonly #expiresAt: number;
  readonly #now: () => Date;

  constructor(input: {
    readonly expectedHashHex: string;
    readonly expiresAt: Date;
    readonly now?: () => Date;
  }) {
    if (!/^[a-f0-9]{64}$/i.test(input.expectedHashHex)) {
      throw new Error("device token hash must be a SHA-256 hex digest");
    }
    if (Number.isNaN(input.expiresAt.valueOf())) {
      throw new Error("device token expiration must be a valid date");
    }
    this.#expectedHash = Buffer.from(input.expectedHashHex, "hex");
    this.#expiresAt = input.expiresAt.valueOf();
    this.#now = input.now ?? (() => new Date());
  }

  authenticate(authorization: string | undefined): boolean {
    if (this.#now().valueOf() >= this.#expiresAt) {
      return false;
    }
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
