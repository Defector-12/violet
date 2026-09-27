import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";

import {
  decryptBackupToFile,
  encryptBackupToFile,
  generateBackupKeyPair,
} from "./backup-envelope.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("backup envelope", () => {
  const instanceId = "814bc7c4-bb69-4dfd-b06f-a07126292af2";

  it("authenticates the instance and epoch and refuses an older or different instance before opening output", async () => {
    const directory = await temporaryDirectory();
    const inputPath = join(directory, "backup.vltbk");
    const keys = generateBackupKeyPair();
    await encryptBackupToFile(Readable.from([Buffer.from("PGDMP clean snapshot")]), {
      outputPath: inputPath,
      publicKey: keys.publicKey,
      instanceId,
      restoreEpoch: 3,
    });
    // A nonexistent parent proves no attempt to create plaintext precedes policy checks.
    const absentOutput = join(directory, "absent", "restore.dump");
    for (const restorePolicy of [
      { instanceId, minimumRestoreEpoch: 4 },
      { instanceId: "f3a9fd1a-b66f-46a2-a1dc-8d6fecc3afef", minimumRestoreEpoch: 0 },
    ]) {
      await expect(
        decryptBackupToFile({
          inputPath,
          outputPath: absentOutput,
          privateKey: keys.privateKey,
          restorePolicy,
        }),
      ).rejects.toThrow("not permitted");
    }
    const outputPath = join(directory, "restore.dump");
    expect(
      await decryptBackupToFile({
        inputPath,
        outputPath,
        privateKey: keys.privateKey,
        restorePolicy: { instanceId, minimumRestoreEpoch: 3 },
      }),
    ).toMatchObject({ instanceId, restoreEpoch: 3, schemaVersion: 2 });
    expect(await readFile(outputPath, "utf8")).toBe("PGDMP clean snapshot");
    const bytes = await readFile(inputPath);
    const tampered = Buffer.from(
      bytes.toString("latin1").replace('"restoreEpoch":3', '"restoreEpoch":9'),
      "latin1",
    );
    await writeFile(inputPath, tampered);
    await expect(
      decryptBackupToFile({
        inputPath,
        outputPath: absentOutput,
        privateKey: keys.privateKey,
        restorePolicy: { instanceId, minimumRestoreEpoch: 4 },
      }),
    ).rejects.toThrow(/authenticate|auth/i);
  });

  it("treats legacy backups as epoch zero and rejects them after deletion", async () => {
    const directory = await temporaryDirectory();
    const inputPath = join(directory, "legacy.vltbk");
    const keys = generateBackupKeyPair();
    await encryptBackupToFile(Readable.from([Buffer.from("legacy dump")]), {
      outputPath: inputPath,
      publicKey: keys.publicKey,
    });
    await expect(
      decryptBackupToFile({
        inputPath,
        outputPath: join(directory, "absent", "restore.dump"),
        privateKey: keys.privateKey,
        restorePolicy: { instanceId, minimumRestoreEpoch: 1 },
      }),
    ).rejects.toThrow("not permitted");
  });

  it("round-trips a chunked PostgreSQL dump", async () => {
    const directory = await temporaryDirectory();
    const encryptedPath = join(directory, "backup.vltbk");
    const restoredPath = join(directory, "restored.dump");
    const keyPair = generateBackupKeyPair();
    const plaintext = Buffer.concat([
      Buffer.from("PGDMP synthetic header\n", "utf8"),
      Buffer.alloc(128 * 1024, 0xa5),
      Buffer.from("\nsynthetic trailer", "utf8"),
    ]);

    const encrypted = await encryptBackupToFile(
      Readable.from([
        plaintext.subarray(0, 17),
        plaintext.subarray(17, 65_537),
        plaintext.subarray(65_537),
      ]),
      {
        createdAt: new Date("2026-08-19T00:00:00.000Z"),
        outputPath: encryptedPath,
        publicKey: keyPair.publicKey,
      },
    );
    const restored = await decryptBackupToFile({
      inputPath: encryptedPath,
      outputPath: restoredPath,
      privateKey: keyPair.privateKey,
    });

    expect(await readFile(restoredPath)).toEqual(plaintext);
    expect(restored.plaintextSha256).toBe(encrypted.plaintextSha256);
    expect(restored.plaintextBytes).toBe(plaintext.length);
    expect(restored.publicKeyFingerprint).toBe(keyPair.publicKeyFingerprint);
  });

  it("rejects a different recovery key without leaving plaintext", async () => {
    const directory = await temporaryDirectory();
    const encryptedPath = join(directory, "backup.vltbk");
    const restoredPath = join(directory, "restored.dump");
    const recipient = generateBackupKeyPair();

    await encryptBackupToFile(Readable.from([Buffer.from("sensitive dump")]), {
      outputPath: encryptedPath,
      publicKey: recipient.publicKey,
    });

    await expect(
      decryptBackupToFile({
        inputPath: encryptedPath,
        outputPath: restoredPath,
        privateKey: generateBackupKeyPair().privateKey,
      }),
    ).rejects.toThrow("does not match");
    await expect(readFile(restoredPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects modified ciphertext without leaving plaintext", async () => {
    const directory = await temporaryDirectory();
    const encryptedPath = join(directory, "backup.vltbk");
    const restoredPath = join(directory, "restored.dump");
    const keyPair = generateBackupKeyPair();

    await encryptBackupToFile(Readable.from([Buffer.alloc(4096, 0x42)]), {
      outputPath: encryptedPath,
      publicKey: keyPair.publicKey,
    });
    const tampered = await readFile(encryptedPath);
    const headerLength = tampered.readUInt32BE(8);
    const tamperOffset = 12 + headerLength + 10;
    const original = tampered[tamperOffset];
    if (original === undefined) {
      throw new Error("test backup is too short");
    }
    tampered[tamperOffset] = original ^ 0xff;
    await writeFile(encryptedPath, tampered);

    await expect(
      decryptBackupToFile({
        inputPath: encryptedPath,
        outputPath: restoredPath,
        privateKey: keyPair.privateKey,
      }),
    ).rejects.toThrow();
    await expect(readFile(restoredPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never deletes an existing restore destination", async () => {
    const directory = await temporaryDirectory();
    const encryptedPath = join(directory, "backup.vltbk");
    const restoredPath = join(directory, "restored.dump");
    const keyPair = generateBackupKeyPair();
    await encryptBackupToFile(Readable.from([Buffer.from("valid dump")]), {
      outputPath: encryptedPath,
      publicKey: keyPair.publicKey,
    });
    await writeFile(restoredPath, "existing data");

    await expect(
      decryptBackupToFile({
        inputPath: encryptedPath,
        outputPath: restoredPath,
        privateKey: keyPair.privateKey,
      }),
    ).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(restoredPath, "utf8")).toBe("existing data");
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "violet-backup-"));
  directories.push(directory);
  return directory;
}
