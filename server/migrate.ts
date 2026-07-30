import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closePool, getPool } from "./db.js";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(currentDir, "../database/migrations");

// Stable, cluster-wide production migration lock. It is intentionally unrelated
// to the local test runner's TCP mutex on port 55431.
export const MIGRATION_ADVISORY_LOCK_KEY = "732202607300002";

export const runMigrations = async () => {
  const files = (await fs.readdir(migrationsDir))
    .filter((file) => file.endsWith(".sql"))
    .sort();
  const client = await getPool().connect();
  let migrationError: unknown;
  const cleanupErrors: unknown[] = [];
  let lockAcquired = false;
  try {
    await client.query("SET statement_timeout TO '120s'");
    await client.query("SET lock_timeout TO '30s'");
    await client.query(
      "SELECT pg_advisory_lock($1::bigint)",
      [MIGRATION_ADVISORY_LOCK_KEY]
    );
    lockAcquired = true;
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    for (const file of files) {
      const alreadyApplied = await client.query(
        "SELECT 1 FROM schema_migrations WHERE version = $1",
        [file]
      );
      if (alreadyApplied.rowCount) continue;
      const sql = await fs.readFile(path.join(migrationsDir, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations(version) VALUES ($1)", [file]);
        await client.query("COMMIT");
        console.log(`Applied migration ${file}`);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } catch (error) {
    migrationError = error;
  } finally {
    if (lockAcquired) {
      try {
        const unlocked = await client.query<{ unlocked: boolean }>(
          "SELECT pg_advisory_unlock($1::bigint) AS unlocked",
          [MIGRATION_ADVISORY_LOCK_KEY]
        );
        if (!unlocked.rows[0]?.unlocked) {
          cleanupErrors.push(
            new Error("Migration advisory lock was not held during cleanup")
          );
        }
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      await client.query("RESET statement_timeout");
      await client.query("RESET lock_timeout");
    } catch (error) {
      cleanupErrors.push(error);
    }
    client.release();
  }

  if (migrationError && cleanupErrors.length > 0) {
    throw new AggregateError(
      [migrationError, ...cleanupErrors],
      "Migration and migration-lock cleanup both failed"
    );
  }
  if (migrationError) throw migrationError;
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  if (cleanupErrors.length > 1) {
    throw new AggregateError(cleanupErrors, "Migration-lock cleanup failed");
  }
};

const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedFile === fileURLToPath(import.meta.url)) {
  runMigrations()
    .then(() => closePool())
    .catch(async (error) => {
      console.error(error);
      await closePool();
      process.exitCode = 1;
    });
}
