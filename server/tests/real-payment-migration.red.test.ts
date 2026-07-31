import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, query, withTransaction } from "../db.js";
import { runMigrations } from "../migrate.js";

const { Client } = pg;

const runMigrationProcess = (
  databaseUrl: string,
  timeoutMs = 12_000
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

const createOrderFixture = async () => {
  const marker = randomUUID().replaceAll("-", "");
  const user = await query<{ id: string }>(
    `INSERT INTO users(email)
     VALUES ($1)
     RETURNING id`,
    [`real-payment-migration-${marker}@peileme.test`]
  );
  const order = await query<{ id: string }>(
    `INSERT INTO orders(
       order_no,
       user_id,
       product_channel,
       status,
       total_fen,
       currency,
       idempotency_key,
       expires_at
     )
     VALUES ($1, $2, 'main', 'PAYING', 100, 'CNY', $3, now() + interval '30 minutes')
     RETURNING id`,
    [`PLMRED${marker.slice(0, 20).toUpperCase()}`, user.rows[0].id, marker]
  );
  return {
    userId: user.rows[0].id,
    orderId: order.rows[0].id,
    orderNo: `PLMRED${marker.slice(0, 20).toUpperCase()}`
  };
};

const cleanupOrderFixture = async (fixture: {
  userId: string;
  orderId: string;
}) => {
  await query("DELETE FROM refunds WHERE order_id = $1", [fixture.orderId]);
  await query("DELETE FROM payment_transactions WHERE order_id = $1", [
    fixture.orderId
  ]);
  await query("DELETE FROM orders WHERE id = $1", [fixture.orderId]);
  await query("DELETE FROM users WHERE id = $1", [fixture.userId]);
};

const insertAttempt = (
  orderId: string,
  channel: "wechat_h5" | "alipay_wap",
  status: string,
  providerOrderNo: string
) =>
  withTransaction(async (client) => {
    const attemptId = randomUUID();
    const providerPaymentOrderId = randomUUID();
    await client.query("SET CONSTRAINTS ALL DEFERRED");
    await client.query(
      "SET LOCAL peileme.payment_write_contract = 'identity_v1'"
    );
    await client.query(
      `INSERT INTO provider_payment_orders(
         id,
         order_id,
         channel,
         provider_order_no,
         origin,
         allocated_at,
         canonical_attempt_id,
         manual_review_required
       )
       VALUES ($1, $2, $3, $4, 'attempt_v1', now(), $5, false)`,
      [providerPaymentOrderId, orderId, channel, providerOrderNo, attemptId]
    );
    await client.query(
      `INSERT INTO payment_attempts(
         id,
         order_id,
         channel,
         status,
         provider_payment_order_id,
         provider_identity_role,
         provider_operation_eligible,
         request_snapshot
       )
       VALUES (
         $1,
         $2,
         $3,
         $4,
         $5,
         'canonical_owner',
         true,
         jsonb_build_object('providerOrderNo', $6::text, 'orderNo', $6::text)
       )`,
      [
        attemptId,
        orderId,
        channel,
        status,
        providerPaymentOrderId,
        providerOrderNo
      ]
    );
    return { id: attemptId, providerPaymentOrderId, providerOrderNo };
  });

const insertLegacyIdentityWithAlias = (
  orderId: string,
  channel: "wechat_h5" | "alipay_wap"
) =>
  withTransaction(async (client) => {
    const ownerId = randomUUID();
    const aliasId = randomUUID();
    const identityId = randomUUID();
    const providerOrderNo =
      `LG${randomUUID().replaceAll("-", "").slice(0, 28).toUpperCase()}`;
    await client.query("SET CONSTRAINTS ALL DEFERRED");
    await client.query(
      "SET LOCAL peileme.payment_write_contract = 'identity_v1'"
    );
    await client.query(
      `INSERT INTO provider_payment_orders(
         id,
         order_id,
         channel,
         provider_order_no,
         origin,
         allocated_at,
         canonical_attempt_id,
         manual_review_required
       )
       VALUES ($1, $2, $3, $4, 'legacy_order_no', now(), $5, false)`,
      [
        identityId,
        orderId,
        channel,
        providerOrderNo,
        ownerId
      ]
    );
    await client.query(
      `INSERT INTO payment_attempts(
         id,
         order_id,
         channel,
         status,
         provider_payment_order_id,
         provider_identity_role,
         provider_operation_eligible,
         request_snapshot
       )
       VALUES (
         $1,
         $2,
         $3,
         'CLOSED',
         $4,
         'canonical_owner',
         true,
         jsonb_build_object('providerOrderNo', $5::text, 'orderNo', $5::text)
       )`,
      [ownerId, orderId, channel, identityId, providerOrderNo]
    );
    await client.query(
      `INSERT INTO payment_attempts(
         id,
         order_id,
         channel,
         status,
         provider_payment_order_id,
         provider_identity_role,
         provider_operation_eligible,
         request_snapshot,
         reconciliation_state,
         reconciliation_last_result
       )
       VALUES (
         $1,
         $2,
         $3,
         'CLOSED',
         $4,
         'audit_alias',
         false,
         jsonb_build_object('providerOrderNo', $5::text, 'orderNo', $5::text),
         'TERMINAL',
         'LEGACY_PROVIDER_IDENTITY_ALIAS'
       )`,
      [aliasId, orderId, channel, identityId, providerOrderNo]
    );
    return { ownerId, aliasId, identityId, providerOrderNo };
  });

const withIdentityWriteContract = <T>(
  callback: (client: pg.PoolClient) => Promise<T>
) =>
  withTransaction(async (client) => {
    await client.query(
      "SET LOCAL peileme.payment_write_contract = 'identity_v1'"
    );
    return callback(client);
  });

const pre011Versions = [
  "001_initial.sql",
  "002_policy_foundation.sql",
  "003_policy_parameter_provenance.sql",
  "004_refresh_session_rotation.sql",
  "005_remove_document_review_grants.sql",
  "006_policy_result_shares.sql",
  "007_policy_rule_regressions.sql",
  "008_commerce.sql",
  "009_payment_reconciliation.sql",
  "010_order_channel_lookup.sql"
] as const;

const withPre011Database = async <T>(
  callback: (client: pg.Client, databaseUrl: string) => Promise<T>
) => {
  const baseUrl = new URL(process.env.DATABASE_URL!);
  const databaseName =
    `peileme_real_pay_${randomUUID().replaceAll("-", "")}`;
  const adminUrl = new URL(baseUrl);
  adminUrl.pathname = "/postgres";
  const databaseUrl = new URL(baseUrl);
  databaseUrl.pathname = `/${databaseName}`;
  const admin = new Client({ connectionString: adminUrl.toString() });
  const setup = new Client({ connectionString: databaseUrl.toString() });
  let databaseCreated = false;
  let setupConnected = false;
  try {
    await admin.connect();
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    databaseCreated = true;
    await setup.connect();
    setupConnected = true;
    await setup.query(`
      CREATE TABLE schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    for (const version of pre011Versions) {
      await setup.query(
        await readFile(path.resolve("database/migrations", version), "utf8")
      );
      await setup.query(
        "INSERT INTO schema_migrations(version) VALUES ($1)",
        [version]
      );
    }
    return await callback(setup, databaseUrl.toString());
  } finally {
    if (setupConnected) await setup.end();
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
};

const createLegacyUser = async (client: pg.Client, marker: string) => {
  const result = await client.query<{ id: string }>(
    `INSERT INTO users(email)
     VALUES ($1)
     RETURNING id`,
    [`legacy-${marker}@peileme.test`]
  );
  return result.rows[0].id;
};

const createLegacyOrder = async (
  client: pg.Client,
  userId: string,
  orderNo: string,
  status = "PAYING"
) => {
  const result = await client.query<{ id: string }>(
    `INSERT INTO orders(
       order_no,
       user_id,
       product_channel,
       status,
       total_fen,
       currency,
       idempotency_key,
       expires_at
     )
     VALUES ($1, $2, 'main', $3, 100, 'CNY', $4, now() + interval '30 minutes')
     RETURNING id`,
    [orderNo, userId, status, `idempotency-${orderNo}`]
  );
  return result.rows[0].id;
};

const createLegacyAttempt = async (
  client: pg.Client,
  input: {
    orderId: string;
    channel: "wechat_h5" | "alipay_wap" | "fake";
    status: string;
    requestSnapshot?: Record<string, unknown>;
    createdAt?: string;
    errorCode?: string;
  }
) => {
  const result = await client.query<{ id: string }>(
    `INSERT INTO payment_attempts(
       order_id,
       channel,
       status,
       request_snapshot,
       error_code,
       created_at,
       updated_at
     )
     VALUES ($1, $2, $3, $4::jsonb, $5, COALESCE($6::timestamptz, now()), COALESCE($6::timestamptz, now()))
     RETURNING id`,
    [
      input.orderId,
      input.channel,
      input.status,
      JSON.stringify(input.requestSnapshot ?? {}),
      input.errorCode ?? null,
      input.createdAt ?? null
    ]
  );
  return result.rows[0].id;
};

const createLegacyRefund = async (
  client: pg.Client,
  input: {
    orderId: string;
    channel: "wechat_h5" | "alipay_wap" | "fake";
    refundNo: string;
    status?: "PENDING" | "PROCESSING" | "SUCCEEDED" | "FAILED";
  }
) => {
  const result = await client.query<{ id: string }>(
    `INSERT INTO refunds(
       refund_no,
       order_id,
       channel,
       amount_fen,
       reason,
       status
     )
     VALUES ($1, $2, $3, 100, 'legacy refund migration fixture', $4)
     RETURNING id`,
    [input.refundNo, input.orderId, input.channel, input.status ?? "PENDING"]
  );
  return result.rows[0].id;
};

beforeAll(async () => {
  await runMigrations();
});

afterAll(async () => {
  await closePool();
});

describe("Task 4 real payment migration contract (RED)", () => {
  it("records a dedicated real-payment migration", async () => {
    const result = await query<{ version: string }>(
      `SELECT version
         FROM schema_migrations
        WHERE version = '011_real_payments.sql'`
    );

    expect(result.rows).toEqual([
      { version: "011_real_payments.sql" }
    ]);
  });

  it("creates immutable provider identities with one canonical query owner", async () => {
    const identities = await query<{
      column_name: string;
      is_nullable: string;
    }>(
      `SELECT column_name, is_nullable
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'provider_payment_orders'
          AND column_name IN (
            'id',
            'order_id',
            'channel',
            'provider_order_no',
            'origin',
            'allocated_at',
            'canonical_attempt_id',
            'manual_review_required'
          )
        ORDER BY column_name`
    );
    expect(identities.rows).toEqual([
      { column_name: "allocated_at", is_nullable: "NO" },
      { column_name: "canonical_attempt_id", is_nullable: "NO" },
      { column_name: "channel", is_nullable: "NO" },
      { column_name: "id", is_nullable: "NO" },
      { column_name: "manual_review_required", is_nullable: "NO" },
      { column_name: "order_id", is_nullable: "NO" },
      { column_name: "origin", is_nullable: "NO" },
      { column_name: "provider_order_no", is_nullable: "NO" }
    ]);

    const indexes = await query<{ indexdef: string }>(
      `SELECT indexdef
         FROM pg_indexes
        WHERE schemaname = 'public'
          AND tablename IN ('provider_payment_orders', 'payment_attempts')`
    );
    const indexDefinitions = indexes.rows
      .map(({ indexdef }) => indexdef.replace(/\s+/g, " "))
      .join("\n");
    expect(indexDefinitions).toMatch(
      /UNIQUE.*\(channel, provider_order_no\)/i
    );
    expect(indexDefinitions).toMatch(
      /UNIQUE.*\(provider_payment_order_id\).*WHERE.*provider_identity_role.*canonical_owner/i
    );

    const attemptColumns = await query<{
      column_name: string;
      is_nullable: string;
    }>(
      `SELECT column_name, is_nullable
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'payment_attempts'
          AND column_name IN (
            'provider_payment_order_id',
            'provider_identity_role',
            'provider_operation_eligible',
            'launch_expires_at'
          )
        ORDER BY column_name`
    );
    expect(attemptColumns.rows).toEqual([
      { column_name: "launch_expires_at", is_nullable: "YES" },
      { column_name: "provider_identity_role", is_nullable: "NO" },
      { column_name: "provider_operation_eligible", is_nullable: "NO" },
      { column_name: "provider_payment_order_id", is_nullable: "NO" }
    ]);

    const constraints = await query<{
      table_name: string;
      definition: string;
      condeferrable: boolean;
    }>(
      `SELECT cls.relname AS table_name,
              pg_get_constraintdef(con.oid) AS definition,
              con.condeferrable
         FROM pg_constraint con
         JOIN pg_class cls ON cls.oid = con.conrelid
        WHERE cls.relname IN ('provider_payment_orders', 'payment_attempts')`
    );
    const definitions = constraints.rows
      .map(({ definition }) => definition)
      .join("\n");
    expect(definitions).toContain("legacy_order_no");
    expect(definitions).toContain("attempt_v1");
    expect(definitions).toContain("canonical_owner");
    expect(definitions).toContain("audit_alias");
    expect(definitions).toContain("LEGACY_PROVIDER_IDENTITY_ALIAS");
    expect(definitions).toContain("LEGACY_FAKE_REQUIRES_MANUAL_REVIEW");
    expect(
      constraints.rows.some(
        ({ table_name, definition, condeferrable }) =>
          table_name === "provider_payment_orders" &&
          definition.includes(
            "FOREIGN KEY (canonical_attempt_id, order_id, channel)"
          ) &&
          definition.includes(
            "REFERENCES payment_attempts(id, order_id, channel)"
          ) &&
          condeferrable
      )
    ).toBe(true);
    expect(
      constraints.rows.some(
        ({ table_name, definition }) =>
          table_name === "provider_payment_orders" &&
          definition.includes(
            "FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE"
          )
      )
    ).toBe(true);
    expect(
      constraints.rows.some(
        ({ table_name, definition, condeferrable }) =>
          table_name === "payment_attempts" &&
          definition.includes(
            "FOREIGN KEY (provider_payment_order_id, order_id, channel)"
          ) &&
          definition.includes(
            "REFERENCES provider_payment_orders(id, order_id, channel)"
          ) &&
          condeferrable
      )
    ).toBe(true);

    const triggers = await query<{
      trigger_name: string;
      event_manipulation: string;
    }>(
      `SELECT trigger_name, event_manipulation
         FROM information_schema.triggers
        WHERE event_object_schema = 'public'
          AND event_object_table IN (
            'provider_payment_orders',
            'payment_attempts'
          )
          AND event_manipulation IN ('INSERT', 'UPDATE')`
    );
    expect(
      triggers.rows.some(({ trigger_name }) =>
        /provider.*identity.*immutable/i.test(trigger_name)
      )
    ).toBe(true);
    expect(
      triggers.rows.some(({ trigger_name }) =>
        /provider.*owner.*guard/i.test(trigger_name)
      )
    ).toBe(true);
    expect(
      triggers.rows.some(({ trigger_name }) =>
        /payment.*write.*contract.*guard/i.test(trigger_name)
      )
    ).toBe(true);
    expect(
      new Set(
        triggers.rows
          .filter(({ trigger_name }) =>
            /payment.*write.*contract.*guard/i.test(trigger_name)
          )
          .map(({ event_manipulation }) => event_manipulation)
      )
    ).toEqual(new Set(["INSERT", "UPDATE"]));
  });

  it("enforces one active payment attempt across every channel per order", async () => {
    const indexes = await query<{ indexdef: string }>(
      `SELECT indexdef
         FROM pg_indexes
        WHERE schemaname = 'public'
          AND tablename = 'payment_attempts'`
    );
    const normalized = indexes.rows
      .map(({ indexdef }) => indexdef.replace(/\s+/g, " "))
      .join("\n");

    expect(normalized).toMatch(
      /CREATE UNIQUE INDEX .* ON public\.payment_attempts USING btree \(order_id\)/i
    );
    for (const status of [
      "CREATED",
      "REDIRECT_READY",
      "PENDING",
      "CREATE_UNKNOWN",
      "RECONCILING",
      "CLOSE_UNKNOWN"
    ]) {
      expect(normalized).toContain(status);
    }
  });

  it("persists raw provider notifications in an idempotent inbox", async () => {
    const columns = await query<{
      column_name: string;
      is_nullable: string;
    }>(
      `SELECT column_name, is_nullable
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'payment_notification_events'
        ORDER BY column_name`
    );
    const names = columns.rows.map(({ column_name }) => column_name);
    expect(names).toEqual(
      expect.arrayContaining([
        "channel",
        "provider_event_id",
        "dedupe_key",
        "body_hash",
        "raw_body",
        "headers",
        "verification_status",
        "processing_status",
        "event_type",
        "provider_payment_order_id",
        "provider_order_no",
        "provider_transaction_id",
        "payment_attempt_id",
        "refund_id",
        "attempt_count",
        "last_error",
        "processed_at",
        "retention_until"
      ])
    );

    const indexes = await query<{ indexdef: string }>(
      `SELECT indexdef
         FROM pg_indexes
        WHERE schemaname = 'public'
          AND tablename = 'payment_notification_events'`
    );
    const definitions = indexes.rows.map(({ indexdef }) => indexdef);
    expect(
      definitions.some((definition) =>
        /UNIQUE.*\(channel, provider_event_id\)/i.test(definition)
      )
    ).toBe(true);

    const rawBody = columns.rows.find(
      ({ column_name }) => column_name === "raw_body"
    );
    expect(rawBody).toBeDefined();
    const rawType = await query<{ data_type: string }>(
      `SELECT data_type
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'payment_notification_events'
          AND column_name = 'raw_body'`
    );
    expect(rawType.rows[0]?.data_type).toBe("bytea");

    const conflicts = await query<{ table_name: string }>(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = 'payment_notification_conflicts'`
    );
    expect(conflicts.rows).toEqual([
      { table_name: "payment_notification_conflicts" }
    ]);
    expect(
      definitions.some((definition) =>
        /UNIQUE.*\(channel, dedupe_key\)/i.test(definition)
      )
    ).toBe(true);
  });

  it("binds each refund to its paid attempt and stable provider refund number", async () => {
    const result = await query<{
      column_name: string;
      is_nullable: string;
    }>(
      `SELECT column_name, is_nullable
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'refunds'
          AND column_name IN (
            'payment_attempt_id',
            'payment_transaction_id',
            'provider_refund_no',
            'request_snapshot',
            'failure_code',
            'failure_message',
            'succeeded_at',
            'provider_operation_eligible'
          )
        ORDER BY column_name`
    );
    expect(result.rows).toEqual([
      { column_name: "failure_code", is_nullable: "YES" },
      { column_name: "failure_message", is_nullable: "YES" },
      { column_name: "payment_attempt_id", is_nullable: "NO" },
      { column_name: "payment_transaction_id", is_nullable: "NO" },
      { column_name: "provider_operation_eligible", is_nullable: "NO" },
      { column_name: "provider_refund_no", is_nullable: "NO" },
      { column_name: "request_snapshot", is_nullable: "NO" },
      { column_name: "succeeded_at", is_nullable: "YES" }
    ]);

    const constraints = await query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition
         FROM pg_constraint
        WHERE conrelid = 'refunds'::regclass`
    );
    expect(
      constraints.rows.some(({ definition }) =>
        definition.includes("FOREIGN KEY (payment_transaction_id, order_id") &&
        definition.includes("payment_attempt_id, channel)")
      )
    ).toBe(true);
    expect(
      constraints.rows.some(({ definition }) =>
        definition.includes(
          "REFERENCES payment_transactions(id, order_id, payment_attempt_id, channel)"
        )
      )
    ).toBe(true);
    expect(
      constraints.rows.some(({ definition }) =>
        /UNIQUE\s*\(channel, provider_refund_no\)/i.test(definition)
      )
    ).toBe(true);
    const combined = constraints.rows
      .map(({ definition }) => definition)
      .join("\n");
    for (const status of [
      "PENDING",
      "SUBMITTING",
      "UNKNOWN",
      "PROCESSING",
      "SUCCEEDED",
      "FAILED"
    ]) {
      expect(combined).toContain(status);
    }
    const refundTriggers = await query<{
      trigger_name: string;
      event_manipulation: string;
    }>(
      `SELECT trigger_name, event_manipulation
         FROM information_schema.triggers
        WHERE event_object_schema = 'public'
          AND event_object_table = 'refunds'
          AND event_manipulation IN ('INSERT', 'UPDATE')`
    );
    expect(
      refundTriggers.rows.some(({ trigger_name }) =>
        /refund.*payment.*fact.*guard/i.test(trigger_name)
      )
    ).toBe(true);
    expect(
      new Set(
        refundTriggers.rows
          .filter(({ trigger_name }) =>
            /refund.*payment.*fact.*guard/i.test(trigger_name)
          )
          .map(({ event_manipulation }) => event_manipulation)
      )
    ).toEqual(new Set(["INSERT", "UPDATE"]));

    const transactionTriggers = await query<{
      trigger_name: string;
      event_manipulation: string;
    }>(
      `SELECT trigger_name, event_manipulation
         FROM information_schema.triggers
        WHERE event_object_schema = 'public'
          AND event_object_table = 'payment_transactions'
          AND event_manipulation = 'UPDATE'`
    );
    expect(
      transactionTriggers.rows.some(
        ({ trigger_name, event_manipulation }) =>
          /refund.*payment.*fact.*guard/i.test(trigger_name) &&
          event_manipulation === "UPDATE"
      )
    ).toBe(true);
  });
});

describe("Task 4 real payment migration behavior (RED)", () => {
  it.each(["CREATED", "REDIRECT_READY", "PENDING", "CREATE_UNKNOWN"])(
    "rejects a second channel while the first attempt is %s with 23505",
    async (status) => {
      const fixture = await createOrderFixture();
      try {
        await insertAttempt(
          fixture.orderId,
          "wechat_h5",
          status,
          `WX${randomUUID().replaceAll("-", "").slice(0, 28).toUpperCase()}`
        );
        await expect(
          insertAttempt(
            fixture.orderId,
            "alipay_wap",
            "CREATED",
            `AL${randomUUID().replaceAll("-", "").slice(0, 28).toUpperCase()}`
          )
        ).rejects.toMatchObject({ code: "23505" });
      } finally {
        await cleanupOrderFixture(fixture);
      }
    }
  );

  it.each(["RECONCILING", "CLOSE_UNKNOWN"])(
    "%s continues to block a new channel with 23505",
    async (status) => {
      const fixture = await createOrderFixture();
      try {
        await insertAttempt(
          fixture.orderId,
          "wechat_h5",
          status,
          `WX${randomUUID().replaceAll("-", "").slice(0, 28).toUpperCase()}`
        );
        await expect(
          insertAttempt(
            fixture.orderId,
            "alipay_wap",
            "CREATED",
            `AL${randomUUID().replaceAll("-", "").slice(0, 28).toUpperCase()}`
          )
        ).rejects.toMatchObject({ code: "23505" });
      } finally {
        await cleanupOrderFixture(fixture);
      }
    }
  );

  it("allows a new channel only after the previous attempt is CLOSED", async () => {
    const fixture = await createOrderFixture();
    try {
      await insertAttempt(
        fixture.orderId,
        "wechat_h5",
        "CLOSED",
        `WX${randomUUID().replaceAll("-", "").slice(0, 28).toUpperCase()}`
      );
      const next = await insertAttempt(
        fixture.orderId,
        "alipay_wap",
        "CREATED",
        `AL${randomUUID().replaceAll("-", "").slice(0, 28).toUpperCase()}`
      );
      expect(next.id).toMatch(/^[0-9a-f-]{36}$/);
    } finally {
      await cleanupOrderFixture(fixture);
    }
  });

  it("keeps a new provider identity distinct from order_no and immutable", async () => {
    const fixture = await createOrderFixture();
    try {
      const providerOrderNo =
        `WX${randomUUID().replaceAll("-", "").slice(0, 28).toUpperCase()}`;
      const attempt = await insertAttempt(
        fixture.orderId,
        "wechat_h5",
        "CLOSED",
        providerOrderNo
      );
      const identity = await query<{
        provider_order_no: string;
        origin: string;
      }>(
        `SELECT provider_order_no, origin
           FROM provider_payment_orders
          WHERE id = $1`,
        [attempt.providerPaymentOrderId]
      );
      expect(identity.rows).toEqual([
        { provider_order_no: providerOrderNo, origin: "attempt_v1" }
      ]);
      expect(identity.rows[0].provider_order_no).not.toBe(fixture.orderNo);
      await expect(
        query(
          `UPDATE provider_payment_orders
              SET provider_order_no = $2
            WHERE id = $1`,
          [
            attempt.providerPaymentOrderId,
            `WX${randomUUID().replaceAll("-", "").slice(0, 28).toUpperCase()}`
          ]
        )
      ).rejects.toMatchObject({ code: "23514" });
    } finally {
      await cleanupOrderFixture(fixture);
    }
  });

  it("prevents an attempt_v1 identity from acquiring an audit alias", async () => {
    const fixture = await createOrderFixture();
    try {
      const owner = await insertAttempt(
        fixture.orderId,
        "wechat_h5",
        "CLOSED",
        `WX${randomUUID().replaceAll("-", "").slice(0, 28).toUpperCase()}`
      );
      await expect(
        withIdentityWriteContract((client) =>
          client.query(
          `INSERT INTO payment_attempts(
             order_id,
             channel,
             status,
             provider_payment_order_id,
             provider_identity_role,
             provider_operation_eligible,
             request_snapshot
           )
           VALUES (
             $1,
             'wechat_h5',
             'CLOSED',
             $2,
             'audit_alias',
             false,
             jsonb_build_object('providerOrderNo', $3::text, 'orderNo', $3::text)
           )`,
          [fixture.orderId, owner.providerPaymentOrderId, owner.providerOrderNo]
          )
        )
      ).rejects.toMatchObject({ code: "23514" });
    } finally {
      await cleanupOrderFixture(fixture);
    }
  });

  it("rejects broken owner pointers, roles, channels, and a second owner", async () => {
    const fixture = await createOrderFixture();
    try {
      const first = await insertAttempt(
        fixture.orderId,
        "wechat_h5",
        "CLOSED",
        `WX${randomUUID().replaceAll("-", "").slice(0, 28).toUpperCase()}`
      );
      const second = await insertAttempt(
        fixture.orderId,
        "wechat_h5",
        "CLOSED",
        `WX${randomUUID().replaceAll("-", "").slice(0, 28).toUpperCase()}`
      );
      const invariantViolation = {
        code: expect.stringMatching(/^23/)
      };

      await expect(
        query(
          `UPDATE provider_payment_orders
              SET canonical_attempt_id = $2
            WHERE id = $1`,
          [first.providerPaymentOrderId, second.id]
        )
      ).rejects.toMatchObject(invariantViolation);
      await expect(
        withIdentityWriteContract((client) =>
          client.query(
          `UPDATE payment_attempts
              SET provider_payment_order_id = $2
            WHERE id = $1`,
          [first.id, second.providerPaymentOrderId]
          )
        )
      ).rejects.toMatchObject(invariantViolation);
      await expect(
        withIdentityWriteContract((client) =>
          client.query(
          `UPDATE payment_attempts
              SET provider_identity_role = 'audit_alias',
                  provider_operation_eligible = false
            WHERE id = $1`,
          [first.id]
          )
        )
      ).rejects.toMatchObject(invariantViolation);
      await expect(
        withIdentityWriteContract((client) =>
          client.query(
          `UPDATE payment_attempts
              SET channel = 'alipay_wap'
            WHERE id = $1`,
          [first.id]
          )
        )
      ).rejects.toMatchObject(invariantViolation);
      await expect(
        withIdentityWriteContract((client) =>
          client.query(
          `INSERT INTO payment_attempts(
             order_id,
             channel,
             status,
             provider_payment_order_id,
             provider_identity_role,
             provider_operation_eligible,
             request_snapshot
           )
           VALUES (
             $1,
             'wechat_h5',
             'CLOSED',
             $2,
             'canonical_owner',
             true,
             jsonb_build_object('providerOrderNo', $3::text, 'orderNo', $3::text)
           )`,
          [fixture.orderId, first.providerPaymentOrderId, first.providerOrderNo]
          )
        )
      ).rejects.toMatchObject(invariantViolation);
    } finally {
      await cleanupOrderFixture(fixture);
    }
  });

  it("keeps canonical owner immutable even when a same-order alias exists", async () => {
    const fixture = await createOrderFixture();
    try {
      const group = await insertLegacyIdentityWithAlias(
        fixture.orderId,
        "wechat_h5"
      );
      await expect(
        query(
          `UPDATE provider_payment_orders
              SET canonical_attempt_id = $2
            WHERE id = $1`,
          [group.identityId, group.aliasId]
        )
      ).rejects.toMatchObject({ code: expect.stringMatching(/^23/) });
      await expect(
        withIdentityWriteContract((client) =>
          client.query(
          `UPDATE payment_attempts
              SET status = 'PENDING'
            WHERE id = $1`,
          [group.aliasId]
          )
        )
      ).rejects.toMatchObject({ code: expect.stringMatching(/^23/) });
      await expect(
        withIdentityWriteContract((client) =>
          client.query(
          `UPDATE payment_attempts
              SET reconciliation_state = 'REQUIRED',
                  reconciliation_next_at = now() + interval '1 minute',
                  reconciliation_deadline_at = now() + interval '1 hour',
                  reconciliation_last_result = 'LOCAL_CLOSE_PENDING_FINAL_QUERY'
            WHERE id = $1`,
          [group.aliasId]
          )
        )
      ).rejects.toMatchObject({ code: expect.stringMatching(/^23/) });
    } finally {
      await cleanupOrderFixture(fixture);
    }
  });

  it("forbids cross-order aliases for one provider identity", async () => {
    const firstOrder = await createOrderFixture();
    const secondOrder = await createOrderFixture();
    try {
      const group = await insertLegacyIdentityWithAlias(
        firstOrder.orderId,
        "wechat_h5"
      );
      await expect(
        withIdentityWriteContract((client) =>
          client.query(
          `INSERT INTO payment_attempts(
             order_id,
             channel,
             status,
             provider_payment_order_id,
             provider_identity_role,
             provider_operation_eligible,
             request_snapshot,
             reconciliation_state,
             reconciliation_last_result
           )
           VALUES (
             $1,
             'wechat_h5',
             'CLOSED',
             $2,
             'audit_alias',
             false,
             jsonb_build_object('providerOrderNo', $3::text, 'orderNo', $3::text),
             'TERMINAL',
             'LEGACY_PROVIDER_IDENTITY_ALIAS'
           )`,
          [secondOrder.orderId, group.identityId, group.providerOrderNo]
          )
        )
      ).rejects.toMatchObject({ code: expect.stringMatching(/^23/) });
    } finally {
      await cleanupOrderFixture(secondOrder);
      await cleanupOrderFixture(firstOrder);
    }
  });

  it("deletes an order and its cyclic provider identities without orphans", async () => {
    const fixture = await createOrderFixture();
    try {
      const group = await insertLegacyIdentityWithAlias(
        fixture.orderId,
        "wechat_h5"
      );
      await query("DELETE FROM orders WHERE id = $1", [fixture.orderId]);
      const remaining = await query<{
        identity_count: string;
        attempt_count: string;
      }>(
        `SELECT
           (SELECT count(*)::text
              FROM provider_payment_orders
             WHERE id = $1) AS identity_count,
           (SELECT count(*)::text
              FROM payment_attempts
             WHERE id IN ($2, $3)) AS attempt_count`,
        [group.identityId, group.ownerId, group.aliasId]
      );
      expect(remaining.rows).toEqual([
        { identity_count: "0", attempt_count: "0" }
      ]);
    } finally {
      await cleanupOrderFixture(fixture);
    }
  });

  it("allows provider operations only for real canonical owners", async () => {
    const fixture = await createOrderFixture();
    try {
      const realGroup = await insertLegacyIdentityWithAlias(
        fixture.orderId,
        "alipay_wap"
      );
      await expect(
        withIdentityWriteContract((client) =>
          client.query(
          `UPDATE payment_attempts
              SET provider_operation_eligible = true
            WHERE id = $1`,
          [realGroup.aliasId]
          )
        )
      ).rejects.toMatchObject({ code: expect.stringMatching(/^23/) });

      const fakeOwnerId = randomUUID();
      const fakeIdentityId = randomUUID();
      await withTransaction(async (client) => {
        await client.query("SET CONSTRAINTS ALL DEFERRED");
        await client.query(
          "SET LOCAL peileme.payment_write_contract = 'identity_v1'"
        );
        await client.query(
          `INSERT INTO provider_payment_orders(
             id,
             order_id,
             channel,
             provider_order_no,
             origin,
             allocated_at,
             canonical_attempt_id,
             manual_review_required
           )
           VALUES ($1, $2, 'fake', 'FAKELEGACYAUDITONLY', 'legacy_order_no', now(), $3, true)`,
          [fakeIdentityId, fixture.orderId, fakeOwnerId]
        );
        await client.query(
          `INSERT INTO payment_attempts(
             id,
             order_id,
             channel,
             status,
             provider_payment_order_id,
             provider_identity_role,
             provider_operation_eligible,
             request_snapshot,
             reconciliation_state,
             reconciliation_last_result
           )
           VALUES (
             $1,
             $2,
             'fake',
             'CLOSED',
             $3,
             'canonical_owner',
             false,
             jsonb_build_object(
               'providerOrderNo',
               'FAKELEGACYAUDITONLY',
               'orderNo',
               'FAKELEGACYAUDITONLY'
             ),
             'TERMINAL',
             'LEGACY_FAKE_REQUIRES_MANUAL_REVIEW'
           )`,
          [fakeOwnerId, fixture.orderId, fakeIdentityId]
        );
      });
      await expect(
        withIdentityWriteContract((client) =>
          client.query(
          `UPDATE payment_attempts
              SET provider_operation_eligible = true
            WHERE id = $1`,
          [fakeOwnerId]
          )
        )
      ).rejects.toMatchObject({ code: expect.stringMatching(/^23/) });
    } finally {
      await cleanupOrderFixture(fixture);
    }
  });

  it.each([
    ["channel", "alipay_wap"],
    ["origin", "legacy_order_no"],
    ["allocated_at", "2026-08-01T00:00:00.000Z"],
    ["provider_order_no", "WXMUTATEDIDENTITY"]
  ] as const)("keeps provider identity field %s immutable", async (field, value) => {
    const fixture = await createOrderFixture();
    try {
      const owner = await insertAttempt(
        fixture.orderId,
        "wechat_h5",
        "CLOSED",
        `WX${randomUUID().replaceAll("-", "").slice(0, 28).toUpperCase()}`
      );
      await expect(
        query(
          `UPDATE provider_payment_orders
              SET ${field} = $2
            WHERE id = $1`,
          [owner.providerPaymentOrderId, value]
        )
      ).rejects.toMatchObject({ code: expect.stringMatching(/^23/) });
    } finally {
      await cleanupOrderFixture(fixture);
    }
  });

  it("rejects the pre-011 attempt insert shape without an identity", async () => {
    const fixture = await createOrderFixture();
    try {
      await expect(
        query(
          `INSERT INTO payment_attempts(order_id, channel, status)
           VALUES ($1, 'wechat_h5', 'CREATED')`,
          [fixture.orderId]
        )
      ).rejects.toMatchObject({ code: "23502" });
    } finally {
      await cleanupOrderFixture(fixture);
    }
  });

  it("rejects a complete identity-shaped INSERT without the transaction contract", async () => {
    const fixture = await createOrderFixture();
    try {
      await expect(
        withTransaction(async (client) => {
          const attemptId = randomUUID();
          const identityId = randomUUID();
          await client.query("SET CONSTRAINTS ALL DEFERRED");
          await client.query(
            `INSERT INTO provider_payment_orders(
               id,
               order_id,
               channel,
               provider_order_no,
               origin,
               allocated_at,
               canonical_attempt_id,
               manual_review_required
             )
             VALUES ($1, $2, 'wechat_h5', 'WXNOGUCINSERT', 'attempt_v1', now(), $3, false)`,
            [identityId, fixture.orderId, attemptId]
          );
          await client.query(
            `INSERT INTO payment_attempts(
               id,
               order_id,
               channel,
               status,
               provider_payment_order_id,
               provider_identity_role,
               provider_operation_eligible,
               request_snapshot
             )
             VALUES (
               $1,
               $2,
               'wechat_h5',
               'CLOSED',
               $3,
               'canonical_owner',
               true,
               jsonb_build_object(
                 'providerOrderNo',
                 'WXNOGUCINSERT',
                 'orderNo',
                 'WXNOGUCINSERT'
               )
             )`,
            [attemptId, fixture.orderId, identityId]
          );
        })
      ).rejects.toMatchObject({ code: "23514" });
    } finally {
      await cleanupOrderFixture(fixture);
    }
  });

  it("forbids fake for a newly allocated attempt_v1 identity", async () => {
    const fixture = await createOrderFixture();
    try {
      await expect(
        withTransaction(async (client) => {
          const attemptId = randomUUID();
          const identityId = randomUUID();
          await client.query("SET CONSTRAINTS ALL DEFERRED");
          await client.query(
            "SET LOCAL peileme.payment_write_contract = 'identity_v1'"
          );
          await client.query(
            `INSERT INTO provider_payment_orders(
               id,
               order_id,
               channel,
               provider_order_no,
               origin,
               allocated_at,
               canonical_attempt_id,
               manual_review_required
             )
             VALUES ($1, $2, 'fake', 'FAKENEWATTEMPTV1', 'attempt_v1', now(), $3, false)`,
            [identityId, fixture.orderId, attemptId]
          );
          await client.query(
            `INSERT INTO payment_attempts(
               id,
               order_id,
               channel,
               status,
               provider_payment_order_id,
               provider_identity_role,
               provider_operation_eligible,
               request_snapshot
             )
             VALUES (
               $1,
               $2,
               'fake',
               'CLOSED',
               $3,
               'canonical_owner',
               false,
               jsonb_build_object(
                 'providerOrderNo',
                 'FAKENEWATTEMPTV1',
                 'orderNo',
                 'FAKENEWATTEMPTV1'
               )
             )`,
            [attemptId, fixture.orderId, identityId]
          );
        })
      ).rejects.toMatchObject({ code: expect.stringMatching(/^23/) });
    } finally {
      await cleanupOrderFixture(fixture);
    }
  });

  it("rejects a new identity whose canonical owner belongs to another identity", async () => {
    const fixture = await createOrderFixture();
    try {
      const existing = await insertAttempt(
        fixture.orderId,
        "wechat_h5",
        "CLOSED",
        `WX${randomUUID().replaceAll("-", "").slice(0, 28).toUpperCase()}`
      );
      await expect(
        withTransaction(async (client) => {
          await client.query("SET CONSTRAINTS ALL DEFERRED");
          await client.query(
            "SET LOCAL peileme.payment_write_contract = 'identity_v1'"
          );
          await client.query(
            `INSERT INTO provider_payment_orders(
               id,
               order_id,
               channel,
               provider_order_no,
               origin,
               allocated_at,
               canonical_attempt_id,
               manual_review_required
             )
             VALUES ($1, $2, 'wechat_h5', 'WXWRONGEXISTINGOWNER', 'attempt_v1', now(), $3, false)`,
            [randomUUID(), fixture.orderId, existing.id]
          );
        })
      ).rejects.toMatchObject({ code: expect.stringMatching(/^23/) });
    } finally {
      await cleanupOrderFixture(fixture);
    }
  });

  it("requires a real attempt_v1 canonical owner to be operation eligible", async () => {
    const fixture = await createOrderFixture();
    try {
      await expect(
        withTransaction(async (client) => {
          const attemptId = randomUUID();
          const identityId = randomUUID();
          await client.query("SET CONSTRAINTS ALL DEFERRED");
          await client.query(
            "SET LOCAL peileme.payment_write_contract = 'identity_v1'"
          );
          await client.query(
            `INSERT INTO provider_payment_orders(
               id,
               order_id,
               channel,
               provider_order_no,
               origin,
               allocated_at,
               canonical_attempt_id,
               manual_review_required
             )
             VALUES ($1, $2, 'wechat_h5', 'WXINELIGIBLEOWNER', 'attempt_v1', now(), $3, false)`,
            [identityId, fixture.orderId, attemptId]
          );
          await client.query(
            `INSERT INTO payment_attempts(
               id,
               order_id,
               channel,
               status,
               provider_payment_order_id,
               provider_identity_role,
               provider_operation_eligible,
               request_snapshot
             )
             VALUES (
               $1,
               $2,
               'wechat_h5',
               'CLOSED',
               $3,
               'canonical_owner',
               false,
               jsonb_build_object(
                 'providerOrderNo',
                 'WXINELIGIBLEOWNER',
                 'orderNo',
                 'WXINELIGIBLEOWNER'
               )
             )`,
            [attemptId, fixture.orderId, identityId]
          );
        })
      ).rejects.toMatchObject({ code: expect.stringMatching(/^23/) });
    } finally {
      await cleanupOrderFixture(fixture);
    }
  });

  it("binds refunds only to SUCCESS facts and derives worker eligibility", async () => {
    const fixture = await createOrderFixture();
    try {
      const attempt = await insertAttempt(
        fixture.orderId,
        "wechat_h5",
        "SUCCEEDED",
        `WX${randomUUID().replaceAll("-", "").slice(0, 28).toUpperCase()}`
      );
      const success = await query<{ id: string }>(
        `INSERT INTO payment_transactions(
           order_id,
           payment_attempt_id,
           channel,
           channel_transaction_id,
           amount_fen,
           currency,
           status,
           verified_payload,
           paid_at
         )
         VALUES ($1, $2, 'wechat_h5', $3, 100, 'CNY', 'SUCCESS', '{}'::jsonb, now())
         RETURNING id`,
        [fixture.orderId, attempt.id, `WX-TXN-${randomUUID()}`]
      );
      const closed = await query<{ id: string }>(
        `INSERT INTO payment_transactions(
           order_id,
           payment_attempt_id,
           channel,
           channel_transaction_id,
           amount_fen,
           currency,
           status,
           verified_payload
         )
         VALUES ($1, $2, 'wechat_h5', $3, 100, 'CNY', 'CLOSED', '{}'::jsonb)
         RETURNING id`,
        [fixture.orderId, attempt.id, `WX-CLOSED-${randomUUID()}`]
      );
      const refunded = await query<{ id: string }>(
        `INSERT INTO payment_transactions(
           order_id,
           payment_attempt_id,
           channel,
           channel_transaction_id,
           amount_fen,
           currency,
           status,
           verified_payload
         )
         VALUES ($1, $2, 'wechat_h5', $3, 100, 'CNY', 'REFUND', '{}'::jsonb)
         RETURNING id`,
        [fixture.orderId, attempt.id, `WX-REFUND-${randomUUID()}`]
      );
      const validRefund = await query<{ id: string }>(
        `INSERT INTO refunds(
           refund_no,
           provider_refund_no,
           order_id,
           payment_attempt_id,
           payment_transaction_id,
           channel,
           amount_fen,
           reason,
           status,
           provider_operation_eligible,
           request_snapshot
         )
         VALUES ($1, $1, $2, $3, $4, 'wechat_h5', 100, 'test', 'PENDING', true, '{}'::jsonb)
         RETURNING id`,
        [
          `RF${randomUUID().replaceAll("-", "").slice(0, 24)}`,
          fixture.orderId,
          attempt.id,
          success.rows[0].id
        ]
      );
      await expect(
        query(
          `INSERT INTO refunds(
             refund_no,
             provider_refund_no,
             order_id,
             payment_attempt_id,
             payment_transaction_id,
             channel,
             amount_fen,
             reason,
             status,
             provider_operation_eligible,
             request_snapshot
           )
           VALUES ($1, $1, $2, $3, $4, 'wechat_h5', 100, 'test', 'PENDING', false, '{}'::jsonb)`,
          [
            `RF${randomUUID().replaceAll("-", "").slice(0, 24)}`,
            fixture.orderId,
            attempt.id,
            success.rows[0].id
          ]
        )
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        query(
          `UPDATE refunds
              SET status = 'UNKNOWN',
                  provider_operation_eligible = false
            WHERE id = $1`,
          [validRefund.rows[0].id]
        )
      ).rejects.toMatchObject({ code: "23514" });
      for (const invalidTransactionId of [
        closed.rows[0].id,
        refunded.rows[0].id
      ]) {
        await expect(
          query(
            `INSERT INTO refunds(
               refund_no,
               provider_refund_no,
               order_id,
               payment_attempt_id,
               payment_transaction_id,
               channel,
               amount_fen,
               reason,
               status,
               provider_operation_eligible,
               request_snapshot
             )
             VALUES ($1, $1, $2, $3, $4, 'wechat_h5', 100, 'test', 'PENDING', true, '{}'::jsonb)`,
            [
              `RF${randomUUID().replaceAll("-", "").slice(0, 24)}`,
              fixture.orderId,
              attempt.id,
              invalidTransactionId
            ]
          )
        ).rejects.toMatchObject({ code: "23514" });
      }
      await expect(
        query(
          `UPDATE refunds
              SET payment_transaction_id = $2
            WHERE id = $1`,
          [validRefund.rows[0].id, closed.rows[0].id]
        )
      ).rejects.toMatchObject({ code: "23514" });
      await query(
        `UPDATE refunds
            SET status = 'SUCCEEDED',
                provider_operation_eligible = false,
                succeeded_at = now()
          WHERE id = $1`,
        [validRefund.rows[0].id]
      );
      await expect(
        query(
          `UPDATE refunds
              SET provider_operation_eligible = true
            WHERE id = $1`,
          [validRefund.rows[0].id]
        )
      ).rejects.toMatchObject({ code: "23514" });
    } finally {
      await cleanupOrderFixture(fixture);
    }
  });

  it("enforces provider refund numbers per channel while allowing cross-channel reuse", async () => {
    const wechatFirst = await createOrderFixture();
    const wechatSecond = await createOrderFixture();
    const alipay = await createOrderFixture();
    try {
      const createPaidFact = async (
        fixture: { orderId: string },
        channel: "wechat_h5" | "alipay_wap",
        marker: string
      ) => {
        const attempt = await insertAttempt(
          fixture.orderId,
          channel,
          "SUCCEEDED",
          `${channel === "wechat_h5" ? "WX" : "AL"}${marker}`
        );
        const transaction = await query<{ id: string }>(
          `INSERT INTO payment_transactions(
             order_id,
             payment_attempt_id,
             channel,
             channel_transaction_id,
             amount_fen,
             currency,
             status,
             verified_payload,
             paid_at
           )
           VALUES ($1, $2, $3, $4, 100, 'CNY', 'SUCCESS', '{}'::jsonb, now())
           RETURNING id`,
          [fixture.orderId, attempt.id, channel, `${channel}-TXN-${marker}`]
        );
        return { attemptId: attempt.id, transactionId: transaction.rows[0].id };
      };
      const marker = randomUUID().replaceAll("-", "").slice(0, 24);
      const firstFact = await createPaidFact(
        wechatFirst,
        "wechat_h5",
        `${marker}A`
      );
      const secondFact = await createPaidFact(
        wechatSecond,
        "wechat_h5",
        `${marker}B`
      );
      const alipayFact = await createPaidFact(
        alipay,
        "alipay_wap",
        `${marker}C`
      );
      const sharedProviderRefundNo = `RF-SHARED-${marker}`;
      const insertRefund = (
        fixture: { orderId: string },
        fact: { attemptId: string; transactionId: string },
        channel: "wechat_h5" | "alipay_wap",
        refundNo: string
      ) =>
        query(
          `INSERT INTO refunds(
             refund_no,
             provider_refund_no,
             order_id,
             payment_attempt_id,
             payment_transaction_id,
             channel,
             amount_fen,
             reason,
             status,
             provider_operation_eligible,
             request_snapshot
           )
           VALUES ($1, $2, $3, $4, $5, $6, 100, 'refund identity scope', 'PENDING', true, '{}'::jsonb)`,
          [
            refundNo,
            sharedProviderRefundNo,
            fixture.orderId,
            fact.attemptId,
            fact.transactionId,
            channel
          ]
        );

      await insertRefund(
        wechatFirst,
        firstFact,
        "wechat_h5",
        `LOCAL-WX-A-${marker}`
      );
      await expect(
        insertRefund(
          wechatSecond,
          secondFact,
          "wechat_h5",
          `LOCAL-WX-B-${marker}`
        )
      ).rejects.toMatchObject({ code: "23505" });
      await expect(
        insertRefund(
          alipay,
          alipayFact,
          "alipay_wap",
          `LOCAL-AL-${marker}`
        )
      ).resolves.toMatchObject({ command: "INSERT", rowCount: 1 });
    } finally {
      await cleanupOrderFixture(wechatFirst);
      await cleanupOrderFixture(wechatSecond);
      await cleanupOrderFixture(alipay);
    }
  });

  it.each([
    { name: "status from SUCCESS to CLOSED", setClause: "status = 'CLOSED'" },
    { name: "status from SUCCESS to REFUND", setClause: "status = 'REFUND'" },
    {
      name: "order_id",
      setClause: "order_id = $2",
      replacement: "otherOrderId"
    },
    {
      name: "payment_attempt_id",
      setClause: "payment_attempt_id = $2",
      replacement: "otherAttemptId"
    },
    { name: "channel", setClause: "channel = 'alipay_wap'" },
    { name: "amount_fen", setClause: "amount_fen = 101" },
    { name: "currency", setClause: "currency = 'USD'" },
    {
      name: "channel_transaction_id",
      setClause: "channel_transaction_id = 'MUTATED-TRANSACTION-ID'"
    }
  ] as const)(
    "keeps refund-referenced SUCCESS transaction $name append-only",
    async ({ setClause, replacement }) => {
      const fixture = await createOrderFixture();
      const otherFixture = await createOrderFixture();
      try {
        const attempt = await insertAttempt(
          fixture.orderId,
          "wechat_h5",
          "SUCCEEDED",
          `WX${randomUUID().replaceAll("-", "").slice(0, 28).toUpperCase()}`
        );
        const otherAttempt = await insertAttempt(
          fixture.orderId,
          "wechat_h5",
          "SUCCEEDED",
          `WX${randomUUID().replaceAll("-", "").slice(0, 28).toUpperCase()}`
        );
        const transaction = await query<{ id: string }>(
          `INSERT INTO payment_transactions(
             order_id,
             payment_attempt_id,
             channel,
             channel_transaction_id,
             amount_fen,
             currency,
             status,
             verified_payload,
             paid_at
           )
           VALUES ($1, $2, 'wechat_h5', $3, 100, 'CNY', 'SUCCESS', '{}'::jsonb, now())
           RETURNING id`,
          [fixture.orderId, attempt.id, `WX-IMMUTABLE-${randomUUID()}`]
        );
        await query(
          `INSERT INTO refunds(
             refund_no,
             provider_refund_no,
             order_id,
             payment_attempt_id,
             payment_transaction_id,
             channel,
             amount_fen,
             reason,
             status,
             provider_operation_eligible,
             request_snapshot
           )
           VALUES ($1, $1, $2, $3, $4, 'wechat_h5', 100, 'append-only guard', 'PENDING', true, '{}'::jsonb)`,
          [
            `RF${randomUUID().replaceAll("-", "").slice(0, 24)}`,
            fixture.orderId,
            attempt.id,
            transaction.rows[0].id
          ]
        );
        const replacementValue =
          replacement === "otherOrderId"
            ? otherFixture.orderId
            : replacement === "otherAttemptId"
              ? otherAttempt.id
              : undefined;
        await expect(
          query(
            `UPDATE payment_transactions
                SET ${setClause}
              WHERE id = $1`,
            replacementValue === undefined
              ? [transaction.rows[0].id]
              : [transaction.rows[0].id, replacementValue]
          )
        ).rejects.toMatchObject({
          code: "23514",
          constraint: "payment_transactions_refund_fact_immutable"
        });
      } finally {
        await cleanupOrderFixture(fixture);
        await cleanupOrderFixture(otherFixture);
      }
    }
  );

  it(
    "preserves legacy provider identities, shares aliases, selects one owner, and reruns safely",
    async () => {
      await withPre011Database(async (client, databaseUrl) => {
        const userId = await createLegacyUser(client, "identity-success");
        const exactOrderId = await createLegacyOrder(
          client,
          userId,
          "LEGACYREALPAY001",
          "PAYMENT_FAILED"
        );
        const exactAttemptId = await createLegacyAttempt(client, {
          orderId: exactOrderId,
          channel: "wechat_h5",
          status: "FAILED",
          requestSnapshot: { providerOrderNo: "WXLEGACYEXACT001" },
          createdAt: "2026-07-01T01:02:03.000Z",
          errorCode: "PAYMENT_PROVIDER_TIMEOUT"
        });

        const sharedOrderId = await createLegacyOrder(
          client,
          userId,
          "LEGACYREALPAY002",
          "PAID"
        );
        const successfulAttemptId = await createLegacyAttempt(client, {
          orderId: sharedOrderId,
          channel: "alipay_wap",
          status: "SUCCEEDED",
          requestSnapshot: { orderNo: "ALLEGACYSHARED002" },
          createdAt: "2026-07-01T02:00:00.000Z"
        });
        const aliasAttemptId = await createLegacyAttempt(client, {
          orderId: sharedOrderId,
          channel: "alipay_wap",
          status: "PENDING",
          requestSnapshot: { orderNo: "ALLEGACYSHARED002" },
          createdAt: "2026-07-01T03:00:00.000Z"
        });
        const successfulTransaction = await client.query<{ id: string }>(
          `INSERT INTO payment_transactions(
             order_id,
             payment_attempt_id,
             channel,
             channel_transaction_id,
             amount_fen,
             currency,
             status,
             verified_payload,
             paid_at
           )
           VALUES ($1, $2, 'alipay_wap', 'ALI-TXN-LEGACY-002', 100, 'CNY', 'SUCCESS', '{}'::jsonb, '2026-07-01T02:05:00.000Z')
           RETURNING id`,
          [sharedOrderId, successfulAttemptId]
        );

        const fallbackOrderId = await createLegacyOrder(
          client,
          userId,
          "LEGACYREALPAY003",
          "CLOSED"
        );
        const fallbackAttemptId = await createLegacyAttempt(client, {
          orderId: fallbackOrderId,
          channel: "wechat_h5",
          status: "CLOSED",
          createdAt: "2026-07-01T04:00:00.000Z"
        });

        const activeOrderId = await createLegacyOrder(
          client,
          userId,
          "LEGACYREALPAY004",
          "PAYING"
        );
        const staleAttemptId = await createLegacyAttempt(client, {
          orderId: activeOrderId,
          channel: "wechat_h5",
          status: "FAILED",
          requestSnapshot: { orderNo: "WXLEGACYACTIVE004" },
          createdAt: "2026-07-01T05:00:00.000Z"
        });
        const activeAttemptId = await createLegacyAttempt(client, {
          orderId: activeOrderId,
          channel: "wechat_h5",
          status: "PENDING",
          requestSnapshot: { orderNo: "WXLEGACYACTIVE004" },
          createdAt: "2026-07-01T06:00:00.000Z"
        });
        const reconciliationAttemptId = await createLegacyAttempt(client, {
          orderId: activeOrderId,
          channel: "wechat_h5",
          status: "CLOSED",
          requestSnapshot: { orderNo: "WXLEGACYACTIVE004" },
          createdAt: "2026-07-01T07:00:00.000Z"
        });
        await client.query(
          `UPDATE payment_attempts
              SET reconciliation_state = 'REQUIRED',
                  reconciliation_next_at = '2026-07-01T07:01:00.000Z',
                  reconciliation_deadline_at = '2026-07-02T07:00:00.000Z',
                  reconciliation_last_result = 'LOCAL_CLOSE_PENDING_FINAL_QUERY'
            WHERE id = $1`,
          [reconciliationAttemptId]
        );

        const dualFieldOrderId = await createLegacyOrder(
          client,
          userId,
          "LEGACYREALPAY007",
          "PAYMENT_FAILED"
        );
        const dualFieldAttemptId = await createLegacyAttempt(client, {
          orderId: dualFieldOrderId,
          channel: "alipay_wap",
          status: "FAILED",
          requestSnapshot: {
            providerOrderNo: "ALMATCHINGDUAL007",
            orderNo: "ALMATCHINGDUAL007"
          },
          createdAt: "2026-07-01T07:30:00.000Z",
          errorCode: "PAYMENT_PROVIDER_FAILED"
        });

        const fakePaidOrderId = await createLegacyOrder(
          client,
          userId,
          "LEGACYREALPAY005",
          "COMPLETED"
        );
        await client.query(
          "UPDATE orders SET total_fen = 300 WHERE id = $1",
          [fakePaidOrderId]
        );
        const fakePaidAttemptId = await createLegacyAttempt(client, {
          orderId: fakePaidOrderId,
          channel: "fake",
          status: "SUCCEEDED",
          requestSnapshot: { orderNo: "FAKELEGACYPAID005" },
          createdAt: "2026-07-01T08:00:00.000Z"
        });
        const fakeSuccessfulTransaction = await client.query<{ id: string }>(
          `INSERT INTO payment_transactions(
             order_id,
             payment_attempt_id,
             channel,
             channel_transaction_id,
             amount_fen,
             currency,
             status,
             verified_payload,
             paid_at
           )
           VALUES ($1, $2, 'fake', 'FAKE-TXN-LEGACY-005', 300, 'CNY', 'SUCCESS', '{}'::jsonb, '2026-07-01T08:05:00.000Z')
           RETURNING id`,
          [fakePaidOrderId, fakePaidAttemptId]
        );
        const fakeProduct = await client.query<{ id: string }>(
          `INSERT INTO products(
             sku,
             name,
             description,
             product_channel,
             fulfillment_type,
             status,
             entitlement_policy
           )
           VALUES (
             'LEGACY_FAKE_AUDIT',
             'Legacy fake audit product',
             'Migration preservation fixture',
             'main',
             'policy_calculation',
             'active',
             '{}'::jsonb
           )
           RETURNING id`
        );
        const fakeEntitlement = await client.query<{ id: string }>(
          `INSERT INTO entitlements(
             user_id,
             product_id,
             source_type,
             source_id,
             total_uses,
             remaining_uses,
             status
           )
           VALUES ($1, $2, 'order', $3, 1, 1, 'active')
           RETURNING id`,
          [userId, fakeProduct.rows[0].id, fakePaidOrderId]
        );
        const realLegacyRefund = await client.query<{ id: string }>(
          `INSERT INTO refunds(
             refund_no,
             order_id,
             channel,
             amount_fen,
             reason,
             status,
             requested_by
           )
           VALUES ('LEGACY-REAL-REFUND-002', $1, 'alipay_wap', 100, 'legacy real refund', 'SUCCEEDED', $2)
           RETURNING id`,
          [sharedOrderId, userId]
        );
        const fakeLegacyRefund = await client.query<{ id: string }>(
          `INSERT INTO refunds(
             refund_no,
             order_id,
             channel,
             amount_fen,
             reason,
             status,
             requested_by
           )
           VALUES ('LEGACY-FAKE-REFUND-005', $1, 'fake', 100, 'legacy fake refund', 'SUCCEEDED', $2)
           RETURNING id`,
          [fakePaidOrderId, userId]
        );
        const fakePendingLegacyRefund = await client.query<{ id: string }>(
          `INSERT INTO refunds(
             refund_no,
             order_id,
             channel,
             amount_fen,
             reason,
             status,
             requested_by
           )
           VALUES ('LEGACY-FAKE-REFUND-PENDING-005', $1, 'fake', 100, 'legacy fake pending refund', 'PENDING', $2)
           RETURNING id`,
          [fakePaidOrderId, userId]
        );
        const fakeProcessingLegacyRefund = await client.query<{ id: string }>(
          `INSERT INTO refunds(
             refund_no,
             order_id,
             channel,
             amount_fen,
             reason,
             status,
             requested_by
           )
           VALUES ('LEGACY-FAKE-REFUND-PROCESSING-005', $1, 'fake', 100, 'legacy fake processing refund', 'PROCESSING', $2)
           RETURNING id`,
          [fakePaidOrderId, userId]
        );

        const fakePendingOrderId = await createLegacyOrder(
          client,
          userId,
          "LEGACYREALPAY006",
          "PAYING"
        );
        const fakePendingAttemptId = await createLegacyAttempt(client, {
          orderId: fakePendingOrderId,
          channel: "fake",
          status: "PENDING",
          requestSnapshot: { orderNo: "FAKELEGACYPENDING006" },
          createdAt: "2026-07-01T09:00:00.000Z"
        });
        const fakeSuccessfulRefundBefore = await client.query<{
          row: Record<string, unknown>;
        }>(
          `SELECT to_jsonb(r) AS row
             FROM refunds r
            WHERE id = $1`,
          [fakeLegacyRefund.rows[0].id]
        );

        const firstRun = await runMigrationProcess(databaseUrl);
        expect(
          firstRun.status,
          `${firstRun.stdout}\n${firstRun.stderr}`
        ).toBe(0);
        const applied = await client.query<{ version: string }>(
          `SELECT version
             FROM schema_migrations
            WHERE version = '011_real_payments.sql'`
        );
        expect(applied.rows).toEqual([
          { version: "011_real_payments.sql" }
        ]);

        const firstSnapshot = await client.query<{
          attempt_id: string;
          order_no: string;
          provider_payment_order_id: string;
          provider_order_no: string;
          origin: string;
          allocated_at: Date;
          attempt_created_at: Date;
          canonical_attempt_id: string;
          provider_identity_role: string;
          provider_operation_eligible: boolean;
          manual_review_required: boolean;
          status: string;
          reconciliation_state: string;
          reconciliation_last_result: string | null;
          reconciliation_next_at: Date | null;
          reconciliation_deadline_at: Date | null;
        }>(
          `SELECT pa.id AS attempt_id,
                  o.order_no,
                  ppo.id AS provider_payment_order_id,
                  ppo.provider_order_no,
                  ppo.origin,
                  ppo.allocated_at,
                  pa.created_at AS attempt_created_at,
                  ppo.canonical_attempt_id,
                  pa.provider_identity_role,
                  pa.provider_operation_eligible,
                  ppo.manual_review_required,
                  pa.status,
                  pa.reconciliation_state,
                  pa.reconciliation_last_result,
                  pa.reconciliation_next_at,
                  pa.reconciliation_deadline_at
             FROM payment_attempts pa
             JOIN orders o ON o.id = pa.order_id
             JOIN provider_payment_orders ppo
               ON ppo.id = pa.provider_payment_order_id
            ORDER BY pa.id`
        );
        expect(firstSnapshot.rows).toHaveLength(10);

        const exact = firstSnapshot.rows.find(
          ({ attempt_id }) => attempt_id === exactAttemptId
        )!;
        expect(exact).toMatchObject({
          provider_order_no: "WXLEGACYEXACT001",
          origin: "legacy_order_no",
          canonical_attempt_id: exactAttemptId,
          provider_identity_role: "canonical_owner",
          provider_operation_eligible: true,
          status: "CREATE_UNKNOWN"
        });
        expect(exact.allocated_at.toISOString()).toBe(
          exact.attempt_created_at.toISOString()
        );

        const successful = firstSnapshot.rows.find(
          ({ attempt_id }) => attempt_id === successfulAttemptId
        )!;
        const alias = firstSnapshot.rows.find(
          ({ attempt_id }) => attempt_id === aliasAttemptId
        )!;
        expect(successful.provider_order_no).toBe("ALLEGACYSHARED002");
        expect(successful.provider_payment_order_id).toBe(
          alias.provider_payment_order_id
        );
        expect(successful).toMatchObject({
          canonical_attempt_id: successfulAttemptId,
          provider_identity_role: "canonical_owner"
        });
        expect(successful.allocated_at.toISOString()).toBe(
          successful.attempt_created_at.toISOString()
        );
        expect(alias).toMatchObject({
          canonical_attempt_id: successfulAttemptId,
          provider_identity_role: "audit_alias",
          provider_operation_eligible: false,
          status: "CLOSED",
          reconciliation_state: "TERMINAL",
          reconciliation_last_result: "LEGACY_PROVIDER_IDENTITY_ALIAS",
          reconciliation_next_at: null,
          reconciliation_deadline_at: null
        });

        const fallback = firstSnapshot.rows.find(
          ({ attempt_id }) => attempt_id === fallbackAttemptId
        )!;
        expect(fallback).toMatchObject({
          order_no: "LEGACYREALPAY003",
          provider_order_no: "LEGACYREALPAY003",
          origin: "legacy_order_no",
          canonical_attempt_id: fallbackAttemptId,
          provider_identity_role: "canonical_owner"
        });

        const stale = firstSnapshot.rows.find(
          ({ attempt_id }) => attempt_id === staleAttemptId
        )!;
        const active = firstSnapshot.rows.find(
          ({ attempt_id }) => attempt_id === activeAttemptId
        )!;
        const reconciliation = firstSnapshot.rows.find(
          ({ attempt_id }) => attempt_id === reconciliationAttemptId
        )!;
        expect(reconciliation.provider_payment_order_id).toBe(
          stale.provider_payment_order_id
        );
        expect(reconciliation.provider_payment_order_id).toBe(
          active.provider_payment_order_id
        );
        expect(reconciliation).toMatchObject({
          provider_order_no: "WXLEGACYACTIVE004",
          canonical_attempt_id: reconciliationAttemptId,
          provider_identity_role: "canonical_owner",
          provider_operation_eligible: true,
          reconciliation_state: "REQUIRED"
        });
        expect(reconciliation.reconciliation_next_at).toBeInstanceOf(Date);
        expect(reconciliation.reconciliation_deadline_at).toBeInstanceOf(Date);
        expect(reconciliation.allocated_at.toISOString()).toBe(
          reconciliation.attempt_created_at.toISOString()
        );
        expect(stale).toMatchObject({
          canonical_attempt_id: reconciliationAttemptId,
          provider_identity_role: "audit_alias",
          provider_operation_eligible: false,
          status: "CLOSED",
          reconciliation_state: "TERMINAL",
          reconciliation_last_result: "LEGACY_PROVIDER_IDENTITY_ALIAS",
          reconciliation_next_at: null,
          reconciliation_deadline_at: null
        });
        expect(active).toMatchObject({
          canonical_attempt_id: reconciliationAttemptId,
          provider_identity_role: "audit_alias",
          provider_operation_eligible: false,
          status: "CLOSED",
          reconciliation_state: "TERMINAL",
          reconciliation_last_result: "LEGACY_PROVIDER_IDENTITY_ALIAS",
          reconciliation_next_at: null,
          reconciliation_deadline_at: null
        });

        const dualField = firstSnapshot.rows.find(
          ({ attempt_id }) => attempt_id === dualFieldAttemptId
        )!;
        expect(dualField).toMatchObject({
          provider_order_no: "ALMATCHINGDUAL007",
          origin: "legacy_order_no",
          canonical_attempt_id: dualFieldAttemptId,
          provider_identity_role: "canonical_owner",
          provider_operation_eligible: true,
          status: "CREATE_UNKNOWN"
        });

        const fakePaid = firstSnapshot.rows.find(
          ({ attempt_id }) => attempt_id === fakePaidAttemptId
        )!;
        expect(fakePaid).toMatchObject({
          provider_order_no: "FAKELEGACYPAID005",
          origin: "legacy_order_no",
          canonical_attempt_id: fakePaidAttemptId,
          provider_identity_role: "canonical_owner",
          provider_operation_eligible: false,
          manual_review_required: false,
          status: "SUCCEEDED"
        });
        const preservedFacts = await client.query<{
          transaction_count: string;
          entitlement_count: string;
        }>(
          `SELECT
             (SELECT count(*)::text
                FROM payment_transactions
               WHERE id = (
                 SELECT id
                   FROM payment_transactions
                  WHERE payment_attempt_id = $1
               )) AS transaction_count,
             (SELECT count(*)::text
                FROM entitlements
               WHERE id = $2) AS entitlement_count`,
          [fakePaidAttemptId, fakeEntitlement.rows[0].id]
        );
        expect(preservedFacts.rows).toEqual([
          { transaction_count: "1", entitlement_count: "1" }
        ]);

        const fakePending = firstSnapshot.rows.find(
          ({ attempt_id }) => attempt_id === fakePendingAttemptId
        )!;
        expect(fakePending).toMatchObject({
          provider_order_no: "FAKELEGACYPENDING006",
          origin: "legacy_order_no",
          canonical_attempt_id: fakePendingAttemptId,
          provider_identity_role: "canonical_owner",
          provider_operation_eligible: false,
          manual_review_required: true,
          status: "CLOSED",
          reconciliation_state: "TERMINAL",
          reconciliation_last_result: "LEGACY_FAKE_REQUIRES_MANUAL_REVIEW",
          reconciliation_next_at: null,
          reconciliation_deadline_at: null
        });

        const migratedRefunds = await client.query<{
          id: string;
          refund_no: string;
          provider_refund_no: string;
          payment_attempt_id: string;
          payment_transaction_id: string;
          status: string;
          failure_code: string | null;
          provider_operation_eligible: boolean;
        }>(
          `SELECT id,
                  refund_no,
                  provider_refund_no,
                  payment_attempt_id,
                  payment_transaction_id,
                  status,
                  failure_code,
                  provider_operation_eligible
             FROM refunds
            WHERE id = ANY($1::uuid[])
            ORDER BY refund_no`,
          [[
            realLegacyRefund.rows[0].id,
            fakeLegacyRefund.rows[0].id,
            fakePendingLegacyRefund.rows[0].id,
            fakeProcessingLegacyRefund.rows[0].id
          ]]
        );
        expect(migratedRefunds.rows).toEqual([
          {
            id: fakeLegacyRefund.rows[0].id,
            refund_no: "LEGACY-FAKE-REFUND-005",
            provider_refund_no: "LEGACY-FAKE-REFUND-005",
            payment_attempt_id: fakePaidAttemptId,
            payment_transaction_id: fakeSuccessfulTransaction.rows[0].id,
            status: "SUCCEEDED",
            failure_code: null,
            provider_operation_eligible: false
          },
          {
            id: fakePendingLegacyRefund.rows[0].id,
            refund_no: "LEGACY-FAKE-REFUND-PENDING-005",
            provider_refund_no: "LEGACY-FAKE-REFUND-PENDING-005",
            payment_attempt_id: fakePaidAttemptId,
            payment_transaction_id: fakeSuccessfulTransaction.rows[0].id,
            status: "FAILED",
            failure_code: "LEGACY_FAKE_REQUIRES_MANUAL_REVIEW",
            provider_operation_eligible: false
          },
          {
            id: fakeProcessingLegacyRefund.rows[0].id,
            refund_no: "LEGACY-FAKE-REFUND-PROCESSING-005",
            provider_refund_no: "LEGACY-FAKE-REFUND-PROCESSING-005",
            payment_attempt_id: fakePaidAttemptId,
            payment_transaction_id: fakeSuccessfulTransaction.rows[0].id,
            status: "FAILED",
            failure_code: "LEGACY_FAKE_REQUIRES_MANUAL_REVIEW",
            provider_operation_eligible: false
          },
          {
            id: realLegacyRefund.rows[0].id,
            refund_no: "LEGACY-REAL-REFUND-002",
            provider_refund_no: "LEGACY-REAL-REFUND-002",
            payment_attempt_id: successfulAttemptId,
            payment_transaction_id: successfulTransaction.rows[0].id,
            status: "SUCCEEDED",
            failure_code: null,
            provider_operation_eligible: false
          }
        ]);
        const fakeSuccessfulRefundAfter = await client.query<{
          row: Record<string, unknown>;
        }>(
          `SELECT to_jsonb(r) - ARRAY[
                    'provider_refund_no',
                    'payment_attempt_id',
                    'payment_transaction_id',
                    'request_snapshot',
                    'failure_code',
                    'failure_message',
                    'succeeded_at',
                    'provider_operation_eligible'
                  ]::text[] AS row
             FROM refunds r
            WHERE id = $1`,
          [fakeLegacyRefund.rows[0].id]
        );
        expect(fakeSuccessfulRefundAfter.rows).toEqual(
          fakeSuccessfulRefundBefore.rows
        );

        const claimableAliasesOrFake = await client.query<{ id: string }>(
          `SELECT pa.id
             FROM payment_attempts pa
             JOIN provider_payment_orders ppo
               ON ppo.id = pa.provider_payment_order_id
            WHERE (
                pa.provider_identity_role = 'audit_alias'
                OR ppo.channel = 'fake'
              )
              AND (
                pa.provider_operation_eligible
                OR pa.reconciliation_state IN ('REQUIRED', 'RETRY_SCHEDULED')
                OR pa.reconciliation_next_at IS NOT NULL
                OR pa.reconciliation_deadline_at IS NOT NULL
              )`
        );
        expect(claimableAliasesOrFake.rows).toEqual([]);

        await expect(
          client.query(
            `UPDATE payment_attempts
                SET status = 'CREATED',
                    request_snapshot = jsonb_build_object(
                      'orderNo', $2::text,
                      'amountFen', '100',
                      'currency', 'CNY',
                      'generation', 'legacy-writer'
                    ),
                    error_code = NULL,
                    error_message = NULL,
                    updated_at = now()
              WHERE id = $1`,
            [exactAttemptId, "LEGACYREALPAY001"]
          )
        ).rejects.toMatchObject({ code: "23514" });

        const identityAwareUpdate = await client.query("BEGIN");
        expect(identityAwareUpdate.command).toBe("BEGIN");
        try {
          await client.query(
            "SET LOCAL peileme.payment_write_contract = 'identity_v1'"
          );
          const updated = await client.query(
            `UPDATE payment_attempts
                SET request_snapshot = jsonb_build_object(
                      'providerOrderNo', $2::text,
                      'orderNo', $2::text,
                      'amountFen', '100',
                      'currency', 'CNY',
                      'generation', 'identity-aware-writer'
                    ),
                    updated_at = now()
              WHERE id = $1`,
            [exactAttemptId, "WXLEGACYEXACT001"]
          );
          expect(updated.rowCount).toBe(1);
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        }
        await expect(
          client.query(
            `UPDATE payment_attempts
                SET status = 'CLOSED',
                    reconciliation_state = 'REQUIRED',
                    reconciliation_next_at = now() + interval '30 seconds',
                    reconciliation_deadline_at = now() + interval '1 day',
                    reconciliation_last_result = 'LOCAL_CLOSE_PENDING_FINAL_QUERY',
                    updated_at = now()
              WHERE id = $1`,
            [exactAttemptId]
          )
        ).rejects.toMatchObject({ code: "23514" });
        await client.query("BEGIN");
        try {
          await client.query(
            "SET LOCAL peileme.payment_write_contract = 'identity_v1'"
          );
          await expect(
            client.query(
              `UPDATE payment_attempts
                  SET request_snapshot = jsonb_build_object(
                        'providerOrderNo', 'WXMISMATCHEDIDENTITY',
                        'orderNo', 'WXMISMATCHEDIDENTITY'
                      ),
                      updated_at = now()
                WHERE id = $1`,
              [exactAttemptId]
            )
          ).rejects.toMatchObject({ code: "23514" });
        } finally {
          await client.query("ROLLBACK");
        }

        const secondRun = await runMigrationProcess(databaseUrl);
        expect(
          secondRun.status,
          `${secondRun.stdout}\n${secondRun.stderr}`
        ).toBe(0);
        const secondSnapshot = await client.query(
          `SELECT pa.id AS attempt_id,
                  ppo.id AS provider_payment_order_id,
                  ppo.provider_order_no,
                  ppo.origin,
                  ppo.allocated_at,
                  ppo.canonical_attempt_id,
                  pa.provider_identity_role,
                  pa.provider_operation_eligible,
                  ppo.manual_review_required,
                  pa.status,
                  pa.reconciliation_state,
                  pa.reconciliation_last_result,
                  pa.reconciliation_next_at,
                  pa.reconciliation_deadline_at
             FROM payment_attempts pa
             JOIN provider_payment_orders ppo
               ON ppo.id = pa.provider_payment_order_id
            ORDER BY pa.id`
        );
        expect(secondSnapshot.rows).toEqual(
          firstSnapshot.rows.map(
            ({ order_no: _orderNo, attempt_created_at: _createdAt, ...row }) =>
              row
          )
        );
      });
    },
    30_000
  );

  it.each([
    {
      name: "conflicting providerOrderNo and orderNo evidence",
      expectedConflictCode: "PROVIDER_PAYMENT_ORDER_MIGRATION_CONFLICT",
      seed: async (client: pg.Client) => {
        const userId = await createLegacyUser(client, "source-conflict");
        const orderId = await createLegacyOrder(
          client,
          userId,
          "LEGACYCONFLICT001"
        );
        const attemptId = await createLegacyAttempt(client, {
          orderId,
          channel: "wechat_h5",
          status: "PENDING",
          requestSnapshot: {
            providerOrderNo: "WXCONFLICTSOURCEA",
            orderNo: "WXCONFLICTSOURCEB"
          }
        });
        return {
          expectedDiagnosticIds: {
            orderIds: [orderId],
            attemptIds: [attemptId],
            transactionIds: [],
            refundIds: []
          }
        };
      }
    },
    {
      name: "different attempt evidence for one order and channel",
      expectedConflictCode: "PROVIDER_PAYMENT_ORDER_MIGRATION_CONFLICT",
      seed: async (client: pg.Client) => {
        const userId = await createLegacyUser(client, "attempt-conflict");
        const orderId = await createLegacyOrder(
          client,
          userId,
          "LEGACYCONFLICT002"
        );
        const firstAttemptId = await createLegacyAttempt(client, {
          orderId,
          channel: "alipay_wap",
          status: "FAILED",
          requestSnapshot: { providerOrderNo: "ALCONFLICTA" }
        });
        const secondAttemptId = await createLegacyAttempt(client, {
          orderId,
          channel: "alipay_wap",
          status: "PENDING",
          requestSnapshot: { providerOrderNo: "ALCONFLICTB" }
        });
        return {
          expectedDiagnosticIds: {
            orderIds: [orderId],
            attemptIds: [firstAttemptId, secondAttemptId],
            transactionIds: [],
            refundIds: []
          }
        };
      }
    },
    {
      name: "multiple SUCCESS transactions for one identity",
      expectedConflictCode: "PROVIDER_PAYMENT_ORDER_MIGRATION_CONFLICT",
      seed: async (client: pg.Client) => {
        const userId = await createLegacyUser(client, "success-conflict");
        const orderId = await createLegacyOrder(
          client,
          userId,
          "LEGACYCONFLICT003",
          "PAID"
        );
        const attemptIds: string[] = [];
        const transactionIds: string[] = [];
        for (const suffix of ["A", "B"]) {
          const attemptId = await createLegacyAttempt(client, {
            orderId,
            channel: "wechat_h5",
            status: "SUCCEEDED",
            requestSnapshot: { providerOrderNo: "WXSHAREDSUCCESS003" }
          });
          attemptIds.push(attemptId);
          const transaction = await client.query<{ id: string }>(
            `INSERT INTO payment_transactions(
               order_id,
               payment_attempt_id,
               channel,
               channel_transaction_id,
               amount_fen,
               currency,
               status,
               verified_payload,
               paid_at
             )
             VALUES ($1, $2, 'wechat_h5', $3, 100, 'CNY', 'SUCCESS', '{}'::jsonb, now())
             RETURNING id`,
            [orderId, attemptId, `WX-TXN-CONFLICT-${suffix}`]
          );
          transactionIds.push(transaction.rows[0].id);
        }
        return {
          expectedDiagnosticIds: {
            orderIds: [orderId],
            attemptIds,
            transactionIds,
            refundIds: []
          }
        };
      }
    },
    {
      name: "one provider identity shared across different orders",
      expectedConflictCode: "PROVIDER_PAYMENT_ORDER_MIGRATION_CONFLICT",
      seed: async (client: pg.Client) => {
        const userId = await createLegacyUser(client, "cross-order-conflict");
        const orderIds: string[] = [];
        const attemptIds: string[] = [];
        for (const suffix of ["A", "B"]) {
          const orderId = await createLegacyOrder(
            client,
            userId,
            `LEGACYCROSSORDER${suffix}`
          );
          orderIds.push(orderId);
          attemptIds.push(await createLegacyAttempt(client, {
            orderId,
            channel: "alipay_wap",
            status: "PENDING",
            requestSnapshot: { providerOrderNo: "ALSHAREDCROSSORDER" }
          }));
        }
        return {
          expectedDiagnosticIds: {
            orderIds,
            attemptIds,
            transactionIds: [],
            refundIds: []
          }
        };
      }
    },
    {
      name: "wechat and Alipay are both pending for one order",
      expectedConflictCode: "MULTI_ACTIVE_PAYMENT_MIGRATION_CONFLICT",
      seed: async (client: pg.Client) => {
        const userId = await createLegacyUser(client, "multi-active-pending");
        const orderId = await createLegacyOrder(
          client,
          userId,
          "LEGACYMULTIACTIVE001"
        );
        const wechatAttemptId = await createLegacyAttempt(client, {
          orderId,
          channel: "wechat_h5",
          status: "PENDING",
          requestSnapshot: { orderNo: "WXMULTIACTIVE001" }
        });
        const alipayAttemptId = await createLegacyAttempt(client, {
          orderId,
          channel: "alipay_wap",
          status: "PENDING",
          requestSnapshot: { orderNo: "ALMULTIACTIVE001" }
        });
        return {
          expectedDiagnosticIds: {
            orderIds: [orderId],
            attemptIds: [wechatAttemptId, alipayAttemptId],
            transactionIds: [],
            refundIds: []
          }
        };
      }
    },
    {
      name: "one pending channel and one reconciliation channel coexist",
      expectedConflictCode: "MULTI_ACTIVE_PAYMENT_MIGRATION_CONFLICT",
      seed: async (client: pg.Client) => {
        const userId = await createLegacyUser(client, "multi-active-recon");
        const orderId = await createLegacyOrder(
          client,
          userId,
          "LEGACYMULTIACTIVE002"
        );
        const pendingId = await createLegacyAttempt(client, {
          orderId,
          channel: "wechat_h5",
          status: "PENDING",
          requestSnapshot: { orderNo: "WXMULTIACTIVE002" }
        });
        const reconciliationId = await createLegacyAttempt(client, {
          orderId,
          channel: "alipay_wap",
          status: "CLOSED",
          requestSnapshot: { orderNo: "ALMULTIACTIVE002" }
        });
        await client.query(
          `UPDATE payment_attempts
              SET reconciliation_state = 'REQUIRED',
                  reconciliation_next_at = now() + interval '1 minute',
                  reconciliation_deadline_at = now() + interval '1 day',
                  reconciliation_last_result = 'LOCAL_CLOSE_PENDING_FINAL_QUERY'
            WHERE id = $1`,
          [reconciliationId]
        );
        return {
          expectedDiagnosticIds: {
            orderIds: [orderId],
            attemptIds: [pendingId, reconciliationId],
            transactionIds: [],
            refundIds: []
          }
        };
      }
    },
    {
      name: "an uncertain real FAILED attempt and another pending channel coexist",
      expectedConflictCode: "MULTI_ACTIVE_PAYMENT_MIGRATION_CONFLICT",
      seed: async (client: pg.Client) => {
        const userId = await createLegacyUser(client, "multi-active-failed");
        const orderId = await createLegacyOrder(
          client,
          userId,
          "LEGACYMULTIACTIVE003",
          "PAYMENT_FAILED"
        );
        const failedAttemptId = await createLegacyAttempt(client, {
          orderId,
          channel: "wechat_h5",
          status: "FAILED",
          requestSnapshot: { orderNo: "WXMULTIACTIVE003" },
          errorCode: "PAYMENT_PROVIDER_TIMEOUT"
        });
        const pendingAttemptId = await createLegacyAttempt(client, {
          orderId,
          channel: "alipay_wap",
          status: "PENDING",
          requestSnapshot: { orderNo: "ALMULTIACTIVE003" }
        });
        return {
          expectedDiagnosticIds: {
            orderIds: [orderId],
            attemptIds: [failedAttemptId, pendingAttemptId],
            transactionIds: [],
            refundIds: []
          }
        };
      }
    },
    {
      name: "a legacy refund has no SUCCESS transaction",
      expectedConflictCode: "LEGACY_REFUND_MIGRATION_CONFLICT",
      seed: async (client: pg.Client) => {
        const userId = await createLegacyUser(client, "refund-zero-success");
        const orderId = await createLegacyOrder(
          client,
          userId,
          "LEGACYREFUNDCONFLICT001"
        );
        const attemptId = await createLegacyAttempt(client, {
          orderId,
          channel: "wechat_h5",
          status: "CLOSED",
          requestSnapshot: { orderNo: "WXREFUNDCONFLICT001" }
        });
        const refundId = await createLegacyRefund(client, {
          orderId,
          channel: "wechat_h5",
          refundNo: "LEGACY-REFUND-ZERO-SUCCESS"
        });
        return {
          expectedDiagnosticIds: {
            orderIds: [orderId],
            attemptIds: [attemptId],
            transactionIds: [],
            refundIds: [refundId]
          }
        };
      }
    },
    {
      name: "a legacy refund has multiple SUCCESS transactions",
      expectedConflictCode: "LEGACY_REFUND_MIGRATION_CONFLICT",
      seed: async (client: pg.Client) => {
        const userId = await createLegacyUser(client, "refund-multi-success");
        const orderId = await createLegacyOrder(
          client,
          userId,
          "LEGACYREFUNDCONFLICT002",
          "PAID"
        );
        const attemptId = await createLegacyAttempt(client, {
          orderId,
          channel: "alipay_wap",
          status: "SUCCEEDED",
          requestSnapshot: { orderNo: "ALREFUNDCONFLICT002" }
        });
        const transactionIds: string[] = [];
        for (const suffix of ["A", "B"]) {
          const transaction = await client.query<{ id: string }>(
            `INSERT INTO payment_transactions(
               order_id,
               payment_attempt_id,
               channel,
               channel_transaction_id,
               amount_fen,
               currency,
               status,
               verified_payload,
               paid_at
             )
             VALUES ($1, $2, 'alipay_wap', $3, 100, 'CNY', 'SUCCESS', '{}'::jsonb, now())
             RETURNING id`,
            [orderId, attemptId, `AL-REFUND-CONFLICT-${suffix}`]
          );
          transactionIds.push(transaction.rows[0].id);
        }
        const refundId = await createLegacyRefund(client, {
          orderId,
          channel: "alipay_wap",
          refundNo: "LEGACY-REFUND-MULTI-SUCCESS"
        });
        return {
          expectedDiagnosticIds: {
            orderIds: [orderId],
            attemptIds: [attemptId],
            transactionIds,
            refundIds: [refundId]
          }
        };
      }
    },
    {
      name: "a legacy refund SUCCESS transaction has no attempt",
      expectedConflictCode: "LEGACY_REFUND_MIGRATION_CONFLICT",
      seed: async (client: pg.Client) => {
        const userId = await createLegacyUser(client, "refund-null-attempt");
        const orderId = await createLegacyOrder(
          client,
          userId,
          "LEGACYREFUNDCONFLICT003",
          "PAID"
        );
        const closedAttemptId = await createLegacyAttempt(client, {
          orderId,
          channel: "wechat_h5",
          status: "CLOSED",
          requestSnapshot: { orderNo: "WXREFUNDCONFLICT003" }
        });
        const transaction = await client.query<{ id: string }>(
          `INSERT INTO payment_transactions(
             order_id,
             payment_attempt_id,
             channel,
             channel_transaction_id,
             amount_fen,
             currency,
             status,
             verified_payload,
             paid_at
           )
           VALUES ($1, NULL, 'wechat_h5', 'WX-REFUND-NULL-ATTEMPT', 100, 'CNY', 'SUCCESS', '{}'::jsonb, now())
           RETURNING id`,
          [orderId]
        );
        const refundId = await createLegacyRefund(client, {
          orderId,
          channel: "wechat_h5",
          refundNo: "LEGACY-REFUND-NULL-ATTEMPT"
        });
        return {
          expectedDiagnosticIds: {
            orderIds: [orderId],
            attemptIds: [closedAttemptId],
            transactionIds: [transaction.rows[0].id],
            refundIds: [refundId]
          }
        };
      }
    },
    {
      name: "a legacy refund transaction points at an inconsistent attempt",
      expectedConflictCode: "LEGACY_REFUND_MIGRATION_CONFLICT",
      seed: async (client: pg.Client) => {
        const userId = await createLegacyUser(client, "refund-inconsistent");
        const refundOrderId = await createLegacyOrder(
          client,
          userId,
          "LEGACYREFUNDCONFLICT004",
          "PAID"
        );
        const refundOrderAttemptId = await createLegacyAttempt(client, {
          orderId: refundOrderId,
          channel: "wechat_h5",
          status: "CLOSED",
          requestSnapshot: { orderNo: "WXREFUNDCONFLICT004A" }
        });
        const otherOrderId = await createLegacyOrder(
          client,
          userId,
          "LEGACYREFUNDCONFLICT005",
          "PAID"
        );
        const otherAttemptId = await createLegacyAttempt(client, {
          orderId: otherOrderId,
          channel: "wechat_h5",
          status: "SUCCEEDED",
          requestSnapshot: { orderNo: "WXREFUNDCONFLICT004B" }
        });
        await client.query(
          "ALTER TABLE payment_transactions DROP CONSTRAINT payment_transactions_attempt_order_fk"
        );
        const transaction = await client.query<{ id: string }>(
          `INSERT INTO payment_transactions(
             order_id,
             payment_attempt_id,
             channel,
             channel_transaction_id,
             amount_fen,
             currency,
             status,
             verified_payload,
             paid_at
           )
           VALUES ($1, $2, 'wechat_h5', 'WX-REFUND-INCONSISTENT', 100, 'CNY', 'SUCCESS', '{}'::jsonb, now())
           RETURNING id`,
          [refundOrderId, otherAttemptId]
        );
        const refundId = await createLegacyRefund(client, {
          orderId: refundOrderId,
          channel: "wechat_h5",
          refundNo: "LEGACY-REFUND-INCONSISTENT"
        });
        return {
          expectedDiagnosticIds: {
            orderIds: [refundOrderId, otherOrderId],
            attemptIds: [refundOrderAttemptId, otherAttemptId],
            transactionIds: [transaction.rows[0].id],
            refundIds: [refundId]
          }
        };
      }
    }
  ])("fails migration for $name", async ({ seed, expectedConflictCode }) => {
    await withPre011Database(async (client, databaseUrl) => {
      const { expectedDiagnosticIds } = await seed(client);
      const attemptsBefore = await client.query(
        `SELECT to_jsonb(pa) AS row
           FROM payment_attempts pa
          ORDER BY pa.id`
      );
      const transactionsBefore = await client.query(
        `SELECT to_jsonb(pt) AS row
           FROM payment_transactions pt
          ORDER BY pt.id`
      );
      const refundsBefore = await client.query(
        `SELECT to_jsonb(r) AS row
           FROM refunds r
          ORDER BY r.id`
      );
      const migration = await runMigrationProcess(databaseUrl);
      expect(
        migration.status,
        `${migration.stdout}\n${migration.stderr}`
      ).not.toBe(0);
      const diagnosticPrefix = "PAYMENT_MIGRATION_DIAGNOSTIC ";
      const diagnosticLines = migration.stderr
        .split(/\r?\n/)
        .filter((line) => line.startsWith(diagnosticPrefix));
      expect(diagnosticLines).toHaveLength(1);
      const diagnostic = JSON.parse(
        diagnosticLines[0].slice(diagnosticPrefix.length)
      ) as Record<string, unknown> & {
        code: string;
        orderIds: string[];
        attemptIds: string[];
        transactionIds: string[];
        refundIds: string[];
      };
      const expectedDiagnostic = {
        code: expectedConflictCode,
        orderIds: [...new Set(expectedDiagnosticIds.orderIds)].sort(),
        attemptIds: [...new Set(expectedDiagnosticIds.attemptIds)].sort(),
        transactionIds: [
          ...new Set(expectedDiagnosticIds.transactionIds)
        ].sort(),
        refundIds: [...new Set(expectedDiagnosticIds.refundIds)].sort()
      };
      expect(diagnostic).toEqual(expectedDiagnostic);
      expect(diagnostic).not.toHaveProperty("identityIds");
      for (const category of [
        "orderIds",
        "attemptIds",
        "transactionIds",
        "refundIds"
      ] as const) {
        expect(diagnostic[category]).toEqual(
          [...new Set(diagnostic[category])].sort()
        );
      }
      const applied = await client.query<{ version: string }>(
        `SELECT version
           FROM schema_migrations
          WHERE version = '011_real_payments.sql'`
      );
      expect(applied.rows).toEqual([]);
      const schema = await client.query<{
        identity_table: string | null;
        identity_column_count: string;
        refund_identity_column_count: string;
      }>(
        `SELECT to_regclass('public.provider_payment_orders')::text
                  AS identity_table,
                (
                  SELECT count(*)::text
                    FROM information_schema.columns
                   WHERE table_schema = 'public'
                     AND table_name = 'payment_attempts'
                     AND column_name IN (
                       'provider_payment_order_id',
                       'provider_identity_role',
                       'provider_operation_eligible'
                     )
                ) AS identity_column_count,
                (
                  SELECT count(*)::text
                    FROM information_schema.columns
                   WHERE table_schema = 'public'
                     AND table_name = 'refunds'
                     AND column_name IN (
                       'provider_refund_no',
                       'payment_attempt_id',
                       'payment_transaction_id',
                       'provider_operation_eligible'
                     )
                ) AS refund_identity_column_count`
      );
      expect(schema.rows).toEqual([
        {
          identity_table: null,
          identity_column_count: "0",
          refund_identity_column_count: "0"
        }
      ]);
      const attemptsAfter = await client.query(
        `SELECT to_jsonb(pa) AS row
           FROM payment_attempts pa
          ORDER BY pa.id`
      );
      const transactionsAfter = await client.query(
        `SELECT to_jsonb(pt) AS row
           FROM payment_transactions pt
          ORDER BY pt.id`
      );
      const refundsAfter = await client.query(
        `SELECT to_jsonb(r) AS row
           FROM refunds r
          ORDER BY r.id`
      );
      expect(attemptsAfter.rows).toEqual(attemptsBefore.rows);
      expect(transactionsAfter.rows).toEqual(transactionsBefore.rows);
      expect(refundsAfter.rows).toEqual(refundsBefore.rows);
    });
  }, 30_000);
});
