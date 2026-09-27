import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AbortMultipartUploadCommand,
  DeleteObjectCommand,
  ListMultipartUploadsCommand,
  ListObjectVersionsCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import { cleanupManagedBackups } from "./cleanup.js";
import { parseRestorePolicy } from "./restore-policy.js";
import { readSnapshotStream } from "./snapshot-stream.js";

describe("backup governance", () => {
  const instanceId = "814bc7c4-bb69-4dfd-b06f-a07126292af2";
  it("reads a chunked snapshot preface and rejects a missing dump", async () => {
    const stream = async function* () {
      yield Buffer.from(`{"instanceId":"${instanceId}",`);
      yield Buffer.from('"restoreEpoch":7}\nPG');
      yield Buffer.from("DMP content");
    };
    const result = await readSnapshotStream(stream());
    expect(result).toMatchObject({ instanceId, restoreEpoch: 7 });
    const chunks = [];
    for await (const chunk of result.dump) chunks.push(chunk);
    expect(Buffer.concat(chunks).toString()).toBe("PGDMP content");
    const missing = await readSnapshotStream(
      (async function* () {
        yield Buffer.from(`{"instanceId":"${instanceId}","restoreEpoch":7}\n`);
      })(),
    );
    await expect(
      (async () => {
        for await (const _chunk of missing.dump) {
          /* consume */
        }
      })(),
    ).rejects.toThrow("dump is missing");
  });

  it("requires an instance-matching, nonnegative integer Keychain floor", () => {
    expect(
      parseRestorePolicy(
        JSON.stringify({ instanceId, minimumRestoreEpoch: 7, pendingDeletionId: instanceId }),
        instanceId,
      ),
    ).toEqual({ instanceId, minimumRestoreEpoch: 7 });
    for (const json of [
      "{}",
      "null",
      JSON.stringify({ instanceId, minimumRestoreEpoch: -1 }),
      JSON.stringify({ instanceId, minimumRestoreEpoch: "7" }),
    ]) {
      expect(() => parseRestorePolicy(json, instanceId)).toThrow();
    }
    expect(() =>
      parseRestorePolicy(JSON.stringify({ instanceId, minimumRestoreEpoch: 1 }), "bad-id"),
    ).toThrow();
  });

  it.each([false, true])(
    "cleans all pages, versions, markers and multipart uploads; failure=%s",
    async (fail) => {
      const directory = await mkdtemp(join(tmpdir(), "violet-cleanup-"));
      const oldName = `20260920T000000Z-${instanceId}.vltbk`;
      const newName = `20260921T000000Z-${instanceId}.vltbk`;
      const oldKey = `violet/backups/2026/09/20/${oldName}`;
      const objectKey = `violet/backups/2026/09/21/${newName}`;
      const versions = [
        { Key: oldKey, VersionId: "old-one", marker: false },
        { Key: oldKey, VersionId: "old-two", marker: false },
        { Key: oldKey, VersionId: "marker", marker: true },
        { Key: objectKey, VersionId: "clean", marker: false },
        { Key: "violet/backups/operator-notes.txt", VersionId: "unmanaged", marker: false },
      ];
      const uploads = [{ Key: oldKey, UploadId: "upload" }];
      const deleted: string[] = [];
      const client = {
        async send(command: unknown) {
          if (command instanceof ListObjectVersionsCommand) {
            const page = command.input.KeyMarker ? versions.slice(1) : versions.slice(0, 1);
            return {
              Versions: page.filter((entry) => !entry.marker),
              DeleteMarkers: page.filter((entry) => entry.marker),
              ...(command.input.KeyMarker ? {} : { IsTruncated: true, NextKeyMarker: "page2" }),
            };
          }
          if (command instanceof DeleteObjectCommand) {
            if (fail) throw new Error("injected TOS failure");
            const index = versions.findIndex((item) => item.VersionId === command.input.VersionId);
            deleted.push(versions[index]?.VersionId ?? "");
            versions.splice(index, 1);
            return {};
          }
          if (command instanceof ListMultipartUploadsCommand) return { Uploads: [...uploads] };
          if (command instanceof AbortMultipartUploadCommand) {
            uploads.splice(0);
            return {};
          }
          throw new Error("Unexpected command");
        },
      } as S3Client;
      try {
        for (const name of [oldName, `${oldName}.tmp`, newName, "operator-notes.txt"]) {
          await writeFile(join(directory, name), "synthetic");
        }
        const cleaning = cleanupManagedBackups(client, {
          bucket: "synthetic",
          directory,
          objectKey,
          localPath: join(directory, newName),
          versionId: "clean",
        });
        if (fail) {
          await expect(cleaning).rejects.toThrow("injected TOS");
          expect(await readdir(directory)).toContain(oldName);
        } else {
          await cleaning;
          expect(deleted.sort()).toEqual(["marker", "old-one", "old-two"]);
          expect(uploads).toHaveLength(0);
          expect((await readdir(directory)).sort()).toEqual([newName, "operator-notes.txt"].sort());
        }
      } finally {
        await rm(directory, { force: true, recursive: true });
      }
    },
  );
});
