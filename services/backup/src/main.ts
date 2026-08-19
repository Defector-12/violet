#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { stdin, stdout } from "node:process";
import {
  AbortMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  ListObjectVersionsCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
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
  } else if (command === "verify-access") {
    await verifyTosAccess(process.env);
  } else {
    throw new Error("Usage: violet-backup <encrypt-upload|decrypt|verify-access> [input] [output]");
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
  const objectKey = buildBackupObjectKey(
    input.env["TOS_PREFIX"] ?? "violet",
    input.metadata.createdAt,
    basename(input.path),
  );
  const fileStats = await stat(input.path);
  const client = await createTosClient(input.env);

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

async function verifyTosAccess(env: NodeJS.ProcessEnv): Promise<void> {
  const bucket = required(env, "TOS_BUCKET");
  const prefix = `${(env["TOS_PREFIX"] ?? "violet").replace(/^\/+|\/+$/g, "")}/tmp/access-verification`;
  const key = `${prefix}/${randomUUID()}.txt`;
  const multipartKey = `${prefix}/${randomUUID()}.multipart`;
  const client = await createTosClient(env);
  const versionIds = new Set<string>();
  let deleteMarkerVersionId: string | undefined;
  let uploadId: string | undefined;

  try {
    await expectOutsidePrefixDenied(client, bucket);
    for (const generation of ["first", "second"]) {
      const put = await client.send(
        new PutObjectCommand({
          Body: randomUUID(),
          Bucket: bucket,
          ContentType: "text/plain",
          Key: key,
          Metadata: { generation },
          ServerSideEncryption: "AES256",
        }),
      );
      if (!put.VersionId) {
        throw new Error("TOS versioning did not return a version ID");
      }
      versionIds.add(put.VersionId);
    }

    const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    if (head.ServerSideEncryption !== "AES256" || head.Metadata?.["generation"] !== "second") {
      throw new Error("TOS object encryption or metadata verification failed");
    }
    const deleted = await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    if (!deleted.VersionId || deleted.DeleteMarker !== true) {
      throw new Error("TOS versioned delete did not create a delete marker");
    }
    deleteMarkerVersionId = deleted.VersionId;

    const listed = await client.send(
      new ListObjectVersionsCommand({ Bucket: bucket, Prefix: key }),
    );
    const listedVersionIds = new Set(
      (listed.Versions ?? [])
        .filter((version) => version.Key === key && version.VersionId)
        .map((version) => version.VersionId as string),
    );
    const listedDeleteMarker = (listed.DeleteMarkers ?? []).find(
      (marker) => marker.Key === key && marker.VersionId === deleteMarkerVersionId,
    );
    if (
      listedVersionIds.size !== versionIds.size ||
      [...versionIds].some((versionId) => !listedVersionIds.has(versionId)) ||
      !listedDeleteMarker
    ) {
      throw new Error("TOS version listing did not return all test versions");
    }

    const multipart = await client.send(
      new CreateMultipartUploadCommand({
        Bucket: bucket,
        ContentType: "application/octet-stream",
        Key: multipartKey,
        ServerSideEncryption: "AES256",
      }),
    );
    if (!multipart.UploadId) {
      throw new Error("TOS multipart upload did not return an upload ID");
    }
    uploadId = multipart.UploadId;
    const uploads = await client.send(
      new ListMultipartUploadsCommand({ Bucket: bucket, Prefix: multipartKey }),
    );
    if (
      !(uploads.Uploads ?? []).some(
        (upload) => upload.Key === multipartKey && upload.UploadId === uploadId,
      )
    ) {
      throw new Error("TOS multipart upload was not visible to the IAM user");
    }
    await client.send(
      new AbortMultipartUploadCommand({
        Bucket: bucket,
        Key: multipartKey,
        UploadId: uploadId,
      }),
    );
    uploadId = undefined;

    await deleteVersion(client, bucket, key, deleteMarkerVersionId);
    deleteMarkerVersionId = undefined;
    for (const versionId of versionIds) {
      await deleteVersion(client, bucket, key, versionId);
    }
    versionIds.clear();

    const remainingVersions = await client.send(
      new ListObjectVersionsCommand({ Bucket: bucket, Prefix: key }),
    );
    const remainingUploads = await client.send(
      new ListMultipartUploadsCommand({ Bucket: bucket, Prefix: multipartKey }),
    );
    if (
      (remainingVersions.Versions ?? []).some((version) => version.Key === key) ||
      (remainingVersions.DeleteMarkers ?? []).some((marker) => marker.Key === key) ||
      (remainingUploads.Uploads ?? []).some((upload) => upload.Key === multipartKey)
    ) {
      throw new Error("TOS access verification cleanup was incomplete");
    }

    stdout.write(
      `${JSON.stringify({
        cleanup: true,
        outsidePrefixDenied: true,
        serverSideEncryption: "AES256",
        versionsVerified: 2,
      })}\n`,
    );
  } finally {
    if (uploadId) {
      await client
        .send(
          new AbortMultipartUploadCommand({
            Bucket: bucket,
            Key: multipartKey,
            UploadId: uploadId,
          }),
        )
        .catch(() => undefined);
    }
    if (deleteMarkerVersionId) {
      await deleteVersion(client, bucket, key, deleteMarkerVersionId).catch(() => undefined);
    }
    for (const versionId of versionIds) {
      await deleteVersion(client, bucket, key, versionId).catch(() => undefined);
    }
    client.destroy();
  }
}

async function createTosClient(env: NodeJS.ProcessEnv): Promise<S3Client> {
  const endpoint = new URL(required(env, "TOS_ENDPOINT"));
  if (endpoint.protocol !== "https:") {
    throw new Error("TOS_ENDPOINT must use HTTPS");
  }
  const accessKeyId = await readSecret(env, "TOS_ACCESS_KEY_ID", "TOS_ACCESS_KEY_ID_FILE");
  const secretAccessKey = await readSecret(
    env,
    "TOS_SECRET_ACCESS_KEY",
    "TOS_SECRET_ACCESS_KEY_FILE",
  );
  return new S3Client({
    credentials: { accessKeyId, secretAccessKey },
    endpoint: endpoint.toString(),
    forcePathStyle: parseBoolean(env["TOS_FORCE_PATH_STYLE"] ?? "false"),
    region: required(env, "TOS_REGION"),
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
}

async function expectOutsidePrefixDenied(client: S3Client, bucket: string): Promise<void> {
  try {
    await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        MaxKeys: 1,
        Prefix: `violet-iam-deny-probe-${randomUUID()}/`,
      }),
    );
  } catch (error) {
    if (isAccessDenied(error)) {
      return;
    }
    throw error;
  }
  throw new Error("TOS IAM unexpectedly permits listing outside the violet prefix");
}

function isAccessDenied(error: unknown): boolean {
  if (!isRecord(error)) {
    return false;
  }
  const metadata = isRecord(error["$metadata"]) ? error["$metadata"] : undefined;
  return (
    error["name"] === "AccessDenied" ||
    error["Code"] === "AccessDenied" ||
    metadata?.["httpStatusCode"] === 403
  );
}

async function deleteVersion(
  client: S3Client,
  bucket: string,
  key: string,
  versionId: string,
): Promise<void> {
  await client.send(
    new DeleteObjectCommand({
      Bucket: bucket,
      Key: key,
      VersionId: versionId,
    }),
  );
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function compactTimestamp(value: Date): string {
  return value
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}
