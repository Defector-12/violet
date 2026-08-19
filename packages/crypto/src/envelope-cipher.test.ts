import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";

import { EnvelopeCipher } from "./index.js";

describe("EnvelopeCipher", () => {
  it("round-trips content without storing the plaintext key", () => {
    const cipher = new EnvelopeCipher({
      key: randomBytes(32),
      keyVersion: "content-v1",
    });
    const plaintext = Buffer.from("private conversation", "utf8");

    const envelope = cipher.encrypt(plaintext);

    expect(envelope.ciphertext.equals(plaintext)).toBe(false);
    expect(envelope.wrappedKey).toHaveLength(32);
    expect(envelope.keyTag).toHaveLength(16);
    expect(cipher.decrypt(envelope).toString("utf8")).toBe("private conversation");
  });

  it("uses a fresh data key and nonce for every encryption", () => {
    const cipher = new EnvelopeCipher({
      key: randomBytes(32),
      keyVersion: "content-v1",
    });
    const plaintext = Buffer.from("same content", "utf8");

    const first = cipher.encrypt(plaintext);
    const second = cipher.encrypt(plaintext);

    expect(first.ciphertext.equals(second.ciphertext)).toBe(false);
    expect(first.wrappedKey.equals(second.wrappedKey)).toBe(false);
  });

  it("rejects a different key version before decryption", () => {
    const source = new EnvelopeCipher({
      key: randomBytes(32),
      keyVersion: "content-v1",
    });
    const target = new EnvelopeCipher({
      key: randomBytes(32),
      keyVersion: "content-v2",
    });

    expect(() => target.decrypt(source.encrypt(Buffer.from("secret")))).toThrow(
      "key version is not loaded",
    );
  });
});
