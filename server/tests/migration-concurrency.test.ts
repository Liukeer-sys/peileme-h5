import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import pg from "pg";
import path from "node:path";
import { describe, expect, it } from "vitest";

const { Client } = pg;

const runMigrationProcess = (
  databaseUrl: string,
  timeoutMs = 8_000
) =>
  new Promise<{ status: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(
        path.resolve("node_modules/.bin/tsx"),
        [path.resolve("server/migrate.ts")],
        {
          cwd: path.resolve("."),
          env: {
            ...process.env,
            DATABASE_URL: databaseUrl,
            NODE_ENV: "test"
          },
          stdio: ["ignore", "pipe", "pipe"]
        }
      );
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`Migration process timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once("close", (status) => {
        clearTimeout(timeout);
        resolve({ status, stdout, stderr });
      });
    }
  );

describe("migration concurrency", () => {
  it(
    "serializes two migration processes against one clean database",
    async () => {
      const baseUrl = new URL(process.env.DATABASE_URL!);
      const databaseName =
        `peileme_migration_${randomUUID().replaceAll("-", "")}`;
      const adminUrl = new URL(baseUrl);
      adminUrl.pathname = "/postgres";
      const databaseUrl = new URL(baseUrl);
      databaseUrl.pathname = `/${databaseName}`;
      const admin = new Client({ connectionString: adminUrl.toString() });
      let databaseCreated = false;
      try {
        await admin.connect();
        await admin.query(`CREATE DATABASE "${databaseName}"`);
        databaseCreated = true;

        const setup = new Client({ connectionString: databaseUrl.toString() });
        await setup.connect();
        try {
          await setup.query("CREATE EXTENSION IF NOT EXISTS pgcrypto");
          await setup.query(`
            CREATE FUNCTION slow_schema_migrations_create()
            RETURNS event_trigger
            LANGUAGE plpgsql
            AS $$
            BEGIN
              IF current_query() ~* '^\\s*CREATE TABLE IF NOT EXISTS schema_migrations' THEN
                PERFORM pg_sleep(0.3);
              END IF;
            END
            $$
          `);
          await setup.query(`
            CREATE EVENT TRIGGER slow_schema_migrations_create_trigger
            ON ddl_command_start
            EXECUTE FUNCTION slow_schema_migrations_create()
          `);
        } finally {
          await setup.end();
        }

        const [first, second] = await Promise.all([
          runMigrationProcess(databaseUrl.toString()),
          runMigrationProcess(databaseUrl.toString())
        ]);
        expect(first.status, `${first.stdout}\n${first.stderr}`).toBe(0);
        expect(second.status, `${second.stdout}\n${second.stderr}`).toBe(0);

        const verify = new Client({ connectionString: databaseUrl.toString() });
        await verify.connect();
        try {
          const migrations = await verify.query<{ version: string }>(
            "SELECT version FROM schema_migrations ORDER BY version"
          );
          expect(migrations.rows).toEqual([
            { version: "001_initial.sql" },
            { version: "002_policy_foundation.sql" }
          ]);
          const tables = await verify.query<{ count: string }>(
            `SELECT count(*)::text AS count
             FROM information_schema.tables
             WHERE table_schema = 'public'
               AND table_name = ANY($1::text[])`,
            [[
              "users",
              "policy_rule_sets",
              "policy_rule_versions",
              "administrative_regions",
              "regional_parameters",
              "announcements"
            ]]
          );
          expect(tables.rows[0].count).toBe("6");
        } finally {
          await verify.end();
        }
      } finally {
        if (databaseCreated) {
          await admin.query(
            `SELECT pg_terminate_backend(pid)
             FROM pg_stat_activity
             WHERE datname = $1 AND pid <> pg_backend_pid()`,
            [databaseName]
          );
          await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
        }
        await admin.end();
      }
    },
    15_000
  );
});
