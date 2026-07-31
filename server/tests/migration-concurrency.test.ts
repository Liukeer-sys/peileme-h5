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
    "terminalizes legacy fake attempts and recovers only the eligible real owner",
    async () => {
      const baseUrl = new URL(process.env.DATABASE_URL!);
      const databaseName =
        `peileme_payment_upgrade_${randomUUID().replaceAll("-", "")}`;
      const adminUrl = new URL(baseUrl);
      adminUrl.pathname = "/postgres";
      const databaseUrl = new URL(baseUrl);
      databaseUrl.pathname = `/${databaseName}`;
      const admin = new Client({ connectionString: adminUrl.toString() });
      let databaseCreated = false;
      const previousDatabaseUrl = process.env.DATABASE_URL;
      let closeDynamicPool: (() => Promise<void>) | undefined;
      let resetDynamicConfig: (() => void) | undefined;
      try {
        await admin.connect();
        await admin.query(`CREATE DATABASE "${databaseName}"`);
        databaseCreated = true;

        const setup = new Client({ connectionString: databaseUrl.toString() });
        await setup.connect();
        let orderId = "";
        let orderNo = "";
        let amountFen = "";
        try {
          for (const version of [
            "001_initial.sql",
            "002_policy_foundation.sql",
            "003_policy_parameter_provenance.sql",
            "004_refresh_session_rotation.sql",
            "005_remove_document_review_grants.sql",
            "006_policy_result_shares.sql",
            "007_policy_rule_regressions.sql",
            "008_commerce.sql"
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
          const legacy = await setup.query<{
            id: string;
            order_no: string;
            total_fen: string;
          }>(
            `WITH legacy_user AS (
               INSERT INTO users(email, email_verified_at)
               VALUES ('legacy-payment@peileme.test', now())
               RETURNING id
             ),
             legacy_product AS (
               INSERT INTO products(
                 sku,
                 name,
                 description,
                 product_channel,
                 fulfillment_type,
                 status,
                 entitlement_policy
               )
               VALUES (
                 'POLICY_CALC',
                 '政策计算',
                 '升级恢复测试',
                 'main',
                 'policy_calculation',
                 'active',
                 '{"grantCount":1}'::jsonb
               )
               RETURNING id
             ),
             legacy_order AS (
               INSERT INTO orders(
                 order_no,
                 user_id,
                 product_channel,
                 status,
                 total_fen,
                 currency,
                 idempotency_key,
                 expires_at,
                 closed_at,
                 created_at
               )
               SELECT
                 'PLMLEGACYUPGRADE',
                 legacy_user.id,
                 'main',
                 'CLOSED',
                 990,
                 'CNY',
                 'legacy-payment-upgrade',
                 now() - interval '1 minute',
                 now(),
                 now() - interval '10 minutes'
               FROM legacy_user
               RETURNING id, order_no, total_fen
             ),
             legacy_item AS (
               INSERT INTO order_items(
                 order_id,
                 product_id,
                 sku,
                 product_name,
                 unit_price_fen,
                 quantity,
                 entitlement_policy
               )
               SELECT
                 legacy_order.id,
                 legacy_product.id,
                 'POLICY_CALC',
                 '政策计算',
                 legacy_order.total_fen,
                 1,
                 '{"grantCount":1}'::jsonb
               FROM legacy_order, legacy_product
             ),
             old_fake_attempt AS (
               INSERT INTO payment_attempts(
                 order_id,
                 channel,
                 status,
                 created_at,
                 updated_at
               )
               SELECT
                 id,
                 'fake',
                 'CLOSED',
                 now() - interval '3 minutes',
                 now() - interval '3 minutes'
               FROM legacy_order
             ),
             latest_fake_attempt AS (
               INSERT INTO payment_attempts(
                 order_id,
                 channel,
                 status,
                 created_at,
                 updated_at
               )
               SELECT
                 id,
                 'fake',
                 'CLOSED',
                 now() - interval '2 minutes',
                 now() - interval '2 minutes'
               FROM legacy_order
             ),
             latest_alipay_attempt AS (
               INSERT INTO payment_attempts(
                 order_id,
                 channel,
                 status,
                 created_at,
                 updated_at
               )
               SELECT
                 id,
                 'alipay_wap',
                 'PENDING',
                 now() - interval '1 minute',
                 now() - interval '1 minute'
               FROM legacy_order
             )
             SELECT id, order_no, total_fen
             FROM legacy_order`
          );
          orderId = legacy.rows[0].id;
          orderNo = legacy.rows[0].order_no;
          amountFen = legacy.rows[0].total_fen;
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
          const attempts = await verify.query<{
            channel: string;
            reconciliation_state: string;
          }>(
            `SELECT channel, reconciliation_state
             FROM payment_attempts
             WHERE order_id = $1
             ORDER BY channel, created_at`,
            [orderId]
          );
          expect(attempts.rows).toEqual([
            {
              channel: "alipay_wap",
              reconciliation_state: "REQUIRED"
            },
            {
              channel: "fake",
              reconciliation_state: "TERMINAL"
            },
            {
              channel: "fake",
              reconciliation_state: "TERMINAL"
            }
          ]);
          await verify.query("BEGIN");
          await verify.query(
            "SET LOCAL peileme.payment_write_contract = 'identity_v1'"
          );
          await verify.query(
            `UPDATE payment_attempts
             SET reconciliation_next_at = now() - interval '1 second'
             WHERE order_id = $1
               AND channel = 'alipay_wap'
               AND reconciliation_state = 'REQUIRED'`,
            [orderId]
          );
          await verify.query("COMMIT");
        } finally {
          await verify.end();
        }

        process.env.DATABASE_URL = databaseUrl.toString();
        const [{ resetConfigForTests }, { closePool }, { reconcileAndCloseExpiredOrders }] =
          await Promise.all([
            import("../config.js"),
            import("../db.js"),
            import("../modules/commerce/orders.js")
          ]);
        closeDynamicPool = closePool;
        resetDynamicConfig = resetConfigForTests;
        resetConfigForTests();
        const recovered = await reconcileAndCloseExpiredOrders({
          provider: {
            channel: "alipay_wap",
            async createPayment() {
              throw new Error("upgrade probe must not create");
            },
            async queryPayment(queriedOrderNo: string) {
              return {
                providerOrderNo: queriedOrderNo,
                channel: "alipay_wap",
                channelTransactionId: `legacy-paid-${randomUUID()}`,
                amountFen,
                currency: "CNY",
                paidAt: new Date(Date.now() - 2 * 60_000).toISOString(),
                raw: { source: "legacy-upgrade-probe" }
              };
            },
            async refund() {
              return { channelRefundId: "unused", raw: {} };
            }
          },
          limit: 5,
          providerQueryBudget: 5,
          providerTimeoutMs: 100
        });
        expect(recovered.summary).toMatchObject({
          providerConfirmedPaidCount: 1,
          closedRecovery: {
            recoveredCount: 1
          }
        });
        expect(orderNo).toBe("PLMLEGACYUPGRADE");
        const recoveredState = new Client({
          connectionString: databaseUrl.toString()
        });
        await recoveredState.connect();
        try {
          const state = await recoveredState.query<{
            status: string;
            transactions: string;
            entitlements: string;
          }>(
            `SELECT
               o.status,
               (SELECT count(*)::text
                  FROM payment_transactions
                 WHERE order_id = o.id) AS transactions,
               (SELECT count(*)::text
                  FROM entitlements
                 WHERE source_id = o.id) AS entitlements
             FROM orders o
             WHERE o.id = $1`,
            [orderId]
          );
          expect(state.rows[0]).toEqual({
            status: "COMPLETED",
            transactions: "1",
            entitlements: "1"
          });
        } finally {
          await recoveredState.end();
        }
      } finally {
        if (closeDynamicPool) await closeDynamicPool();
        if (resetDynamicConfig) resetDynamicConfig();
        process.env.DATABASE_URL = previousDatabaseUrl;
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
    20_000
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
            { version: "006_policy_result_shares.sql" },
            { version: "007_policy_rule_regressions.sql" },
            { version: "008_commerce.sql" },
            { version: "009_payment_reconciliation.sql" },
            { version: "010_order_channel_lookup.sql" },
            { version: "011_real_payments.sql" }
          ]);
          const tables = await verify.query<{ count: string }>(
            `SELECT count(*)::text AS count
             FROM information_schema.tables
             WHERE table_schema = 'public'
               AND table_name = ANY($1::text[])`,
            [[
              "products",
              "product_prices",
              "promotion_rules",
              "orders",
              "order_items",
              "payment_attempts",
              "payment_anomalies",
              "payment_transactions",
              "entitlements",
              "entitlement_usages",
              "refunds",
              "reconciliation_runs",
              "invoice_requests"
            ]]
          );
          expect(tables.rows[0].count).toBe("13");
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
