import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PoolClient } from "pg";
import { closePool, getPool } from "./db.js";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(currentDir, "../database/migrations");

// Stable, cluster-wide production migration lock. It is intentionally unrelated
// to the local test runner's TCP mutex on port 55431.
export const MIGRATION_ADVISORY_LOCK_KEY = "732202607300002";
const MIGRATION_LOCK_WAIT_TIMEOUT_MS = 120_000;
const MIGRATION_LOCK_RETRY_MS = 50;

const NO_TRANSACTION_DIRECTIVE = "-- migrate:no-transaction";
const STATEMENT_BREAK_DIRECTIVE = "-- migrate:statement-break";

export const parseMigrationSql = (sql: string): {
  transactional: boolean;
  statements: string[];
} => {
  const lines = sql.split(/\r?\n/);
  if (lines[0] !== NO_TRANSACTION_DIRECTIVE) {
    return { transactional: true, statements: [sql] };
  }

  const statements: string[] = [];
  let current: string[] = [];
  const appendCurrent = () => {
    const statement = current.join("\n").trim();
    if (statement) statements.push(statement);
    current = [];
  };
  for (const line of lines.slice(1)) {
    if (line === STATEMENT_BREAK_DIRECTIVE) {
      appendCurrent();
    } else {
      current.push(line);
    }
  }
  appendCurrent();
  if (statements.length === 0) {
    throw new Error(
      `${NO_TRANSACTION_DIRECTIVE} requires at least one SQL statement`
    );
  }
  return { transactional: false, statements };
};

const acquireMigrationAdvisoryLock = async (
  client: PoolClient
) => {
  const deadline = Date.now() + MIGRATION_LOCK_WAIT_TIMEOUT_MS;
  while (true) {
    // A blocking advisory-lock query keeps its transaction open while waiting.
    // CREATE INDEX CONCURRENTLY can then wait on that transaction and deadlock.
    const result = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock($1::bigint) AS locked",
      [MIGRATION_ADVISORY_LOCK_KEY]
    );
    if (result.rows[0]?.locked) return;
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for the migration advisory lock");
    }
    await new Promise((resolve) =>
      setTimeout(resolve, MIGRATION_LOCK_RETRY_MS)
    );
  }
};

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
    await acquireMigrationAdvisoryLock(client);
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
      const migration = parseMigrationSql(sql);
      if (migration.transactional) {
        await client.query("BEGIN");
        try {
          await client.query(migration.statements[0]);
          await client.query(
            "INSERT INTO schema_migrations(version) VALUES ($1)",
            [file]
          );
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        }
      } else {
        for (const statement of migration.statements) {
          await client.query(statement);
        }
        await client.query("BEGIN");
        try {
          await client.query(
            "INSERT INTO schema_migrations(version) VALUES ($1)",
            [file]
          );
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        }
      }
      console.log(`Applied migration ${file}`);
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
      const message =
        error instanceof Error ? error.message : String(error);
      if (message.startsWith("PAYMENT_MIGRATION_DIAGNOSTIC ")) {
        console.error(message);
      } else {
        console.error(error);
      }
      await closePool();
      process.exitCode = 1;
    });
}
