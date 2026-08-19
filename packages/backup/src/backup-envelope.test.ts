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
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "violet-backup-"));
  directories.push(directory);
  return directory;
}
