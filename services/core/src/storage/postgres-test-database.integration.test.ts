import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { initializeTestExtensions } from "./postgres-test-database.js";

const databaseUrl = process.env["VIOLET_TEST_DATABASE_URL"];

describe.skipIf(!databaseUrl)("PostgreSQL shared test extensions", () => {
  it.each([1, 2, 3])(
    "initializes eight schemas concurrently in a fresh database, trial %i",
    async () => {
      const address = new URL(databaseUrl ?? "");
      expect(["localhost", "127.0.0.1", "[::1]"]).toContain(address.hostname);
      const name = `violet_extensions_${randomUUID().replaceAll("-", "")}`;
      const admin = new Pool({ connectionString: databaseUrl, max: 1 });
      let database: Pool | undefined;
      let created = false;
      try {
        await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
        created = true;
        address.pathname = `/${name}`;
        database = new Pool({ connectionString: address.toString(), max: 1 });
        expect(
          (await database.query("SELECT 1 FROM pg_extension WHERE extname = 'vector'")).rows,
        ).toEqual([]);
        const migration = await readFile(
          new URL("../../../../infra/migrations/0001_violet_seed.sql", import.meta.url),
          "utf8",
        );
        const results = await Promise.allSettled(
          Array.from({ length: 8 }, async (_, index) => {
            const schema = `worker_${index}`;
            const pool = new Pool({
              connectionString: address.toString(),
              max: 1,
              options: `-c search_path=${schema},public`,
            });
            try {
              await pool.query(`CREATE SCHEMA "${schema}"`);
              await initializeTestExtensions(pool);
              await pool.query(migration);
              await pool.query("SELECT * FROM conversation_events");
              await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
            } finally {
              await pool.end();
            }
          }),
        );
        expect(results).toEqual(Array(8).fill({ status: "fulfilled", value: undefined }));
        expect(
          (
            await database.query(
              "SELECT extnamespace::regnamespace::text AS schema FROM pg_extension WHERE extname = 'vector'",
            )
          ).rows,
        ).toEqual([{ schema: "public" }]);
        expect((await database.query("SELECT '[1,2]'::public.vector::text AS value")).rows).toEqual(
          [{ value: "[1,2]" }],
        );
      } finally {
        await database?.end();
        try {
          if (created) await admin.query(`DROP DATABASE "${name}"`);
        } finally {
          await admin.end();
        }
      }
    },
    20_000,
  );
});
