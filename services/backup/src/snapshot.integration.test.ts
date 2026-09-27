import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { decryptBackupToFile, encryptBackupToFile, generateBackupKeyPair } from "@violet/backup";
import { describe, expect, it } from "vitest";
import { readSnapshotStream } from "./snapshot-stream.js";

const container = process.env["VIOLET_TEST_POSTGRES_CONTAINER"];
describe.skipIf(!container)("PostgreSQL backup snapshot", () => {
  it("binds the pre-deletion snapshot, refuses old recovery, and restores a clean new snapshot", async () => {
    const database = `backup_${randomUUID().replaceAll("-", "")}`;
    const restored = `${database}_restore`;
    const directory = await mkdtemp(join(tmpdir(), "violet-snapshot-"));
    const instanceId = randomUUID();
    const keys = generateBackupKeyPair();
    const sql = (db: string, input: string) =>
      docker(
        ["psql", "-U", "postgres", "-d", db, "-X", "-qAt", "-v", "ON_ERROR_STOP=1"],
        input,
      ).toString();
    sql("postgres", `CREATE DATABASE ${database}; CREATE DATABASE ${restored};`);
    try {
      for (const migration of [
        "0001_violet_seed.sql",
        "0002_context_checkpoints.sql",
        "0002b_context_turn_failures.sql",
        "0002c_context_event_ids.sql",
        "0003_explicit_memory.sql",
      ]) {
        sql(
          database,
          await readFile(
            new URL(`../../../infra/migrations/${migration}`, import.meta.url),
            "utf8",
          ),
        );
      }
      sql(
        database,
        `
        INSERT INTO violet_instances (id, name, constitution_version, created_at)
        VALUES ('${instanceId}', 'Violet', 'synthetic', now());
        CREATE TABLE snapshot_probe (content text);
        INSERT INTO snapshot_probe VALUES ('synthetic-deleted-content');
      `,
      );
      const production = await readFile(
        new URL("../../../scripts/backup-snapshot.sql", import.meta.url),
        "utf8",
      );
      const script = production.replaceAll(
        "--username violet --dbname violet",
        `--username postgres --dbname ${database}`,
      );
      const concurrent = `\\! psql -U postgres -d ${database} -q -v ON_ERROR_STOP=1 -c "DELETE FROM snapshot_probe; UPDATE violet_instances SET restore_epoch = 1" >/dev/null\n`;
      const before = script.replace("\\! pg_dump", `${concurrent}\\! pg_dump`);
      const capture = async (script: string, name: string) => {
        const bytes = docker(
          ["psql", "-U", "postgres", "-d", database, "-X", "-qAt", "-f", "-"],
          script,
        );
        const snapshot = await readSnapshotStream(Readable.from([bytes]));
        const path = join(directory, name);
        const metadata = await encryptBackupToFile(snapshot.dump, {
          outputPath: path,
          publicKey: keys.publicKey,
          instanceId: snapshot.instanceId,
          restoreEpoch: snapshot.restoreEpoch,
        });
        return { path, metadata };
      };
      const old = await capture(before, "old.vltbk");
      expect(old.metadata.restoreEpoch).toBe(0);
      expect(sql(database, "SELECT restore_epoch FROM violet_instances")).toBe("1\n");
      const oldDump = join(directory, "old.dump");
      await decryptBackupToFile({
        inputPath: old.path,
        outputPath: oldDump,
        privateKey: keys.privateKey,
        restorePolicy: { instanceId, minimumRestoreEpoch: 0 },
      });
      docker(
        ["pg_restore", "-U", "postgres", "-d", restored, "--exit-on-error"],
        await readFile(oldDump),
      );
      expect(
        sql(
          restored,
          "SELECT restore_epoch FROM violet_instances; SELECT content FROM snapshot_probe",
        ),
      ).toBe("0\nsynthetic-deleted-content\n");
      await expect(
        decryptBackupToFile({
          inputPath: old.path,
          outputPath: join(directory, "absent", "rejected.dump"),
          privateKey: keys.privateKey,
          restorePolicy: { instanceId, minimumRestoreEpoch: 1 },
        }),
      ).rejects.toThrow("not permitted");

      const clean = await capture(script, "clean.vltbk");
      expect(clean.metadata.restoreEpoch).toBe(1);
      const cleanDump = join(directory, "clean.dump");
      await decryptBackupToFile({
        inputPath: clean.path,
        outputPath: cleanDump,
        privateKey: keys.privateKey,
        restorePolicy: { instanceId, minimumRestoreEpoch: 1 },
      });
      sql("postgres", `DROP DATABASE ${restored}; CREATE DATABASE ${restored}`);
      docker(
        ["pg_restore", "-U", "postgres", "-d", restored, "--exit-on-error"],
        await readFile(cleanDump),
      );
      expect(
        sql(
          restored,
          "SELECT restore_epoch FROM violet_instances; SELECT count(*) FROM snapshot_probe",
        ),
      ).toBe("1\n0\n");
      const failure = script.replace(/^\\! pg_dump.*$/m, "\\! printf 'PGDMP partial'; exit 7");
      expect(() =>
        docker(["psql", "-U", "postgres", "-d", database, "-X", "-qAt", "-f", "-"], failure),
      ).toThrow("division by zero");
    } finally {
      sql("postgres", `DROP DATABASE IF EXISTS ${database}; DROP DATABASE IF EXISTS ${restored}`);
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);
});

function docker(args: readonly string[], input: string | Buffer): Buffer {
  const result = spawnSync("docker", ["exec", "-i", container ?? "", ...args], {
    input,
    maxBuffer: 16 * 1024 * 1024,
    timeout: 20_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`PostgreSQL fixture failed: ${result.stderr.toString()}`);
  return result.stdout;
}
