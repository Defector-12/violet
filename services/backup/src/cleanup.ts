import { readdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  AbortMultipartUploadCommand,
  DeleteObjectCommand,
  ListMultipartUploadsCommand,
  ListObjectVersionsCommand,
  type S3Client,
} from "@aws-sdk/client-s3";

const managedFilename = /^\d{8}T\d{6}Z-[0-9a-f-]{36}\.vltbk(?:\.tmp)?$/;

/** Called only after a newly generated backup has passed local GCM and remote GET verification. */
export async function cleanupManagedBackups(
  client: S3Client,
  options: {
    readonly bucket: string;
    readonly objectKey: string;
    readonly versionId: string;
    readonly directory: string;
    readonly localPath: string;
  },
): Promise<void> {
  const boundary = options.objectKey.lastIndexOf("/backups/");
  if (boundary < 1) throw new Error("Invalid managed backup prefix");
  const prefix = options.objectKey.slice(0, boundary + "/backups/".length);
  const managed = (key: string) =>
    key.startsWith(prefix) &&
    /^\d{4}\/\d{2}\/\d{2}\/[^/]+$/.test(key.slice(prefix.length)) &&
    managedFilename.test(basename(key));
  const keep = (key: string, versionId: string) =>
    key === options.objectKey && versionId === options.versionId;
  if (!managed(options.objectKey)) throw new Error("Invalid clean backup key");
  const versions = await listVersions(client, options.bucket, prefix);
  if (!versions.some((version) => !version.marker && keep(version.key, version.id))) {
    throw new Error("Verified clean backup version is missing");
  }
  for (const version of versions) {
    if (managed(version.key) && !keep(version.key, version.id)) {
      await client.send(
        new DeleteObjectCommand({
          Bucket: options.bucket,
          Key: version.key,
          VersionId: version.id,
        }),
      );
    }
  }
  for (const upload of await listUploads(client, options.bucket, prefix)) {
    if (managed(upload.key)) {
      await client.send(
        new AbortMultipartUploadCommand({
          Bucket: options.bucket,
          Key: upload.key,
          UploadId: upload.id,
        }),
      );
    }
  }
  const remaining = await listVersions(client, options.bucket, prefix);
  const uploads = await listUploads(client, options.bucket, prefix);
  if (
    !remaining.some((version) => !version.marker && keep(version.key, version.id)) ||
    remaining.some((version) => managed(version.key) && !keep(version.key, version.id)) ||
    uploads.some((upload) => managed(upload.key))
  )
    throw new Error("Managed remote backup cleanup is incomplete");

  for (const entry of await readdir(options.directory, { withFileTypes: true })) {
    if (
      entry.isFile() &&
      managedFilename.test(entry.name) &&
      entry.name !== basename(options.localPath)
    ) {
      await rm(join(options.directory, entry.name));
    }
  }
}

async function listVersions(client: S3Client, bucket: string, prefix: string) {
  const versions: { key: string; id: string; marker: boolean }[] = [];
  let keyMarker: string | undefined;
  let versionMarker: string | undefined;
  for (;;) {
    const page = await client.send(
      new ListObjectVersionsCommand({
        Bucket: bucket,
        Prefix: prefix,
        ...(keyMarker === undefined ? {} : { KeyMarker: keyMarker }),
        ...(versionMarker === undefined ? {} : { VersionIdMarker: versionMarker }),
      }),
    );
    for (const [entries, marker] of [
      [page.Versions, false],
      [page.DeleteMarkers, true],
    ] as const) {
      for (const entry of entries ?? []) {
        if (!entry.Key || !entry.VersionId || !entry.Key.startsWith(prefix)) {
          throw new Error("Invalid backup version listing");
        }
        versions.push({ key: entry.Key, id: entry.VersionId, marker });
      }
    }
    if (!page.IsTruncated) return versions;
    if (
      !page.NextKeyMarker ||
      (page.NextKeyMarker === keyMarker && page.NextVersionIdMarker === versionMarker)
    ) {
      throw new Error("Incomplete backup version pagination");
    }
    keyMarker = page.NextKeyMarker;
    versionMarker = page.NextVersionIdMarker;
  }
}

async function listUploads(client: S3Client, bucket: string, prefix: string) {
  const uploads: { key: string; id: string }[] = [];
  let keyMarker: string | undefined;
  let uploadMarker: string | undefined;
  for (;;) {
    const page = await client.send(
      new ListMultipartUploadsCommand({
        Bucket: bucket,
        Prefix: prefix,
        ...(keyMarker === undefined ? {} : { KeyMarker: keyMarker }),
        ...(uploadMarker === undefined ? {} : { UploadIdMarker: uploadMarker }),
      }),
    );
    for (const entry of page.Uploads ?? []) {
      if (!entry.Key || !entry.UploadId || !entry.Key.startsWith(prefix)) {
        throw new Error("Invalid backup upload listing");
      }
      uploads.push({ key: entry.Key, id: entry.UploadId });
    }
    if (!page.IsTruncated) return uploads;
    if (
      !page.NextKeyMarker ||
      (page.NextKeyMarker === keyMarker && page.NextUploadIdMarker === uploadMarker)
    ) {
      throw new Error("Incomplete backup upload pagination");
    }
    keyMarker = page.NextKeyMarker;
    uploadMarker = page.NextUploadIdMarker;
  }
}
