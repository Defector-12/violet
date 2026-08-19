#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { stdin, stdout } from "node:process";
import { HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import {
  type BackupEncryptionResult,
  decryptBackupToFile,
  encryptBackupToFile,
} from "@violet/backup";

const [command, ...arguments_] = process.argv.slice(2);

try {
  if (command === "encrypt-upload") {
    await encryptAndMaybeUpload(process.env);
  } else if (command === "decrypt") {
    await decrypt(arguments_, process.env);
  } else {
    throw new Error("Usage: violet-backup <encrypt-upload|decrypt> [input] [output]");
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "Backup command failed"}\n`);
  process.exitCode = 1;
}

async function encryptAndMaybeUpload(env: NodeJS.ProcessEnv): Promise<void> {
  const outputDirectory = env["VIOLET_BACKUP_OUTPUT_DIR"] ?? "/var/lib/violet/backups";
  const publicKey = await readSecret(
    env,
    "VIOLET_BACKUP_PUBLIC_KEY",
    "VIOLET_BACKUP_PUBLIC_KEY_FILE",
  );
  const createdAt = new Date();
  const filename = `${compactTimestamp(createdAt)}-${randomUUID()}.vltbk`;
  const finalPath = join(outputDirectory, filename);
  const temporaryPath = `${finalPath}.tmp`;

  await mkdir(outputDirectory, { mode: 0o700, recursive: true });
  let encrypted: BackupEncryptionResult;
  try {
    encrypted = await encryptBackupToFile(stdin, {
      createdAt,
      outputPath: temporaryPath,
      publicKey,
    });
    await rename(temporaryPath, finalPath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }

  const encryptedSha256 = await hashFile(finalPath);
  const result: Record<string, unknown> = {
    ...encrypted,
    encryptedSha256,
    localPath: finalPath,
  };
  if (env["VIOLET_BACKUP_UPLOAD"] === "true") {
    result["objectKey"] = await uploadBackup({
      encryptedSha256,
      env,
      metadata: encrypted,
      path: finalPath,
    });
    result["uploaded"] = true;
  } else {
    result["uploaded"] = false;
  }
  stdout.write(`${JSON.stringify(result)}\n`);
}

async function decrypt(arguments_: readonly string[], env: NodeJS.ProcessEnv): Promise<void> {
  const [inputPath, outputPath] = arguments_;
  if (!inputPath || !outputPath) {
    throw new Error("Usage: violet-backup decrypt <input.vltbk> <output.dump>");
  }
  const privateKey = await readSecret(
    env,
    "VIOLET_BACKUP_PRIVATE_KEY",
    "VIOLET_BACKUP_PRIVATE_KEY_FILE",
  );
  const result = await decryptBackupToFile({
    inputPath,
    outputPath,
    privateKey,
  });
  stdout.write(`${JSON.stringify({ ...result, inputPath, outputPath })}\n`);
}

async function uploadBackup(input: {
  readonly encryptedSha256: string;
  readonly env: NodeJS.ProcessEnv;
  readonly metadata: Awaited<ReturnType<typeof encryptBackupToFile>>;
  readonly path: string;
}): Promise<string> {
  const bucket = required(input.env, "TOS_BUCKET");
  const endpoint = new URL(required(input.env, "TOS_ENDPOINT"));
  if (endpoint.protocol !== "https:") {
    throw new Error("TOS_ENDPOINT must use HTTPS");
  }
  const accessKeyId = await readSecret(input.env, "TOS_ACCESS_KEY_ID", "TOS_ACCESS_KEY_ID_FILE");
  const secretAccessKey = await readSecret(
    input.env,
    "TOS_SECRET_ACCESS_KEY",
    "TOS_SECRET_ACCESS_KEY_FILE",
  );
  const objectKey = buildBackupObjectKey(
    input.env["TOS_PREFIX"] ?? "violet",
    input.metadata.createdAt,
    basename(input.path),
  );
  const fileStats = await stat(input.path);
  const client = new S3Client({
    credentials: { accessKeyId, secretAccessKey },
    endpoint: endpoint.toString(),
    forcePathStyle: parseBoolean(input.env["TOS_FORCE_PATH_STYLE"] ?? "false"),
    region: required(input.env, "TOS_REGION"),
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });

  try {
    await client.send(
      new PutObjectCommand({
        Body: createReadStream(input.path),
        Bucket: bucket,
        ContentLength: fileStats.size,
        ContentType: "application/vnd.violet.backup",
        Key: objectKey,
        Metadata: {
          "encrypted-sha256": input.encryptedSha256,
          "plaintext-sha256": input.metadata.plaintextSha256,
          "public-key-fingerprint": input.metadata.publicKeyFingerprint,
          "schema-version": String(input.metadata.schemaVersion),
        },
        ServerSideEncryption: "AES256",
      }),
    );
    const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: objectKey }));
    if (
      head.ContentLength !== fileStats.size ||
      head.Metadata?.["encrypted-sha256"] !== input.encryptedSha256 ||
      head.Metadata?.["plaintext-sha256"] !== input.metadata.plaintextSha256 ||
      head.ServerSideEncryption !== "AES256"
    ) {
      throw new Error("uploaded backup metadata verification failed");
    }
    return objectKey;
  } finally {
    client.destroy();
  }
}

export function buildBackupObjectKey(prefix: string, createdAt: string, filename: string): string {
  const normalizedPrefix = prefix.replace(/^\/+|\/+$/g, "");
  if (!/^[A-Za-z0-9][A-Za-z0-9/_-]*$/.test(normalizedPrefix) || normalizedPrefix.includes("..")) {
    throw new Error("TOS_PREFIX is invalid");
  }
  if (!/^[A-Za-z0-9._-]+\.vltbk$/.test(filename)) {
    throw new Error("backup filename is invalid");
  }
  const date = new Date(createdAt);
  if (Number.isNaN(date.valueOf())) {
    throw new Error("backup creation time is invalid");
  }
  const year = String(date.getUTCFullYear());
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${normalizedPrefix}/backups/${year}/${month}/${day}/${filename}`;
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

async function readSecret(
  env: NodeJS.ProcessEnv,
  valueName: string,
  fileName: string,
): Promise<string> {
  const direct = env[valueName]?.trim();
  if (direct) {
    return direct;
  }
  const path = required(env, fileName);
  const value = (await readFile(path, "utf8")).trim();
  if (!value) {
    throw new Error(`${fileName} is empty`);
  }
  return value;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function parseBoolean(value: string): boolean {
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new Error("TOS_FORCE_PATH_STYLE must be true or false");
}

function compactTimestamp(value: Date): string {
  return value
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}
