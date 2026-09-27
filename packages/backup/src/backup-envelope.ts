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
import { constants } from "node:fs";
import { copyFile, type FileHandle, mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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
  readonly schemaVersion: 1 | 2;
  readonly instanceId?: string;
  readonly restoreEpoch?: number;
  readonly sourceFormat: "postgresql-custom";
  readonly wrappedKey: string;
}

export interface BackupEncryptionResult {
  readonly createdAt: string;
  readonly encryptedBytes: number;
  readonly plaintextBytes: number;
  readonly plaintextSha256: string;
  readonly publicKeyFingerprint: string;
  readonly schemaVersion: 1 | 2;
  readonly instanceId?: string;
  readonly restoreEpoch: number;
}

export interface BackupRestorePolicy {
  readonly instanceId: string;
  readonly minimumRestoreEpoch: number;
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
    readonly instanceId?: string;
    readonly restoreEpoch?: number;
  },
): Promise<BackupEncryptionResult> {
  if (options.instanceId !== undefined || options.restoreEpoch !== undefined) {
    validateEpoch(options.instanceId, options.restoreEpoch);
  }
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
    schemaVersion: options.instanceId === undefined ? 1 : 2,
    ...(options.instanceId === undefined
      ? {}
      : {
          instanceId: options.instanceId.toLowerCase(),
          restoreEpoch: options.restoreEpoch as number,
        }),
    sourceFormat: "postgresql-custom",
    wrappedKey: wrapped.ciphertext.toString("base64"),
  };
  const headerBytes = Buffer.from(JSON.stringify(header), "utf8");
  if (headerBytes.length > maximumHeaderLength) {
    throw new Error("backup header is too large");
  }

  let output: FileHandle | undefined;
  let ownsOutput = false;
  let position = 0;
  let plaintextBytes = 0;
  const plaintextHash = createHash("sha256");
  const contentCipher = createCipheriv(algorithm, dataKey, contentNonce);
  contentCipher.setAAD(headerBytes);

  try {
    output = await open(options.outputPath, "wx", 0o600);
    ownsOutput = true;
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

    // The server has only the public recovery key. Verify the complete file while the
    // one-use data key is still in memory, then discard that key in finally.
    const verification = await open(options.outputPath, "r");
    try {
      const prefix = await readExactly(verification, 0, magic.length + headerLengthSize);
      const diskHeader = await readExactly(verification, prefix.length, headerBytes.length);
      if (
        !prefix.subarray(0, magic.length).equals(magic) ||
        prefix.readUInt32BE(magic.length) !== headerBytes.length ||
        !diskHeader.equals(headerBytes)
      ) {
        throw new Error("backup header read-back verification failed");
      }
      const checked = await readContent(verification, header, headerBytes, dataKey);
      if (
        checked.plaintextSha256 !== digest.toString("hex") ||
        checked.plaintextBytes !== plaintextBytes
      ) {
        throw new Error("backup read-back verification failed");
      }
    } finally {
      await verification.close();
    }
    return {
      createdAt,
      encryptedBytes: position,
      plaintextBytes,
      plaintextSha256: digest.toString("hex"),
      publicKeyFingerprint,
      schemaVersion: header.schemaVersion,
      ...(header.instanceId === undefined ? {} : { instanceId: header.instanceId }),
      restoreEpoch: header.restoreEpoch ?? 0,
    };
  } catch (error) {
    await output?.close();
    if (ownsOutput) await rm(options.outputPath, { force: true });
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
  readonly restorePolicy?: BackupRestorePolicy;
}): Promise<BackupEncryptionResult> {
  if (resolve(options.inputPath) === resolve(options.outputPath)) {
    throw new Error("backup input and output paths must differ");
  }

  // Two passes use a private ciphertext copy so replacing/mutating the supplied file
  // cannot change what is emitted after authentication. No plaintext is staged.
  const directory = await mkdtemp(join(tmpdir(), "violet-restore-"));
  let input: FileHandle | undefined;
  let output: FileHandle | undefined;
  let ownsOutput = false;
  let dataKey: Buffer | undefined;
  let sharedSecret: Buffer | undefined;
  let wrappingKey: Buffer | undefined;

  try {
    const snapshotPath = join(directory, "ciphertext");
    await copyFile(options.inputPath, snapshotPath, constants.COPYFILE_EXCL);
    input = await open(snapshotPath, "r");
    const inputStats = await input.stat();
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
    const result = await readContent(input, header, headerBytes, dataKey);
    if (options.restorePolicy) {
      const policy = options.restorePolicy;
      validateEpoch(policy.instanceId, policy.minimumRestoreEpoch);
      if (
        (header.instanceId !== undefined &&
          header.instanceId !== policy.instanceId.toLowerCase()) ||
        result.restoreEpoch < policy.minimumRestoreEpoch
      ) {
        throw new Error("backup instance or restore epoch is not permitted");
      }
    }
    // Authentication, full integrity and the device's floor all precede output creation.
    output = await open(options.outputPath, "wx", 0o600);
    ownsOutput = true;
    await readContent(input, header, headerBytes, dataKey, output);
    await output.sync();
    await output.close();
    output = undefined;

    return result;
  } catch (error) {
    await output?.close();
    if (ownsOutput) await rm(options.outputPath, { force: true });
    throw error;
  } finally {
    await input?.close();
    await rm(directory, { recursive: true, force: true });
    dataKey?.fill(0);
    sharedSecret?.fill(0);
    wrappingKey?.fill(0);
  }
}

async function readContent(
  input: FileHandle,
  header: BackupHeader,
  headerBytes: Buffer,
  key: Buffer,
  output?: FileHandle,
): Promise<BackupEncryptionResult> {
  const size = (await input.stat()).size;
  const start = magic.length + headerLengthSize + headerBytes.length;
  const end = size - trailerLength;
  const trailer = await readExactly(input, end, trailerLength);
  if (!timingSafeEqual(trailer.subarray(gcmTagLength + hashLength + 8), trailerMagic)) {
    throw new Error("backup trailer is invalid");
  }
  const decipher = createDecipheriv(
    algorithm,
    key,
    decodeBase64(header.contentNonce, "content nonce", gcmNonceLength),
  );
  decipher.setAAD(headerBytes);
  decipher.setAuthTag(trailer.subarray(0, gcmTagLength));
  const hash = createHash("sha256");
  let plaintextBytes = 0;
  for (let position = start; position < end; ) {
    const ciphertext = await readExactly(input, position, Math.min(64 * 1024, end - position));
    position += ciphertext.length;
    const plaintext = decipher.update(ciphertext);
    hash.update(plaintext);
    if (output) await writeAll(output, plaintext, plaintextBytes);
    plaintextBytes += plaintext.length;
    plaintext.fill(0);
  }
  const final = decipher.final();
  hash.update(final);
  if (output) await writeAll(output, final, plaintextBytes);
  plaintextBytes += final.length;
  final.fill(0);
  const digest = hash.digest();
  if (
    !timingSafeEqual(digest, trailer.subarray(gcmTagLength, gcmTagLength + hashLength)) ||
    BigInt(plaintextBytes) !== trailer.readBigUInt64BE(gcmTagLength + hashLength)
  )
    throw new Error("backup plaintext integrity check failed");
  return {
    createdAt: header.createdAt,
    encryptedBytes: size,
    plaintextBytes,
    plaintextSha256: digest.toString("hex"),
    publicKeyFingerprint: header.recipientPublicKeyFingerprint,
    schemaVersion: header.schemaVersion,
    ...(header.instanceId === undefined ? {} : { instanceId: header.instanceId }),
    restoreEpoch: header.restoreEpoch ?? 0,
  };
}

function validateEpoch(instanceId: unknown, epoch: unknown): void {
  if (
    typeof instanceId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(instanceId) ||
    typeof epoch !== "number" ||
    !Number.isSafeInteger(epoch) ||
    epoch < 0
  )
    throw new Error("backup instance or restore epoch is invalid");
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
  if (parsed["schemaVersion"] === 2) {
    expectedKeys.push("instanceId", "restoreEpoch");
    validateEpoch(parsed["instanceId"], parsed["restoreEpoch"]);
  }
  if (
    Object.keys(parsed).length !== expectedKeys.length ||
    expectedKeys.some((key) => !(key in parsed)) ||
    (parsed["schemaVersion"] !== 1 && parsed["schemaVersion"] !== 2) ||
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
