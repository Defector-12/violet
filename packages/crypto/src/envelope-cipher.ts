import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const algorithm = "aes-256-gcm";
const keyLength = 32;
const nonceLength = 12;

export interface EncryptedEnvelope {
  readonly algorithm: "AES-256-GCM";
  readonly ciphertext: Buffer;
  readonly contentNonce: Buffer;
  readonly contentTag: Buffer;
  readonly keyNonce: Buffer;
  readonly keyTag: Buffer;
  readonly keyVersion: string;
  readonly wrappedKey: Buffer;
}

export class EnvelopeCipher {
  readonly #keyEncryptionKey: Buffer;
  readonly #keyVersion: string;

  constructor(input: { readonly key: Uint8Array; readonly keyVersion: string }) {
    if (input.key.byteLength !== keyLength) {
      throw new Error("key encryption key must contain exactly 32 bytes");
    }
    if (input.keyVersion.trim().length === 0) {
      throw new Error("key version must not be empty");
    }
    this.#keyEncryptionKey = Buffer.from(input.key);
    this.#keyVersion = input.keyVersion;
  }

  decrypt(envelope: EncryptedEnvelope): Buffer {
    if (envelope.algorithm !== "AES-256-GCM") {
      throw new Error("unsupported envelope algorithm");
    }
    if (envelope.keyVersion !== this.#keyVersion) {
      throw new Error("key version is not loaded");
    }

    const dataKey = decryptAesGcm({
      ciphertext: envelope.wrappedKey,
      key: this.#keyEncryptionKey,
      nonce: envelope.keyNonce,
      tag: envelope.keyTag,
    });
    try {
      return decryptAesGcm({
        ciphertext: envelope.ciphertext,
        key: dataKey,
        nonce: envelope.contentNonce,
        tag: envelope.contentTag,
      });
    } finally {
      dataKey.fill(0);
    }
  }

  encrypt(plaintext: Uint8Array): EncryptedEnvelope {
    const dataKey = randomBytes(keyLength);
    const encryptedContent = encryptAesGcm(dataKey, plaintext);
    const encryptedKey = encryptAesGcm(this.#keyEncryptionKey, dataKey);
    dataKey.fill(0);

    return {
      algorithm: "AES-256-GCM",
      ciphertext: encryptedContent.ciphertext,
      contentNonce: encryptedContent.nonce,
      contentTag: encryptedContent.tag,
      keyNonce: encryptedKey.nonce,
      keyTag: encryptedKey.tag,
      keyVersion: this.#keyVersion,
      wrappedKey: encryptedKey.ciphertext,
    };
  }
}

function decryptAesGcm(input: {
  readonly ciphertext: Uint8Array;
  readonly key: Uint8Array;
  readonly nonce: Uint8Array;
  readonly tag: Uint8Array;
}): Buffer {
  const decipher = createDecipheriv(algorithm, input.key, input.nonce);
  decipher.setAuthTag(Buffer.from(input.tag));
  return Buffer.concat([decipher.update(input.ciphertext), decipher.final()]);
}

function encryptAesGcm(
  key: Uint8Array,
  plaintext: Uint8Array,
): {
  readonly ciphertext: Buffer;
  readonly nonce: Buffer;
  readonly tag: Buffer;
} {
  const nonce = randomBytes(nonceLength);
  const cipher = createCipheriv(algorithm, key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    ciphertext,
    nonce,
    tag: cipher.getAuthTag(),
  };
}
