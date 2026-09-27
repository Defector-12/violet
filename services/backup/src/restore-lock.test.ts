import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { decryptBackupToFile, encryptBackupToFile, generateBackupKeyPair } from "@violet/backup";
import { describe, expect, it } from "vitest";
import { withRestoreLock } from "./restore-policy.js";

describe.skipIf(process.platform !== "darwin")("official restore exclusion", () => {
  it.each([1, 2, 3])(
    "serializes floor changes against authenticated restore, trial %s",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "violet-restore-lock-test-"));
      const instanceId = randomUUID();
      const keys = generateBackupKeyPair();
      const inputPath = join(directory, "backup.vltbk");
      let floor = 0;
      let entered!: () => void;
      const ready = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let resume!: () => void;
      const gate = new Promise<void>((resolve) => {
        resume = resolve;
      });
      try {
        await encryptBackupToFile(Readable.from([Buffer.from("PGDMP synthetic old snapshot")]), {
          outputPath: inputPath,
          publicKey: keys.publicKey,
          instanceId,
          restoreEpoch: 0,
        });
        const restoration = withRestoreLock(
          instanceId,
          async () => {
            const restorePolicy = { instanceId, minimumRestoreEpoch: floor };
            entered();
            await gate;
            return decryptBackupToFile({
              inputPath,
              outputPath: join(directory, "before.dump"),
              privateKey: keys.privateKey,
              restorePolicy,
            });
          },
          directory,
        );
        try {
          await ready;
          // The short-lived lockf process has already exited; its parent's fd must
          // still exclude another epoch writer for the entire restore operation.
          await expect(
            withRestoreLock(
              instanceId,
              async () => {
                floor = 1;
              },
              directory,
            ),
          ).rejects.toThrow("busy");
          expect(floor).toBe(0);
        } finally {
          resume();
          await restoration;
        }
        await withRestoreLock(
          instanceId,
          async () => {
            floor = 1;
          },
          directory,
        );
        const outputPath = join(directory, "after.dump");
        await expect(
          withRestoreLock(
            instanceId,
            () =>
              decryptBackupToFile({
                inputPath,
                outputPath,
                privateKey: keys.privateKey,
                restorePolicy: { instanceId, minimumRestoreEpoch: floor },
              }),
            directory,
          ),
        ).rejects.toThrow("not permitted");
        await expect(readFile(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
        // A rejected restore releases the same persistent inode, too.
        await expect(withRestoreLock(instanceId, async () => true, directory)).resolves.toBe(true);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
