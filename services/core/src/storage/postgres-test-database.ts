import type { Pool } from "pg";

/** Extensions are database-wide; temporary test schemas must never own them. */
export async function initializeTestExtensions(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('violet_test_extensions'))");
    await client.query("CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public");
    const result = await client.query<{ schema: string }>(
      "SELECT extnamespace::regnamespace::text AS schema FROM pg_extension WHERE extname = 'vector'",
    );
    if (result.rows[0]?.schema !== "public") {
      throw new Error("Test database vector extension must belong to public");
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
