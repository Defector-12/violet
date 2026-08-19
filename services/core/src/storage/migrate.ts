import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool } from "pg";

const databaseUrl =
  process.env["VIOLET_DATABASE_URL"] ??
  (process.env["VIOLET_DATABASE_URL_FILE"]
    ? (await readFile(process.env["VIOLET_DATABASE_URL_FILE"], "utf8")).trim()
    : undefined);
if (!databaseUrl) {
  throw new Error("VIOLET_DATABASE_URL is required");
}

const migrationsDirectory = resolve(process.env["VIOLET_MIGRATIONS_DIR"] ?? "infra/migrations");
const pool = new Pool({ connectionString: databaseUrl, max: 1 });
const client = await pool.connect();

try {
  await client.query("SELECT pg_advisory_lock(hashtext('violet_migrations'))");
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const appliedResult = await client.query<{ name: string }>(
    "SELECT name FROM schema_migrations ORDER BY name",
  );
  const applied = new Set(appliedResult.rows.map((row) => row.name));
  const files = (await readdir(migrationsDirectory)).filter((file) => file.endsWith(".sql")).sort();

  for (const file of files) {
    if (applied.has(file)) {
      continue;
    }

    const sql = await readFile(resolve(migrationsDirectory, file), "utf8");
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
      await client.query("COMMIT");
      process.stdout.write(`Applied migration ${file}\n`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
} finally {
  await client.query("SELECT pg_advisory_unlock(hashtext('violet_migrations'))");
  client.release();
  await pool.end();
}
