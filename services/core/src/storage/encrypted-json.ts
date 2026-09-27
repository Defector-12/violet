import type { EnvelopeCipher } from "@violet/crypto";

interface StoredEnvelope {
  readonly algorithm: "AES-256-GCM";
  readonly keyVersion: string;
  readonly ciphertext: string;
  readonly contentNonce: string;
  readonly contentTag: string;
  readonly wrappedKey: string;
  readonly keyNonce: string;
  readonly keyTag: string;
}

export function encryptJson(cipher: EnvelopeCipher, value: unknown): StoredEnvelope {
  const envelope = cipher.encrypt(Buffer.from(JSON.stringify(value), "utf8"));
  return {
    algorithm: envelope.algorithm,
    keyVersion: envelope.keyVersion,
    ciphertext: envelope.ciphertext.toString("base64"),
    contentNonce: envelope.contentNonce.toString("base64"),
    contentTag: envelope.contentTag.toString("base64"),
    wrappedKey: envelope.wrappedKey.toString("base64"),
    keyNonce: envelope.keyNonce.toString("base64"),
    keyTag: envelope.keyTag.toString("base64"),
  };
}

export function decryptJson<T>(cipher: EnvelopeCipher, envelope: StoredEnvelope): T {
  return JSON.parse(
    cipher
      .decrypt({
        algorithm: envelope.algorithm,
        keyVersion: envelope.keyVersion,
        ciphertext: Buffer.from(envelope.ciphertext, "base64"),
        contentNonce: Buffer.from(envelope.contentNonce, "base64"),
        contentTag: Buffer.from(envelope.contentTag, "base64"),
        wrappedKey: Buffer.from(envelope.wrappedKey, "base64"),
        keyNonce: Buffer.from(envelope.keyNonce, "base64"),
        keyTag: Buffer.from(envelope.keyTag, "base64"),
      })
      .toString("utf8"),
  ) as T;
}
