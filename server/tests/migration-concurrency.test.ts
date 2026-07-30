import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
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
    "backfills immutable parameter provenance when upgrading from 002 to 003",
    async () => {
      const baseUrl = new URL(process.env.DATABASE_URL!);
      const databaseName =
        `peileme_upgrade_${randomUUID().replaceAll("-", "")}`;
      const adminUrl = new URL(baseUrl);
      adminUrl.pathname = "/postgres";
      const databaseUrl = new URL(baseUrl);
      databaseUrl.pathname = `/${databaseName}`;
      const legacyProvenance = {
        minimumMonthlyWage: {
          source: "database",
          parameterId: "11111111-1111-4111-8111-111111111111",
          amountFen: 240000,
          sourceName: "迁移前官方来源"
        }
      };
      const admin = new Client({ connectionString: adminUrl.toString() });
      let databaseCreated = false;
      try {
        await admin.connect();
        await admin.query(`CREATE DATABASE "${databaseName}"`);
        databaseCreated = true;

        const setup = new Client({ connectionString: databaseUrl.toString() });
        await setup.connect();
        try {
          for (const version of [
            "001_initial.sql",
            "002_policy_foundation.sql"
          ]) {
            const sql = await readFile(
              path.resolve("database/migrations", version),
              "utf8"
            );
            await setup.query(sql);
            await setup.query(
              `INSERT INTO schema_migrations(version)
               VALUES ($1)
               ON CONFLICT DO NOTHING`,
              [version]
            );
          }
          const ruleSet = await setup.query<{ id: string }>(
            `INSERT INTO policy_rule_sets(code, name, product_channel)
             VALUES ('legacy-upgrade', '升级测试', 'main')
             RETURNING id`
          );
          const version = await setup.query<{ id: string }>(
            `INSERT INTO policy_rule_versions(
               rule_set_id, version, status, definition, source_snapshot,
               effective_from, published_at
             )
             VALUES (
               $1, 1, 'published', '{}'::jsonb, '[]'::jsonb,
               DATE '2020-01-01', now()
             )
             RETURNING id`,
            [ruleSet.rows[0].id]
          );
          const assessments = await setup.query<{ id: string; marker: string }>(
            `INSERT INTO assessments(
               visitor_id, session_id, answers, product_channel,
               rule_version_id, input_snapshot, result_snapshot
             )
             VALUES
               (
                 'legacy-object', 'legacy-object',
                 jsonb_build_object(
                   'marker', 'object',
                   'parameterProvenance', $1::jsonb
                 ),
                 'main', $2, '{}'::jsonb, '{}'::jsonb
               ),
               (
                 'legacy-missing', 'legacy-missing',
                 '{"marker":"missing"}'::jsonb,
                 'main', $2, '{}'::jsonb, '{}'::jsonb
               ),
               (
                 'legacy-array', 'legacy-array',
                 '{"marker":"array","parameterProvenance":[]}'::jsonb,
                 'main', $2, '{}'::jsonb, '{}'::jsonb
               )
             RETURNING id, answers->>'marker' AS marker`,
            [JSON.stringify(legacyProvenance), version.rows[0].id]
          );
          for (const assessment of assessments.rows) {
            await setup.query(
              `INSERT INTO policy_calculation_snapshots(
                 assessment_id, rule_version_id, input, output, input_hash
               )
               VALUES ($1, $2, '{}'::jsonb, '{}'::jsonb, $3)`,
              [assessment.id, version.rows[0].id, assessment.marker]
            );
          }
        } finally {
          await setup.end();
        }

        const migrated = await runMigrationProcess(databaseUrl.toString());
        expect(migrated.status, `${migrated.stdout}\n${migrated.stderr}`).toBe(
          0
        );

        const verify = new Client({ connectionString: databaseUrl.toString() });
        await verify.connect();
        try {
          const snapshots = await verify.query<{
            input_hash: string;
            parameter_provenance: unknown;
          }>(
            `SELECT input_hash, parameter_provenance
               FROM policy_calculation_snapshots
              ORDER BY input_hash`
          );
          expect(snapshots.rows).toEqual([
            { input_hash: "array", parameter_provenance: {} },
            { input_hash: "missing", parameter_provenance: {} },
            {
              input_hash: "object",
              parameter_provenance: legacyProvenance
            }
          ]);
        } finally {
          await verify.end();
        }
      } finally {
        if (databaseCreated) {
          await admin.query(
            `SELECT pg_terminate_backend(pid)
               FROM pg_stat_activity
              WHERE datname = $1
                AND pid <> pg_backend_pid()`,
            [databaseName]
          );
          await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
        }
        await admin.end();
      }
    },
    15_000
  );

  it(
    "removes legacy document grants and enforces the controlled module set",
    async () => {
      const baseUrl = new URL(process.env.DATABASE_URL!);
      const databaseName =
        `peileme_grants_${randomUUID().replaceAll("-", "")}`;
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
          for (const version of [
            "001_initial.sql",
            "002_policy_foundation.sql",
            "003_policy_parameter_provenance.sql",
            "004_refresh_session_rotation.sql"
          ]) {
            const sql = await readFile(
              path.resolve("database/migrations", version),
              "utf8"
            );
            await setup.query(sql);
            await setup.query(
              `INSERT INTO schema_migrations(version)
               VALUES ($1)
               ON CONFLICT DO NOTHING`,
              [version]
            );
          }
          const user = await setup.query<{ id: string }>(
            `INSERT INTO users(email)
             VALUES ('legacy-grants@peileme.test')
             RETURNING id`
          );
          await setup.query(
            `INSERT INTO invite_codes(code, grants)
             VALUES
               (
                 'LEGACY-GRANTS',
                 '["documentReview","caseLawPack","unknown-module"]'::jsonb
               ),
               ('MALFORMED-GRANTS', '{"legacy":true}'::jsonb)`
          );
          await setup.query(
            `INSERT INTO access_grants(user_id, module, source)
             VALUES
               ($1, 'documentReview', 'legacy'),
               ($1, 'unknown-module', 'legacy'),
               ($1, 'evidencePack', 'legacy')`,
            [user.rows[0].id]
          );
        } finally {
          await setup.end();
        }

        const migrated = await runMigrationProcess(databaseUrl.toString());
        expect(migrated.status, `${migrated.stdout}\n${migrated.stderr}`).toBe(
          0
        );

        const verify = new Client({ connectionString: databaseUrl.toString() });
        await verify.connect();
        try {
          const invite = await verify.query<{ grants: string[] }>(
            "SELECT grants FROM invite_codes WHERE code = 'LEGACY-GRANTS'"
          );
          expect(invite.rows[0].grants).toEqual(["caseLawPack"]);
          const malformedInvite = await verify.query<{ grants: string[] }>(
            "SELECT grants FROM invite_codes WHERE code = 'MALFORMED-GRANTS'"
          );
          expect(malformedInvite.rows[0].grants).toEqual([]);

          const access = await verify.query<{ module: string }>(
            "SELECT module FROM access_grants ORDER BY module"
          );
          expect(access.rows).toEqual([{ module: "evidencePack" }]);

          const defaultInvite = await verify.query<{ grants: string[] }>(
            `INSERT INTO invite_codes(code)
             VALUES ('CONTROLLED-DEFAULT')
             RETURNING grants`
          );
          expect(defaultInvite.rows[0].grants).toEqual([
            "caseLawPack",
            "evidencePack"
          ]);

          await expect(
            verify.query(
              `UPDATE invite_codes
                  SET grants = '["documentReview"]'::jsonb
                WHERE code = 'LEGACY-GRANTS'`
            )
          ).rejects.toMatchObject({
            constraint: "invite_codes_grants_controlled"
          });
          await expect(
            verify.query(
              `INSERT INTO access_grants(user_id, module, source)
               SELECT id, 'documentReview', 'invalid'
                 FROM users
                WHERE email = 'legacy-grants@peileme.test'`
            )
          ).rejects.toMatchObject({
            constraint: "access_grants_module_controlled"
          });
        } finally {
          await verify.end();
        }
      } finally {
        if (databaseCreated) {
          await admin.query(
            `SELECT pg_terminate_backend(pid)
               FROM pg_stat_activity
              WHERE datname = $1
                AND pid <> pg_backend_pid()`,
            [databaseName]
          );
          await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
        }
        await admin.end();
      }
    },
    15_000
  );

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
            { version: "002_policy_foundation.sql" },
            { version: "003_policy_parameter_provenance.sql" },
            { version: "004_refresh_session_rotation.sql" },
            { version: "005_remove_document_review_grants.sql" },
            { version: "006_policy_result_shares.sql" }
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
