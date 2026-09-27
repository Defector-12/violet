import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { encryptBackupToFile, generateBackupKeyPair } from "@violet/backup";
import { describe, expect, it, vi } from "vitest";
import { uploadExisting } from "./main.js";

const mocked = vi.hoisted(() => ({ send: vi.fn(), destroy: vi.fn(), cleanup: vi.fn() }));
vi.mock("@aws-sdk/client-s3", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@aws-sdk/client-s3")>()),
  S3Client: class {
    send = mocked.send;
    destroy = mocked.destroy;
  },
}));
vi.mock("./cleanup.js", () => ({ cleanupManagedBackups: mocked.cleanup }));

describe("verified backup upload", () => {
  it.each([false, true])(
    "requires a complete matching GET before cleanup; corrupt=%s",
    async (corrupt) => {
      const directory = await mkdtemp(join(tmpdir(), "violet-upload-"));
      const path = join(directory, `20260921T000000Z-${randomUUID()}.vltbk`);
      const keys = generateBackupKeyPair();
      const metadata = await encryptBackupToFile(Readable.from([Buffer.from("PGDMP synthetic")]), {
        outputPath: path,
        publicKey: keys.publicKey,
        instanceId: randomUUID(),
        restoreEpoch: 1,
      });
      const bytes = await readFile(path);
      const hash = createHash("sha256").update(bytes).digest("hex");
      const metadataPath = join(directory, "metadata.json");
      await writeFile(
        metadataPath,
        JSON.stringify({
          ...metadata,
          localPath: path,
          encryptedSha256: hash,
          verified: true,
        }),
      );
      const commands: string[] = [];
      mocked.cleanup.mockReset();
      mocked.destroy.mockReset();
      mocked.send.mockImplementation(async (command) => {
        commands.push(command.constructor.name);
        if (command.constructor.name === "PutObjectCommand") {
          for await (const _chunk of command.input.Body) {
            /* consume uploaded ciphertext */
          }
          return { VersionId: "clean-version" };
        }
        if (command.constructor.name === "HeadObjectCommand")
          return {
            ContentLength: bytes.length,
            ServerSideEncryption: "AES256",
            Metadata: {
              "encrypted-sha256": hash,
              "plaintext-sha256": metadata.plaintextSha256,
              "instance-id": metadata.instanceId,
              "restore-epoch": "1",
            },
          };
        if (command.constructor.name === "GetObjectCommand") {
          expect(command.input.VersionId).toBe("clean-version");
          return { Body: Readable.from([corrupt ? Buffer.from("corrupt") : bytes]) };
        }
        throw new Error("Unexpected command");
      });
      const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      try {
        const upload = uploadExisting([metadataPath, "--cleanup"], {
          VIOLET_BACKUP_OUTPUT_DIR: directory,
          TOS_BUCKET: "synthetic",
          TOS_ENDPOINT: "https://synthetic.invalid",
          TOS_REGION: "synthetic",
          TOS_ACCESS_KEY_ID: "synthetic-key",
          TOS_SECRET_ACCESS_KEY: "synthetic-secret",
        });
        if (corrupt) {
          await expect(upload).rejects.toThrow("ciphertext verification failed");
          expect(mocked.cleanup).not.toHaveBeenCalled();
        } else {
          await upload;
          expect(mocked.cleanup).toHaveBeenCalledOnce();
        }
        expect(commands).toEqual(["PutObjectCommand", "HeadObjectCommand", "GetObjectCommand"]);
        expect(mocked.destroy).toHaveBeenCalledOnce();
      } finally {
        output.mockRestore();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
