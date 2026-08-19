import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  type KeyObject,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { createReadStream } from "node:fs";
import { type FileHandle, open, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";

const algorithm = "aes-256-gcm";
const contentKeyLength = 32;
const gcmNonceLength = 12;
const gcmTagLength = 16;
const hashLength = 32;
const headerLengthSize = 4;
const magic = Buffer.from("VLTBKP1\n", "ascii");
const maximumHeaderLength = 16 * 1024;
const trailerMagic = Buffer.from("ENDVLT1\n", "ascii");
const trailerLength = gcmTagLength + hashLength + 8 + trailerMagic.length;
const wrappingInfo = Buffer.from("violet-backup-dek-v1", "utf8");

interface BackupHeader {
  readonly contentAlgorithm: "AES-256-GCM";
  readonly contentNonce: string;
  readonly createdAt: string;
  readonly ephemeralPublicKey: string;
  readonly keyDerivation: "X25519-HKDF-SHA256";
  readonly keyNonce: string;
  readonly keySalt: string;
  readonly keyTag: string;
  readonly keyWrapAlgorithm: "AES-256-GCM";
  readonly recipientPublicKeyFingerprint: string;
  readonly schemaVersion: 1;
  readonly sourceFormat: "postgresql-custom";
  readonly wrappedKey: string;
}

export interface BackupEncryptionResult {
  readonly createdAt: string;
  readonly encryptedBytes: number;
  readonly plaintextBytes: number;
  readonly plaintextSha256: string;
  readonly publicKeyFingerprint: string;
  readonly schemaVersion: 1;
}

export interface BackupKeyPair {
  readonly privateKey: string;
  readonly publicKey: string;
  readonly publicKeyFingerprint: string;
}

export function generateBackupKeyPair(): BackupKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("x25519");
  const publicDer = exportPublicKey(publicKey);
  return {
    privateKey: exportPrivateKey(privateKey).toString("base64"),
    publicKey: publicDer.toString("base64"),
    publicKeyFingerprint: fingerprint(publicDer),
  };
}

export async function encryptBackupToFile(
  input: AsyncIterable<Uint8Array>,
  options: {
    readonly createdAt?: Date;
    readonly outputPath: string;
    readonly publicKey: string;
  },
): Promise<BackupEncryptionResult> {
  const recipientPublicKey = importPublicKey(options.publicKey);
  const recipientPublicDer = exportPublicKey(recipientPublicKey);
  const { privateKey: ephemeralPrivateKey, publicKey: ephemeralPublicKey } =
    generateKeyPairSync("x25519");
  const sharedSecret = diffieHellman({
    privateKey: ephemeralPrivateKey,
    publicKey: recipientPublicKey,
  });
  const keySalt = randomBytes(32);
  const wrappingKey = Buffer.from(
    hkdfSync("sha256", sharedSecret, keySalt, wrappingInfo, contentKeyLength),
  );
  const dataKey = randomBytes(contentKeyLength);
  const keyNonce = randomBytes(gcmNonceLength);
  const wrapped = encryptAesGcm(dataKey, wrappingKey, keyNonce);
  const contentNonce = randomBytes(gcmNonceLength);
  const createdAt = (options.createdAt ?? new Date()).toISOString();
  const publicKeyFingerprint = fingerprint(recipientPublicDer);
  const header: BackupHeader = {
    contentAlgorithm: "AES-256-GCM",
    contentNonce: contentNonce.toString("base64"),
    createdAt,
    ephemeralPublicKey: exportPublicKey(ephemeralPublicKey).toString("base64"),
    keyDerivation: "X25519-HKDF-SHA256",
    keyNonce: keyNonce.toString("base64"),
    keySalt: keySalt.toString("base64"),
    keyTag: wrapped.tag.toString("base64"),
    keyWrapAlgorithm: "AES-256-GCM",
    recipientPublicKeyFingerprint: publicKeyFingerprint,
    schemaVersion: 1,
    sourceFormat: "postgresql-custom",
    wrappedKey: wrapped.ciphertext.toString("base64"),
  };
  const headerBytes = Buffer.from(JSON.stringify(header), "utf8");
  if (headerBytes.length > maximumHeaderLength) {
    throw new Error("backup header is too large");
  }

  let output: FileHandle | undefined;
  let position = 0;
  let plaintextBytes = 0;
  const plaintextHash = createHash("sha256");
  const contentCipher = createCipheriv(algorithm, dataKey, contentNonce);
  contentCipher.setAAD(headerBytes);

  try {
    output = await open(options.outputPath, "wx", 0o600);
    position = await writeAll(output, magic, position);
    const encodedHeaderLength = Buffer.alloc(headerLengthSize);
    encodedHeaderLength.writeUInt32BE(headerBytes.length);
    position = await writeAll(output, encodedHeaderLength, position);
    position = await writeAll(output, headerBytes, position);

    for await (const value of input) {
      const chunk = Buffer.from(value);
      plaintextHash.update(chunk);
      plaintextBytes += chunk.length;
      position = await writeAll(output, contentCipher.update(chunk), position);
    }
    position = await writeAll(output, contentCipher.final(), position);

    const digest = plaintextHash.digest();
    const trailer = Buffer.alloc(trailerLength);
    contentCipher.getAuthTag().copy(trailer, 0);
    digest.copy(trailer, gcmTagLength);
    trailer.writeBigUInt64BE(BigInt(plaintextBytes), gcmTagLength + hashLength);
    trailerMagic.copy(trailer, gcmTagLength + hashLength + 8);
    position = await writeAll(output, trailer, position);
    await output.sync();
    await output.close();
    output = undefined;

    return {
      createdAt,
      encryptedBytes: position,
      plaintextBytes,
      plaintextSha256: digest.toString("hex"),
      publicKeyFingerprint,
      schemaVersion: 1,
    };
  } catch (error) {
    await output?.close();
    await rm(options.outputPath, { force: true });
    throw error;
  } finally {
    dataKey.fill(0);
    sharedSecret.fill(0);
    wrappingKey.fill(0);
  }
}

export async function decryptBackupToFile(options: {
  readonly inputPath: string;
  readonly outputPath: string;
  readonly privateKey: string;
}): Promise<BackupEncryptionResult> {
  if (resolve(options.inputPath) === resolve(options.outputPath)) {
    throw new Error("backup input and output paths must differ");
  }

  const inputStats = await stat(options.inputPath);
  const input = await open(options.inputPath, "r");
  let output: FileHandle | undefined;
  let dataKey: Buffer | undefined;
  let sharedSecret: Buffer | undefined;
  let wrappingKey: Buffer | undefined;

  try {
    const prefix = await readExactly(input, 0, magic.length + headerLengthSize);
    if (!timingSafeEqual(prefix.subarray(0, magic.length), magic)) {
      throw new Error("backup magic is invalid");
    }
    const headerLength = prefix.readUInt32BE(magic.length);
    if (headerLength < 2 || headerLength > maximumHeaderLength) {
      throw new Error("backup header length is invalid");
    }
    const ciphertextOffset = magic.length + headerLengthSize + headerLength;
    if (inputStats.size <= ciphertextOffset + trailerLength) {
      throw new Error("backup does not contain ciphertext");
    }

    const headerBytes = await readExactly(input, magic.length + headerLengthSize, headerLength);
    const header = parseHeader(headerBytes);
    const trailerOffset = inputStats.size - trailerLength;
    const trailer = await readExactly(input, trailerOffset, trailerLength);
    if (!timingSafeEqual(trailer.subarray(gcmTagLength + hashLength + 8), trailerMagic)) {
      throw new Error("backup trailer is invalid");
    }

    const privateKey = importPrivateKey(options.privateKey);
    const recipientPublicDer = exportPublicKey(createPublicKey(privateKey));
    if (fingerprint(recipientPublicDer) !== header.recipientPublicKeyFingerprint) {
      throw new Error("backup private key does not match the recipient");
    }
    sharedSecret = diffieHellman({
      privateKey,
      publicKey: importPublicKey(header.ephemeralPublicKey),
    });
    wrappingKey = Buffer.from(
      hkdfSync(
        "sha256",
        sharedSecret,
        decodeBase64(header.keySalt, "key salt", 32),
        wrappingInfo,
        contentKeyLength,
      ),
    );
    dataKey = decryptAesGcm(
      decodeBase64(header.wrappedKey, "wrapped key", contentKeyLength),
      wrappingKey,
      decodeBase64(header.keyNonce, "key nonce", gcmNonceLength),
      decodeBase64(header.keyTag, "key tag", gcmTagLength),
    );
    const contentDecipher = createDecipheriv(
      algorithm,
      dataKey,
      decodeBase64(header.contentNonce, "content nonce", gcmNonceLength),
    );
    contentDecipher.setAAD(headerBytes);
    contentDecipher.setAuthTag(trailer.subarray(0, gcmTagLength));

    output = await open(options.outputPath, "wx", 0o600);
    let outputPosition = 0;
    let plaintextBytes = 0;
    const plaintextHash = createHash("sha256");
    const ciphertext = createReadStream(options.inputPath, {
      end: trailerOffset - 1,
      start: ciphertextOffset,
    });
    for await (const value of ciphertext) {
      const plaintext = contentDecipher.update(Buffer.from(value));
      plaintextHash.update(plaintext);
      plaintextBytes += plaintext.length;
      outputPosition = await writeAll(output, plaintext, outputPosition);
    }
    const finalPlaintext = contentDecipher.final();
    plaintextHash.update(finalPlaintext);
    plaintextBytes += finalPlaintext.length;
    await writeAll(output, finalPlaintext, outputPosition);

    const digest = plaintextHash.digest();
    const expectedDigest = trailer.subarray(gcmTagLength, gcmTagLength + hashLength);
    const expectedSize = trailer.readBigUInt64BE(gcmTagLength + hashLength);
    if (!timingSafeEqual(digest, expectedDigest) || BigInt(plaintextBytes) !== expectedSize) {
      throw new Error("backup plaintext integrity check failed");
    }
    await output.sync();
    await output.close();
    output = undefined;

    return {
      createdAt: header.createdAt,
      encryptedBytes: inputStats.size,
      plaintextBytes,
      plaintextSha256: digest.toString("hex"),
      publicKeyFingerprint: header.recipientPublicKeyFingerprint,
      schemaVersion: 1,
    };
  } catch (error) {
    await output?.close();
    await rm(options.outputPath, { force: true });
    throw error;
  } finally {
    await input.close();
    dataKey?.fill(0);
    sharedSecret?.fill(0);
    wrappingKey?.fill(0);
  }
}

function encryptAesGcm(
  plaintext: Uint8Array,
  key: Uint8Array,
  nonce: Uint8Array,
): { readonly ciphertext: Buffer; readonly tag: Buffer } {
  const cipher = createCipheriv(algorithm, key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ciphertext, tag: cipher.getAuthTag() };
}

function decryptAesGcm(
  ciphertext: Uint8Array,
  key: Uint8Array,
  nonce: Uint8Array,
  tag: Uint8Array,
): Buffer {
  const decipher = createDecipheriv(algorithm, key, nonce);
  decipher.setAuthTag(Buffer.from(tag));
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function importPublicKey(encoded: string): KeyObject {
  const key = createPublicKey({
    format: "der",
    key: decodeBase64(encoded, "public key"),
    type: "spki",
  });
  if (key.asymmetricKeyType !== "x25519") {
    throw new Error("backup public key must be X25519");
  }
  return key;
}

function importPrivateKey(encoded: string): KeyObject {
  const key = createPrivateKey({
    format: "der",
    key: decodeBase64(encoded, "private key"),
    type: "pkcs8",
  });
  if (key.asymmetricKeyType !== "x25519") {
    throw new Error("backup private key must be X25519");
  }
  return key;
}

function exportPublicKey(key: KeyObject): Buffer {
  return Buffer.from(key.export({ format: "der", type: "spki" }));
}

function exportPrivateKey(key: KeyObject): Buffer {
  return Buffer.from(key.export({ format: "der", type: "pkcs8" }));
}

function fingerprint(publicKey: Uint8Array): string {
  return createHash("sha256").update(publicKey).digest("hex");
}

function decodeBase64(value: string, label: string, expectedLength?: number): Buffer {
  if (value.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error(`${label} is not valid base64`);
  }
  const decoded = Buffer.from(value, "base64");
  if (
    decoded.toString("base64").replace(/=+$/, "") !== value.replace(/=+$/, "") ||
    (expectedLength !== undefined && decoded.length !== expectedLength)
  ) {
    throw new Error(`${label} is invalid`);
  }
  return decoded;
}

function parseHeader(value: Buffer): BackupHeader {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value.toString("utf8"));
  } catch {
    throw new Error("backup header is not valid JSON");
  }
  if (!isRecord(parsed)) {
    throw new Error("backup header must be an object");
  }
  const expectedKeys = [
    "contentAlgorithm",
    "contentNonce",
    "createdAt",
    "ephemeralPublicKey",
    "keyDerivation",
    "keyNonce",
    "keySalt",
    "keyTag",
    "keyWrapAlgorithm",
    "recipientPublicKeyFingerprint",
    "schemaVersion",
    "sourceFormat",
    "wrappedKey",
  ];
  if (
    Object.keys(parsed).length !== expectedKeys.length ||
    expectedKeys.some((key) => !(key in parsed)) ||
    parsed["schemaVersion"] !== 1 ||
    parsed["contentAlgorithm"] !== "AES-256-GCM" ||
    parsed["keyWrapAlgorithm"] !== "AES-256-GCM" ||
    parsed["keyDerivation"] !== "X25519-HKDF-SHA256" ||
    parsed["sourceFormat"] !== "postgresql-custom" ||
    !isStringFields(parsed, [
      "contentNonce",
      "createdAt",
      "ephemeralPublicKey",
      "keyNonce",
      "keySalt",
      "keyTag",
      "recipientPublicKeyFingerprint",
      "wrappedKey",
    ]) ||
    !/^[a-f0-9]{64}$/.test(String(parsed["recipientPublicKeyFingerprint"])) ||
    Number.isNaN(Date.parse(String(parsed["createdAt"])))
  ) {
    throw new Error("backup header is invalid");
  }
  return parsed as unknown as BackupHeader;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return fields.every((field) => typeof value[field] === "string");
}

async function readExactly(file: FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await file.read(buffer, offset, length - offset, position + offset);
    if (bytesRead === 0) {
      throw new Error("backup ended unexpectedly");
    }
    offset += bytesRead;
  }
  return buffer;
}

async function writeAll(file: FileHandle, buffer: Uint8Array, position: number): Promise<number> {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await file.write(
      buffer,
      offset,
      buffer.length - offset,
      position + offset,
    );
    if (bytesWritten === 0) {
      throw new Error("backup write made no progress");
    }
    offset += bytesWritten;
  }
  return position + buffer.length;
}
