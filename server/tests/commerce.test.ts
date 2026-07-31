import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import request from "supertest";
import { createApp } from "../app.js";
import { resetConfigForTests } from "../config.js";
import { closePool, getPool, query, withTransaction } from "../db.js";
import { runMigrations } from "../migrate.js";
import {
  getActiveCatalog,
  getEffectivePrice,
  getProductBySku
} from "../modules/commerce/catalog.js";
import {
  consumeEntitlement,
  getAvailableEntitlements,
  releaseEntitlement,
  reserveEntitlement
} from "../modules/commerce/entitlements.js";
import {
  closeExpiredOrders,
  createInvoiceRequest,
  createOrder,
  fulfillOrder,
  getOwnedOrder,
  listOwnedOrders,
  markOrderPaid,
  reconcileAndCloseExpiredOrders,
  startPayment
} from "../modules/commerce/orders.js";
import { seedPolicyFoundation } from "../modules/policy/seed.js";
import { enableIdentityPaymentWrites } from "../modules/payments/write-contract.js";
import { signAccessToken } from "../security.js";
import {
  insertIdentityAwarePaymentAttempt,
  paymentWriteQuery,
  ScriptedRealPaymentProvider
} from "./helpers/identity-payment.js";

const { Client } = pg;

type CatalogRow = {
  sku: string;
  product_channel: string;
  fulfillment_type: string;
  status: string;
  entitlement_policy: unknown;
  amount_fen: string;
  currency: string;
};

const createEntitlementTestUser = async (verified: boolean) => {
  const marker = randomUUID().replaceAll("-", "");
  const user = await query<{ id: string }>(
    `INSERT INTO users(email, email_verified_at)
     VALUES ($1, CASE WHEN $2 THEN now() ELSE NULL END)
     RETURNING id`,
    [`task2-${marker}@peileme.test`, verified]
  );
  return user.rows[0].id;
};

const cleanupEntitlementTestUsers = async (userIds: string[]) => {
  if (userIds.length === 0) return;
  await query(
    "DELETE FROM entitlement_usages WHERE user_id = ANY($1::uuid[])",
    [userIds]
  );
  await query(
    "DELETE FROM admin_audit_logs WHERE admin_user_id = ANY($1::uuid[])",
    [userIds]
  );
  await query("DELETE FROM entitlements WHERE user_id = ANY($1::uuid[])", [
    userIds
  ]);
  await query(
    `DELETE FROM payment_transactions
      WHERE order_id IN (
        SELECT id FROM orders WHERE user_id = ANY($1::uuid[])
      )`,
    [userIds]
  );
  await query("DELETE FROM invoice_requests WHERE user_id = ANY($1::uuid[])", [
    userIds
  ]);
  await query("DELETE FROM orders WHERE user_id = ANY($1::uuid[])", [userIds]);
  await query("DELETE FROM assessments WHERE user_id = ANY($1::uuid[])", [
    userIds
  ]);
  await query("DELETE FROM users WHERE id = ANY($1::uuid[])", [userIds]);
};

const insertAdminEntitlement = async (
  userId: string,
  sku: string,
  totalUses: number
) => {
  const entitlement = await query<{ id: string }>(
    `INSERT INTO entitlements(
       user_id,
       product_id,
       source_type,
       total_uses,
       remaining_uses,
       status
     )
     SELECT $1, id, 'admin', $3, $3, 'active'
       FROM products
      WHERE sku = $2
     RETURNING id`,
    [userId, sku, totalUses]
  );
  return entitlement.rows[0].id;
};

const insertPolicyDraft = async (
  userId: string,
  channel: "main" | "ai" = "main"
) => {
  const draft = await query<{ id: string }>(
    `INSERT INTO assessments(
       user_id,
       visitor_id,
       session_id,
       status,
       current_step,
       answers,
       product_channel,
       input_snapshot
     )
     VALUES (
       $1,
       'visitor_commerce_test',
       'session_commerce_test',
       'in_progress',
       'awaiting_entitlement',
       '{"facts":{}}'::jsonb,
       $2,
       '{}'::jsonb
     )
     RETURNING id`,
    [userId, channel]
  );
  return draft.rows[0].id;
};

const createFailedPaymentOrder = async (
  userId: string,
  marker: string,
  channel: "wechat_h5" | "alipay_wap" = "wechat_h5"
) => {
  const order = await createOrder({
    userId,
    sku: "POLICY_CALC",
    channel: "main",
    idempotencyKey: `${marker}-${randomUUID()}`,
    businessDraftId: await insertPolicyDraft(userId)
  });
  const attempt = await insertIdentityAwarePaymentAttempt({
    orderId: order.id,
    channel,
    status: "CREATE_UNKNOWN"
  });
  await query(
    "UPDATE orders SET status = 'PAYING' WHERE id = $1",
    [order.id]
  );
  return {
    order,
    attemptId: attempt.id,
    providerOrderNo: attempt.providerOrderNo
  };
};

const createScheduledClosedPaymentOrder = async (
  userId: string,
  marker: string
) => {
  const failed = await createFailedPaymentOrder(userId, marker);
  await paymentWriteQuery(
    `UPDATE orders
     SET status = 'CLOSED',
         created_at = now() - interval '3 minutes',
         expires_at = now() - interval '1 minute',
         closed_at = now(),
         updated_at = now()
     WHERE id = $1`,
    [failed.order.id]
  );
  await paymentWriteQuery(
    `UPDATE payment_attempts
     SET status = 'CLOSED',
         reconciliation_state = 'REQUIRED',
         reconciliation_attempt_count = 0,
         reconciliation_next_at = now() - interval '1 second',
         reconciliation_deadline_at = now() + interval '24 hours',
         reconciliation_last_result =
           'LOCAL_CLOSE_PENDING_FINAL_QUERY',
         updated_at = now()
     WHERE id = $1`,
    [failed.attemptId]
  );
  return failed;
};

const paymentProviderWithResponse = (response: Record<string, unknown>) => ({
  channel: "wechat_h5" as const,
  async createPayment(input: { providerOrderNo: string }) {
    return {
      prepayId: `evidence-${input.providerOrderNo}`,
      launchUrl: `https://payments.test/evidence/${input.providerOrderNo}`,
      launchExpiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      response
    };
  },
  async queryPayment() {
    return null;
  },
  async refund() {
    return { channelRefundId: "unused", raw: {} };
  }
});

const emptyClosedRecoverySummary = () => ({
  scannedCount: 0,
  recoveredCount: 0,
  retryScheduledCount: 0,
  terminalCount: 0,
  changedStateCount: 0,
  retryByReason: {
    noPayment: 0,
    queryError: 0
  },
  terminalByReason: {
    deadlineExceeded: 0,
    noPaymentLimitExceeded: 0,
    paymentAfterExpiry: 0,
    paymentVerificationFailed: 0
  }
});

beforeAll(async () => {
  await runMigrations();
});

afterAll(async () => {
  await closePool();
});

describe("commerce catalog foundation", () => {
  it("seeds the three site-scoped per-use products and their default prices", async () => {
    await seedPolicyFoundation();
    const result = await query<CatalogRow>(
      `SELECT
         p.sku,
         p.product_channel,
         p.fulfillment_type,
         p.status,
         p.entitlement_policy,
         pp.amount_fen,
         pp.currency
         FROM products p
         JOIN product_prices pp ON pp.product_id = p.id
        WHERE pp.effective_to IS NULL
        ORDER BY p.sku`
    );

    expect(result.rows).toEqual([
      {
        sku: "AI_DOCUMENT_REVIEW",
        product_channel: "ai",
        fulfillment_type: "document_review",
        status: "active",
        entitlement_policy: { grantCount: 1 },
        amount_fen: "2990",
        currency: "CNY"
      },
      {
        sku: "AI_SEVERANCE_ANALYSIS",
        product_channel: "ai",
        fulfillment_type: "ai_analysis",
        status: "active",
        entitlement_policy: { grantCount: 1 },
        amount_fen: "3990",
        currency: "CNY"
      },
      {
        sku: "POLICY_CALC",
        product_channel: "main",
        fulfillment_type: "policy_calculation",
        status: "active",
        entitlement_policy: { grantCount: 1 },
        amount_fen: "990",
        currency: "CNY"
      }
    ]);
  });

  it("seeds the first verified policy-use promotion exactly once", async () => {
    await seedPolicyFoundation();
    const promotion = await query<{
      code: string;
      sku: string;
      grant_count: number;
      trigger_type: string;
      status: string;
    }>(
      `SELECT
         pr.code,
         p.sku,
         pr.grant_count,
         pr.trigger_type,
         pr.status
       FROM promotion_rules pr
       JOIN products p ON p.id = pr.product_id
       ORDER BY pr.code`
    );

    expect(promotion.rows).toEqual([
      {
        code: "FIRST_POLICY_CALC",
        sku: "POLICY_CALC",
        grant_count: 1,
        trigger_type: "first_verified_user",
        status: "active"
      }
    ]);
  });

  it("keeps catalog rows unique under repeated and concurrent seeds", async () => {
    await seedPolicyFoundation();
    await seedPolicyFoundation();
    await Promise.all(Array.from({ length: 6 }, () => seedPolicyFoundation()));

    const counts = await query<{
      products: string;
      open_prices: string;
      promotions: string;
    }>(
      `SELECT
         (SELECT count(*)::text FROM products) AS products,
         (
           SELECT count(*)::text
             FROM product_prices
            WHERE effective_to IS NULL
         ) AS open_prices,
         (SELECT count(*)::text FROM promotion_rules) AS promotions`
    );
    expect(counts.rows[0]).toEqual({
      products: "3",
      open_prices: "3",
      promotions: "1"
    });
  });

  it("preserves an existing open price when the seed is rerun", async () => {
    await seedPolicyFoundation();
    try {
      await query(
        `UPDATE product_prices
            SET amount_fen = 1090
          WHERE product_id = (
            SELECT id FROM products WHERE sku = 'POLICY_CALC'
          )
            AND effective_to IS NULL`
      );

      await seedPolicyFoundation();
      const price = await query<{ amount_fen: string }>(
        `SELECT pp.amount_fen
           FROM product_prices pp
           JOIN products p ON p.id = pp.product_id
          WHERE p.sku = 'POLICY_CALC'
            AND pp.effective_to IS NULL`
      );
      expect(price.rows).toEqual([{ amount_fen: "1090" }]);
    } finally {
      await query(
        `UPDATE product_prices
            SET amount_fen = 990
          WHERE product_id = (
            SELECT id FROM products WHERE sku = 'POLICY_CALC'
          )
            AND effective_to IS NULL`
      );
    }
  });

  it("preserves an administrator-disabled product when the seed is rerun", async () => {
    await seedPolicyFoundation();
    try {
      await query(
        `UPDATE products
            SET status = 'inactive'
          WHERE sku = 'AI_DOCUMENT_REVIEW'`
      );

      await seedPolicyFoundation();
      const product = await query<{ status: string }>(
        `SELECT status
           FROM products
          WHERE sku = 'AI_DOCUMENT_REVIEW'`
      );
      expect(product.rows).toEqual([{ status: "inactive" }]);
    } finally {
      await query(
        `UPDATE products
            SET status = 'active'
          WHERE sku = 'AI_DOCUMENT_REVIEW'`
      );
    }
  });

  it("preserves administrator-configured product fields when the seed is rerun", async () => {
    await seedPolicyFoundation();
    try {
      await query(
        `UPDATE products
            SET name = '后台自定义文件审查',
                description = '后台配置的商品说明',
                status = 'inactive',
                entitlement_policy = '{"grantCount":3,"expiresInDays":30}'::jsonb,
                updated_at = TIMESTAMPTZ '2026-01-02 03:04:05+08'
          WHERE sku = 'AI_DOCUMENT_REVIEW'`
      );
      const before = await query<{
        name: string;
        description: string;
        status: string;
        entitlement_policy: unknown;
        updated_at: string;
      }>(
        `SELECT
           name,
           description,
           status,
           entitlement_policy,
           updated_at::text
         FROM products
         WHERE sku = 'AI_DOCUMENT_REVIEW'`
      );

      await seedPolicyFoundation();

      const after = await query<{
        name: string;
        description: string;
        status: string;
        entitlement_policy: unknown;
        updated_at: string;
      }>(
        `SELECT
           name,
           description,
           status,
           entitlement_policy,
           updated_at::text
         FROM products
         WHERE sku = 'AI_DOCUMENT_REVIEW'`
      );
      expect(after.rows).toEqual(before.rows);
    } finally {
      await query(
        `UPDATE products
            SET name = 'AI 劳动文件审查',
                description = '劳动文件签署与风险分析单次使用权益',
                status = 'active',
                entitlement_policy = '{"grantCount":1}'::jsonb,
                updated_at = now()
          WHERE sku = 'AI_DOCUMENT_REVIEW'`
      );
    }
  });

  it("enforces the fixed channel and fulfillment mapping for seeded SKUs", async () => {
    await seedPolicyFoundation();
    try {
      for (const [sku, channel, fulfillmentType] of [
        ["POLICY_CALC", "ai", "policy_calculation"],
        ["AI_SEVERANCE_ANALYSIS", "main", "ai_analysis"],
        ["AI_DOCUMENT_REVIEW", "ai", "ai_analysis"]
      ]) {
        await expect(
          query(
            `UPDATE products
                SET product_channel = $2,
                    fulfillment_type = $3
              WHERE sku = $1`,
            [sku, channel, fulfillmentType]
          )
        ).rejects.toMatchObject({
          code: "23514",
          constraint: "products_seeded_sku_contract"
        });
      }
    } finally {
      await query(
        `UPDATE products
            SET product_channel = CASE sku
                  WHEN 'POLICY_CALC' THEN 'main'
                  ELSE 'ai'
                END,
                fulfillment_type = CASE sku
                  WHEN 'POLICY_CALC' THEN 'policy_calculation'
                  WHEN 'AI_SEVERANCE_ANALYSIS' THEN 'ai_analysis'
                  WHEN 'AI_DOCUMENT_REVIEW' THEN 'document_review'
                END
          WHERE sku IN (
            'POLICY_CALC',
            'AI_SEVERANCE_ANALYSIS',
            'AI_DOCUMENT_REVIEW'
          )`
      );
    }
  });

  it("rejects overlapping price periods and permits adjacent half-open periods", async () => {
    const sku = `QUALITY_PRICE_${randomUUID().replaceAll("-", "").toUpperCase()}`;
    const product = await query<{ id: string }>(
      `INSERT INTO products(
         sku,
         name,
         description,
         product_channel,
         fulfillment_type,
         status,
         entitlement_policy
       )
       VALUES ($1, '价格区间测试', '价格区间测试商品', 'ai', 'ai_analysis', 'active', '{}')
       RETURNING id`,
      [sku]
    );
    const productId = product.rows[0].id;
    try {
      await query(
        `INSERT INTO product_prices(
           product_id, amount_fen, effective_from, effective_to
         )
         VALUES (
           $1, 100, TIMESTAMPTZ '2026-01-01 00:00:00+08',
           TIMESTAMPTZ '2026-02-01 00:00:00+08'
         )`,
        [productId]
      );
      await expect(
        query(
          `INSERT INTO product_prices(
             product_id, amount_fen, effective_from, effective_to
           )
           VALUES (
             $1, 200, TIMESTAMPTZ '2026-01-15 00:00:00+08',
             TIMESTAMPTZ '2026-02-15 00:00:00+08'
           )`,
          [productId]
        )
      ).rejects.toMatchObject({
        code: "23P01",
        constraint: "product_prices_no_overlap"
      });
      await expect(
        query(
          `INSERT INTO product_prices(
             product_id, amount_fen, effective_from, effective_to
           )
           VALUES (
             $1, 300, TIMESTAMPTZ '2026-02-01 00:00:00+08',
             TIMESTAMPTZ '2026-03-01 00:00:00+08'
           )`,
          [productId]
        )
      ).resolves.toMatchObject({ rowCount: 1 });
    } finally {
      await query("DELETE FROM products WHERE id = $1", [productId]);
    }
  });

  it("allows only one of two concurrent overlapping price inserts", async () => {
    const sku = `QUALITY_RACE_${randomUUID().replaceAll("-", "").toUpperCase()}`;
    const product = await query<{ id: string }>(
      `INSERT INTO products(
         sku,
         name,
         description,
         product_channel,
         fulfillment_type,
         status,
         entitlement_policy
       )
       VALUES ($1, '并发价格测试', '并发价格测试商品', 'ai', 'ai_analysis', 'active', '{}')
       RETURNING id`,
      [sku]
    );
    const productId = product.rows[0].id;
    try {
      const attempts = await Promise.allSettled([
        query(
          `INSERT INTO product_prices(
             product_id, amount_fen, effective_from, effective_to
           )
           VALUES (
             $1, 100, TIMESTAMPTZ '2026-04-01 00:00:00+08',
             TIMESTAMPTZ '2026-05-01 00:00:00+08'
           )`,
          [productId]
        ),
        query(
          `INSERT INTO product_prices(
             product_id, amount_fen, effective_from, effective_to
           )
           VALUES (
             $1, 200, TIMESTAMPTZ '2026-04-15 00:00:00+08',
             TIMESTAMPTZ '2026-05-15 00:00:00+08'
           )`,
          [productId]
        )
      ]);
      expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
      expect(attempts.filter((attempt) => attempt.status === "rejected")).toEqual([
        expect.objectContaining({
          reason: expect.objectContaining({
            code: "23P01",
            constraint: "product_prices_no_overlap"
          }),
          status: "rejected"
        })
      ]);
    } finally {
      await query("DELETE FROM products WHERE id = $1", [productId]);
    }
  });

  it("rejects payment, entitlement and invoice rows with mismatched ownership", async () => {
    const marker = randomUUID().replaceAll("-", "");
    let userIds: string[] = [];
    let orderIds: string[] = [];
    let attemptId: string | undefined;
    let entitlementId: string | undefined;
    try {
      await seedPolicyFoundation();
      const users = await query<{ id: string }>(
        `INSERT INTO users(email)
         VALUES ($1), ($2)
         RETURNING id`,
        [`quality-a-${marker}@peileme.test`, `quality-b-${marker}@peileme.test`]
      );
      userIds = users.rows.map((row) => row.id);
      const [userA, userB] = userIds;
      const orders = await query<{ id: string }>(
        `INSERT INTO orders(
           order_no,
           user_id,
           product_channel,
           status,
           total_fen,
           idempotency_key,
           expires_at
         )
         VALUES
           ($1, $3, 'main', 'CREATED', 990, $4, now() + interval '30 minutes'),
           ($2, $5, 'main', 'CREATED', 990, $6, now() + interval '30 minutes')
         RETURNING id`,
        [
          `QUALITY-A-${marker}`,
          `QUALITY-B-${marker}`,
          userA,
          `quality-a-${marker}`,
          userB,
          `quality-b-${marker}`
        ]
      );
      orderIds = orders.rows.map((row) => row.id);
      const [orderA, orderB] = orderIds;
      const attempt = await insertIdentityAwarePaymentAttempt({
        orderId: orderA,
        channel: "wechat_h5",
        status: "CREATED"
      });
      attemptId = attempt.id;
      const entitlement = await query<{ id: string }>(
        `INSERT INTO entitlements(
           user_id,
           product_id,
           source_type,
           total_uses,
           remaining_uses,
           status
         )
         SELECT $1, id, 'admin', 1, 1, 'active'
           FROM products
          WHERE sku = 'POLICY_CALC'
         RETURNING id`,
        [userA]
      );
      entitlementId = entitlement.rows[0].id;

      await expect(
        query(
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
           VALUES ($1, $2, 'wechat_h5', $3, 990, 'CNY', 'SUCCESS', '{}')`,
          [orderB, attemptId, `quality-${marker}`]
        )
      ).rejects.toMatchObject({
        code: "23503",
        constraint: "payment_transactions_attempt_order_fk"
      });

      await expect(
        query(
          `INSERT INTO entitlement_usages(
             entitlement_id,
             user_id,
             business_type,
             business_id,
             status
           )
           VALUES ($1, $2, 'quality', $3, 'reserved')`,
          [entitlementId, userB, randomUUID()]
        )
      ).rejects.toMatchObject({
        code: "23503",
        constraint: "entitlement_usages_owner_fk"
      });

      await expect(
        query(
          `INSERT INTO invoice_requests(
             user_id,
             order_id,
             title,
             email,
             status
           )
           VALUES ($1, $2, '错配发票', $3, 'SUBMITTED')`,
          [userB, orderA, `quality-b-${marker}@peileme.test`]
        )
      ).rejects.toMatchObject({
        code: "23503",
        constraint: "invoice_requests_order_owner_fk"
      });
    } finally {
      await query(
        "DELETE FROM payment_transactions WHERE channel_transaction_id = $1",
        [`quality-${marker}`]
      );
      if (entitlementId) {
        await query(
          "DELETE FROM entitlement_usages WHERE entitlement_id = $1",
          [entitlementId]
        );
      }
      if (orderIds.length > 0) {
        await query(
          "DELETE FROM invoice_requests WHERE order_id = ANY($1::uuid[])",
          [orderIds]
        );
      }
      if (entitlementId) {
        await query("DELETE FROM entitlements WHERE id = $1", [entitlementId]);
      }
      if (orderIds.length > 0) {
        await query("DELETE FROM orders WHERE id = ANY($1::uuid[])", [
          orderIds
        ]);
      }
      if (userIds.length > 0) {
        await query("DELETE FROM users WHERE id = ANY($1::uuid[])", [userIds]);
      }
    }
  });

  it("rejects a payment transaction whose channel differs from its attempt", async () => {
    const marker = randomUUID().replaceAll("-", "");
    let userId: string | undefined;
    let orderId: string | undefined;
    let attemptId: string | undefined;
    try {
      const user = await query<{ id: string }>(
        `INSERT INTO users(email)
         VALUES ($1)
         RETURNING id`,
        [`quality-channel-${marker}@peileme.test`]
      );
      userId = user.rows[0].id;
      const order = await query<{ id: string }>(
        `INSERT INTO orders(
           order_no,
           user_id,
           product_channel,
           status,
           total_fen,
           idempotency_key,
           expires_at
         )
         VALUES (
           $1, $2, 'main', 'CREATED', 990, $3,
           now() + interval '30 minutes'
         )
         RETURNING id`,
        [`QUALITY-CHANNEL-${marker}`, userId, `quality-channel-${marker}`]
      );
      orderId = order.rows[0].id;
      const attempt = await insertIdentityAwarePaymentAttempt({
        orderId,
        channel: "alipay_wap",
        status: "CREATED"
      });
      attemptId = attempt.id;

      await expect(
        query(
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
           VALUES ($1, $2, 'wechat_h5', $3, 990, 'CNY', 'SUCCESS', '{}')`,
          [orderId, attemptId, `quality-channel-${marker}`]
        )
      ).rejects.toMatchObject({
        code: "23503",
        constraint: "payment_transactions_attempt_order_fk"
      });
    } finally {
      await query(
        "DELETE FROM payment_transactions WHERE channel_transaction_id = $1",
        [`quality-channel-${marker}`]
      );
      if (orderId) {
        await query("DELETE FROM orders WHERE id = $1", [orderId]);
      }
      if (userId) {
        await query("DELETE FROM users WHERE id = $1", [userId]);
      }
    }
  });

  it("rejects a second open price as an overlapping period", async () => {
    await seedPolicyFoundation();
    await expect(
      query(
        `INSERT INTO product_prices(product_id, amount_fen, effective_from)
         SELECT id, 1090, now()
           FROM products
          WHERE sku = 'POLICY_CALC'`
      )
    ).rejects.toMatchObject({
      code: "23P01",
      constraint: "product_prices_no_overlap"
    });
  });

  it("rejects duplicate promotion codes", async () => {
    await seedPolicyFoundation();
    await expect(
      query(
        `INSERT INTO promotion_rules(
           code, name, product_id, grant_count, trigger_type, status
         )
         SELECT
           'FIRST_POLICY_CALC',
           '重复首单权益',
           id,
           1,
           'admin_grant',
           'active'
         FROM products
         WHERE sku = 'POLICY_CALC'`
      )
    ).rejects.toMatchObject({
      code: "23505",
      constraint: "promotion_rules_code_key"
    });
  });

  it("enforces positive prices and keeps document review AI-only", async () => {
    await seedPolicyFoundation();
    await expect(
      query(
        `INSERT INTO product_prices(product_id, amount_fen, effective_from)
         SELECT id, 0, now() - interval '1 day'
           FROM products
          WHERE sku = 'POLICY_CALC'`
      )
    ).rejects.toMatchObject({
      code: "23514"
    });

    await expect(
      query(
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
           'INVALID_MAIN_DOCUMENT_REVIEW',
           '错误渠道商品',
           '文档审查不得进入主站目录',
           'main',
           'document_review',
           'active',
           '{"grantCount":1}'::jsonb
         )`
      )
    ).rejects.toMatchObject({
      code: "23514"
    });
  });

  it("stores every monetary field as PostgreSQL BIGINT", async () => {
    const columns = await query<{
      table_name: string;
      column_name: string;
      data_type: string;
    }>(
      `SELECT table_name, column_name, data_type
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND (table_name, column_name) IN (
            ('product_prices', 'amount_fen'),
            ('orders', 'total_fen'),
            ('order_items', 'unit_price_fen'),
            ('payment_transactions', 'amount_fen'),
            ('refunds', 'amount_fen')
          )
        ORDER BY table_name, column_name`
    );

    expect(columns.rows).toEqual([
      {
        table_name: "order_items",
        column_name: "unit_price_fen",
        data_type: "bigint"
      },
      {
        table_name: "orders",
        column_name: "total_fen",
        data_type: "bigint"
      },
      {
        table_name: "payment_transactions",
        column_name: "amount_fen",
        data_type: "bigint"
      },
      {
        table_name: "product_prices",
        column_name: "amount_fen",
        data_type: "bigint"
      },
      {
        table_name: "refunds",
        column_name: "amount_fen",
        data_type: "bigint"
      }
    ]);
  });

  it("persists bounded final payment reconciliation state from migration 009", async () => {
    const columns = await query<{
      column_name: string;
      data_type: string;
      column_default: string | null;
      is_nullable: string;
    }>(
      `SELECT column_name, data_type, column_default, is_nullable
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'payment_attempts'
          AND column_name = ANY($1::text[])
        ORDER BY column_name`,
      [[
        "reconciliation_state",
        "reconciliation_attempt_count",
        "reconciliation_no_payment_count",
        "reconciliation_query_error_count",
        "reconciliation_next_at",
        "reconciliation_deadline_at",
        "reconciliation_last_result"
      ]]
    );
    expect(columns.rows).toEqual([
      {
        column_name: "reconciliation_attempt_count",
        data_type: "integer",
        column_default: "0",
        is_nullable: "NO"
      },
      {
        column_name: "reconciliation_deadline_at",
        data_type: "timestamp with time zone",
        column_default: null,
        is_nullable: "YES"
      },
      {
        column_name: "reconciliation_last_result",
        data_type: "text",
        column_default: null,
        is_nullable: "YES"
      },
      {
        column_name: "reconciliation_next_at",
        data_type: "timestamp with time zone",
        column_default: null,
        is_nullable: "YES"
      },
      {
        column_name: "reconciliation_no_payment_count",
        data_type: "integer",
        column_default: "0",
        is_nullable: "NO"
      },
      {
        column_name: "reconciliation_query_error_count",
        data_type: "integer",
        column_default: "0",
        is_nullable: "NO"
      },
      {
        column_name: "reconciliation_state",
        data_type: "text",
        column_default: "'NONE'::text",
        is_nullable: "NO"
      }
    ]);

    const indexes = await query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef
         FROM pg_indexes
        WHERE schemaname = 'public'
          AND tablename = 'payment_attempts'
          AND indexname = ANY($1::text[])
        ORDER BY indexname`,
      [[
        "payment_attempts_one_scheduled_reconciliation_per_channel",
        "payment_attempts_reconciliation_deadline_due_idx",
        "payment_attempts_reconciliation_due_idx"
      ]]
    );
    expect(indexes.rows).toHaveLength(3);
    expect(indexes.rows[0]).toMatchObject({
      indexname:
        "payment_attempts_one_scheduled_reconciliation_per_channel"
    });
    expect(indexes.rows[0].indexdef).toContain(
      "UNIQUE INDEX"
    );
    expect(indexes.rows[0].indexdef).toContain(
      "(order_id, channel)"
    );
    expect(indexes.rows[1]).toMatchObject({
      indexname: "payment_attempts_reconciliation_deadline_due_idx"
    });
    expect(indexes.rows[1].indexdef).toContain(
      "(channel, reconciliation_deadline_at, updated_at, id)"
    );
    expect(indexes.rows[2]).toMatchObject({
      indexname: "payment_attempts_reconciliation_due_idx"
    });
    expect(indexes.rows[2].indexdef).toContain(
      "(channel, reconciliation_next_at, updated_at, id)"
    );
    for (const index of indexes.rows) {
      expect(index.indexdef).toContain(
        "reconciliation_state = ANY (ARRAY['REQUIRED'::text, 'RETRY_SCHEDULED'::text])"
      );
    }
    const openOrderIndex = await query<{
      indexname: string;
      indexdef: string;
    }>(
      `SELECT indexname, indexdef
         FROM pg_indexes
        WHERE schemaname = 'public'
          AND tablename = 'orders'
          AND indexname = 'orders_open_reconciliation_due_idx'`
    );
    expect(openOrderIndex.rows).toHaveLength(1);
    expect(openOrderIndex.rows[0].indexdef).toContain(
      "(expires_at, status, updated_at, id)"
    );
    expect(openOrderIndex.rows[0].indexdef).toContain(
      "status = ANY (ARRAY['CREATED'::text, 'PAYING'::text, 'PAYMENT_FAILED'::text])"
    );
  });

  it("installs the channel-scoped owned-order lookup index from migration 010", async () => {
    const index = await query<{ indexdef: string }>(
      `SELECT indexdef
         FROM pg_indexes
        WHERE schemaname = 'public'
          AND tablename = 'orders'
          AND indexname = 'orders_user_product_channel_created_id_idx'`
    );

    expect(index.rows).toHaveLength(1);
    expect(index.rows[0].indexdef).toContain(
      "(user_id, product_channel, created_at DESC, id DESC)"
    );
  });

  it("rejects invalid payment reconciliation result and schedule combinations", async () => {
    await seedPolicyFoundation();
    let userId: string | undefined;
    try {
      userId = await createEntitlementTestUser(true);
      const order = await createOrder({
        userId,
        sku: "POLICY_CALC",
        channel: "main",
        idempotencyKey: `reconciliation-constraint-${randomUUID()}`,
        businessDraftId: await insertPolicyDraft(userId)
      });
      const attempt = await insertIdentityAwarePaymentAttempt({
        orderId: order.id,
        channel: "wechat_h5",
        status: "CLOSED"
      });
      await expect(
        paymentWriteQuery(
          `UPDATE payment_attempts
           SET reconciliation_state = 'REQUIRED',
               reconciliation_next_at = now() + interval '2 hours',
               reconciliation_deadline_at = now() + interval '1 hour',
               reconciliation_last_result =
                 'LOCAL_CLOSE_PENDING_FINAL_QUERY'
           WHERE id = $1`,
          [attempt.id]
        )
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        paymentWriteQuery(
          `UPDATE payment_attempts
           SET status = 'PENDING',
               reconciliation_state = 'REQUIRED',
               reconciliation_next_at = now(),
               reconciliation_deadline_at = now() + interval '1 hour',
               reconciliation_last_result =
                 'LOCAL_CLOSE_PENDING_FINAL_QUERY'
           WHERE id = $1`,
          [attempt.id]
        )
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        paymentWriteQuery(
          `UPDATE payment_attempts
           SET reconciliation_next_at = now()
           WHERE id = $1`,
          [attempt.id]
        )
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        paymentWriteQuery(
          `UPDATE payment_attempts
           SET reconciliation_last_result = 'UNRECOGNIZED_RESULT'
           WHERE id = $1`,
          [attempt.id]
        )
      ).rejects.toMatchObject({ code: "23514" });
    } finally {
      if (userId) await cleanupEntitlementTestUsers([userId]);
    }
  });

  it("stores structured pending payment anomalies without provider raw payloads", async () => {
    const columns = await query<{
      column_name: string;
      data_type: string;
      is_nullable: string;
    }>(
      `SELECT column_name, data_type, is_nullable
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'payment_anomalies'
         AND column_name = ANY($1::text[])
       ORDER BY column_name`,
      [[
        "order_id",
        "payment_attempt_id",
        "attempt_channel",
        "provider_channel",
        "kind",
        "status",
        "channel_transaction_id",
        "provider_order_no",
        "amount_fen",
        "currency",
        "paid_at",
        "evidence_fingerprint"
      ]]
    );
    expect(columns.rows).toEqual([
      {
        column_name: "amount_fen",
        data_type: "text",
        is_nullable: "NO"
      },
      {
        column_name: "attempt_channel",
        data_type: "text",
        is_nullable: "NO"
      },
      {
        column_name: "channel_transaction_id",
        data_type: "text",
        is_nullable: "NO"
      },
      {
        column_name: "currency",
        data_type: "text",
        is_nullable: "NO"
      },
      {
        column_name: "evidence_fingerprint",
        data_type: "text",
        is_nullable: "NO"
      },
      {
        column_name: "kind",
        data_type: "text",
        is_nullable: "NO"
      },
      {
        column_name: "order_id",
        data_type: "uuid",
        is_nullable: "NO"
      },
      {
        column_name: "paid_at",
        data_type: "timestamp with time zone",
        is_nullable: "YES"
      },
      {
        column_name: "payment_attempt_id",
        data_type: "uuid",
        is_nullable: "NO"
      },
      {
        column_name: "provider_channel",
        data_type: "text",
        is_nullable: "NO"
      },
      {
        column_name: "provider_order_no",
        data_type: "text",
        is_nullable: "NO"
      },
      {
        column_name: "status",
        data_type: "text",
        is_nullable: "NO"
      }
    ]);
    const indexes = await query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef
       FROM pg_indexes
       WHERE schemaname = 'public'
         AND tablename = 'payment_anomalies'
       ORDER BY indexname`
    );
    expect(indexes.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          indexname: "payment_anomalies_evidence_unique_idx",
          indexdef: expect.stringContaining("UNIQUE INDEX")
        }),
        expect.objectContaining({
          indexname: "payment_anomalies_pending_idx",
          indexdef: expect.stringContaining(
            "WHERE (status = 'PENDING_REVIEW'::text)"
          )
        }),
        expect.objectContaining({
          indexname: "payment_anomalies_provider_transaction_unique_idx",
          indexdef: expect.stringContaining(
            "(provider_channel, channel_transaction_id)"
          )
        })
      ])
    );
    const channelIdentityConstraint = await query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE conrelid = 'payment_anomalies'::regclass
         AND contype = 'c'
         AND pg_get_constraintdef(oid) LIKE
           '%provider_channel = attempt_channel%'`
    );
    expect(channelIdentityConstraint.rows).toHaveLength(1);
  });
});

describe("effective commerce catalog", () => {
  it("returns only active channel and all-channel products with effective prices", async () => {
    await seedPolicyFoundation();
    const marker = randomUUID().replaceAll("-", "").toUpperCase();
    const allSku = `QUALITY_ALL_${marker}`;
    const inactiveSku = `QUALITY_INACTIVE_${marker}`;
    try {
      await query(
        `WITH inserted AS (
           INSERT INTO products(
             sku,
             name,
             description,
             product_channel,
             fulfillment_type,
             status,
             entitlement_policy
           )
           VALUES
             ($1, '全渠道商品', '目录过滤测试', 'all', 'ai_analysis', 'active', '{}'),
             ($2, '停用商品', '目录过滤测试', 'main', 'policy_calculation', 'inactive', '{}')
           RETURNING id
         )
         INSERT INTO product_prices(product_id, amount_fen, effective_from)
         SELECT id, 1234, now() - interval '1 day'
           FROM inserted`,
        [allSku, inactiveSku]
      );

      const [mainCatalog, aiCatalog] = await Promise.all([
        getActiveCatalog("main"),
        getActiveCatalog("ai")
      ]);
      expect(mainCatalog.map((item) => item.sku)).toEqual([
        "POLICY_CALC",
        allSku
      ].sort());
      expect(aiCatalog.map((item) => item.sku)).toEqual([
        "AI_DOCUMENT_REVIEW",
        "AI_SEVERANCE_ANALYSIS",
        allSku
      ].sort());
      expect(
        mainCatalog.find((item) => item.sku === allSku)
      ).toMatchObject({
        amountFen: "1234",
        currency: "CNY",
        productChannel: "all"
      });
      expect(
        mainCatalog.some((item) => item.sku === inactiveSku)
      ).toBe(false);
    } finally {
      await query("DELETE FROM products WHERE sku = ANY($1::text[])", [
        [allSku, inactiveSku]
      ]);
    }
  });

  it("uses half-open price periods and preserves BIGINT amounts as strings", async () => {
    const marker = randomUUID().replaceAll("-", "").toUpperCase();
    const sku = `QUALITY_TIME_${marker}`;
    const product = await query<{ id: string }>(
      `INSERT INTO products(
         sku,
         name,
         description,
         product_channel,
         fulfillment_type,
         status,
         entitlement_policy
       )
       VALUES ($1, '时间价格商品', '时间边界测试', 'ai', 'ai_analysis', 'active', '{}')
       RETURNING id`,
      [sku]
    );
    const productId = product.rows[0].id;
    try {
      await query(
        `INSERT INTO product_prices(
           product_id, amount_fen, effective_from, effective_to
         )
         VALUES
           (
             $1, 9007199254740993,
             TIMESTAMPTZ '2026-01-01 00:00:00+08',
             TIMESTAMPTZ '2026-02-01 00:00:00+08'
           ),
           (
             $1, 9007199254740995,
             TIMESTAMPTZ '2026-02-01 00:00:00+08',
             TIMESTAMPTZ '2026-03-01 00:00:00+08'
           )`,
        [productId]
      );

      await expect(
        getEffectivePrice(productId, new Date("2025-12-31T16:00:00.000Z"))
      ).resolves.toMatchObject({ amountFen: "9007199254740993" });
      await expect(
        getEffectivePrice(productId, new Date("2026-01-31T15:59:59.999Z"))
      ).resolves.toMatchObject({ amountFen: "9007199254740993" });
      await expect(
        getEffectivePrice(productId, new Date("2026-01-31T16:00:00.000Z"))
      ).resolves.toMatchObject({ amountFen: "9007199254740995" });
      await expect(
        getEffectivePrice(productId, new Date("2026-02-28T16:00:00.000Z"))
      ).resolves.toBeNull();
      await expect(
        getEffectivePrice(productId, "2026-02-01" as never)
      ).rejects.toMatchObject({
        code: "INVALID_COMMERCE_INPUT"
      });
    } finally {
      await query("DELETE FROM products WHERE id = $1", [productId]);
    }
  });

  it("rejects an unverified user's first-free reservation", async () => {
    await seedPolicyFoundation();
    const marker = randomUUID().replaceAll("-", "");
    let userId: string | undefined;
    try {
      const user = await query<{ id: string }>(
        `INSERT INTO users(email)
         VALUES ($1)
         RETURNING id`,
        [`task2-unverified-${marker}@peileme.test`]
      );
      userId = user.rows[0].id;

      await expect(
        reserveEntitlement(userId, "POLICY_CALC", randomUUID())
      ).rejects.toMatchObject({
        code: "IDENTITY_VERIFICATION_REQUIRED"
      });
      const persisted = await query<{ entitlements: string; usages: string }>(
        `SELECT
           (
             SELECT count(*)::text
               FROM entitlements
              WHERE user_id = $1
           ) AS entitlements,
           (
             SELECT count(*)::text
               FROM entitlement_usages
              WHERE user_id = $1
           ) AS usages`,
        [userId]
      );
      expect(persisted.rows[0]).toEqual({
        entitlements: "0",
        usages: "0"
      });
    } finally {
      if (userId) {
        await query("DELETE FROM entitlement_usages WHERE user_id = $1", [
          userId
        ]);
        await query("DELETE FROM entitlements WHERE user_id = $1", [userId]);
        await query("DELETE FROM users WHERE id = $1", [userId]);
      }
    }
  });

  it("grants one first-free use for two concurrent business reservations", async () => {
    await seedPolicyFoundation();
    const marker = randomUUID().replaceAll("-", "");
    let userId: string | undefined;
    try {
      const user = await query<{ id: string }>(
        `INSERT INTO users(email, email_verified_at)
         VALUES ($1, now())
         RETURNING id`,
        [`task2-race-${marker}@peileme.test`]
      );
      userId = user.rows[0].id;

      const attempts = await Promise.allSettled([
        reserveEntitlement(userId, "POLICY_CALC", randomUUID()),
        reserveEntitlement(userId, "POLICY_CALC", randomUUID())
      ]);
      expect(
        attempts.filter((attempt) => attempt.status === "fulfilled")
      ).toHaveLength(1);
      expect(
        attempts.filter((attempt) => attempt.status === "rejected")
      ).toEqual([
        expect.objectContaining({
          reason: expect.objectContaining({
            code: "ENTITLEMENT_NOT_AVAILABLE"
          }),
          status: "rejected"
        })
      ]);

      const persisted = await query<{
        entitlements: string;
        remaining_uses: string;
        usages: string;
      }>(
        `SELECT
           count(DISTINCT e.id)::text AS entitlements,
           max(e.remaining_uses)::text AS remaining_uses,
           count(eu.id)::text AS usages
         FROM entitlements e
         LEFT JOIN entitlement_usages eu ON eu.entitlement_id = e.id
         WHERE e.user_id = $1
           AND e.source_type = 'first_free'`,
        [userId]
      );
      expect(persisted.rows[0]).toEqual({
        entitlements: "1",
        remaining_uses: "0",
        usages: "1"
      });
    } finally {
      if (userId) {
        await query("DELETE FROM entitlement_usages WHERE user_id = $1", [
          userId
        ]);
        await query("DELETE FROM entitlements WHERE user_id = $1", [userId]);
        await query("DELETE FROM users WHERE id = $1", [userId]);
      }
    }
  });
});

describe("atomic commerce entitlements", () => {
  it("rejects invalid channels, SKUs and identifiers with closed safe codes", async () => {
    await expect(getActiveCatalog("admin" as never)).rejects.toMatchObject({
      code: "INVALID_COMMERCE_CHANNEL"
    });
    await expect(getProductBySku("policy_calc")).rejects.toMatchObject({
      code: "INVALID_PRODUCT_SKU"
    });
    await expect(
      reserveEntitlement("not-a-user", "POLICY_CALC", randomUUID())
    ).rejects.toMatchObject({
      code: "INVALID_COMMERCE_INPUT"
    });
    await expect(
      reserveEntitlement(randomUUID(), "UNKNOWN_SKU", randomUUID())
    ).rejects.toMatchObject({
      code: "INVALID_PRODUCT_SKU"
    });
  });

  it.each(
    ["disabled", "expired", "future", "trigger_mismatch"] as const
  )(
    "does not grant first-free use from a %s promotion",
    async (promotionState) => {
      await seedPolicyFoundation();
      let userId: string | undefined;
      try {
        userId = await createEntitlementTestUser(true);
        if (promotionState === "disabled") {
          await query(
            `UPDATE promotion_rules
                SET status = 'inactive',
                    starts_at = NULL,
                    ends_at = NULL
              WHERE code = 'FIRST_POLICY_CALC'`
          );
        } else if (promotionState === "expired") {
          await query(
            `UPDATE promotion_rules
                SET status = 'active',
                    starts_at = now() - interval '2 days',
                    ends_at = now() - interval '1 day'
              WHERE code = 'FIRST_POLICY_CALC'`
          );
        } else if (promotionState === "future") {
          await query(
            `UPDATE promotion_rules
                SET status = 'active',
                    starts_at = now() + interval '1 day',
                    ends_at = now() + interval '2 days'
              WHERE code = 'FIRST_POLICY_CALC'`
          );
        } else {
          await query(
            `UPDATE promotion_rules
                SET status = 'active',
                    trigger_type = 'admin_grant',
                    starts_at = NULL,
                    ends_at = NULL
              WHERE code = 'FIRST_POLICY_CALC'`
          );
        }

        await expect(
          reserveEntitlement(userId, "POLICY_CALC", randomUUID())
        ).rejects.toMatchObject({
          code: "ENTITLEMENT_NOT_AVAILABLE"
        });
        const persisted = await query<{ entitlements: string; usages: string }>(
          `SELECT
             (SELECT count(*)::text FROM entitlements WHERE user_id = $1)
               AS entitlements,
             (SELECT count(*)::text FROM entitlement_usages WHERE user_id = $1)
               AS usages`,
          [userId]
        );
        expect(persisted.rows[0]).toEqual({
          entitlements: "0",
          usages: "0"
        });
      } finally {
        await query(
          `UPDATE promotion_rules
              SET status = 'active',
                  trigger_type = 'first_verified_user',
                  starts_at = NULL,
                  ends_at = NULL,
                  updated_at = now()
            WHERE code = 'FIRST_POLICY_CALC'`
        );
        if (userId) await cleanupEntitlementTestUsers([userId]);
      }
    }
  );

  it("returns one reservation for concurrent retries of the same business", async () => {
    await seedPolicyFoundation();
    let userId: string | undefined;
    const businessId = randomUUID();
    try {
      userId = await createEntitlementTestUser(true);
      const reservations = await Promise.all([
        reserveEntitlement(userId, "POLICY_CALC", businessId),
        reserveEntitlement(userId, "POLICY_CALC", businessId)
      ]);
      expect(reservations[1]).toEqual(reservations[0]);

      const state = await query<{
        usages: string;
        remaining_uses: number;
      }>(
        `SELECT
           count(eu.id)::text AS usages,
           max(e.remaining_uses)::integer AS remaining_uses
         FROM entitlements e
         LEFT JOIN entitlement_usages eu ON eu.entitlement_id = e.id
         WHERE e.user_id = $1`,
        [userId]
      );
      expect(state.rows[0]).toEqual({
        usages: "1",
        remaining_uses: 0
      });
    } finally {
      if (userId) await cleanupEntitlementTestUsers([userId]);
    }
  });

  it("re-reserves a released business atomically with the same usage ID", async () => {
    await seedPolicyFoundation();
    let userId: string | undefined;
    try {
      userId = await createEntitlementTestUser(false);
      const entitlementId = await insertAdminEntitlement(
        userId,
        "AI_SEVERANCE_ANALYSIS",
        1
      );
      const businessId = randomUUID();
      const initial = await reserveEntitlement(
        userId,
        "AI_SEVERANCE_ANALYSIS",
        businessId
      );
      await releaseEntitlement(initial.usageId);

      const retried = await reserveEntitlement(
        userId,
        "AI_SEVERANCE_ANALYSIS",
        businessId
      );
      expect(retried).toEqual({
        ...initial,
        status: "reserved"
      });

      const persisted = await query<{
        remaining_uses: number;
        entitlement_status: string;
        usage_status: string;
        usages: string;
      }>(
        `SELECT
           e.remaining_uses,
           e.status AS entitlement_status,
           eu.status AS usage_status,
           count(*) OVER ()::text AS usages
         FROM entitlements e
         JOIN entitlement_usages eu ON eu.entitlement_id = e.id
         WHERE e.id = $1`,
        [entitlementId]
      );
      expect(persisted.rows).toEqual([
        {
          remaining_uses: 0,
          entitlement_status: "reserved",
          usage_status: "reserved",
          usages: "1"
        }
      ]);
    } finally {
      if (userId) await cleanupEntitlementTestUsers([userId]);
    }
  });

  it("does not reuse one business ID across users or SKUs", async () => {
    await seedPolicyFoundation();
    const userIds: string[] = [];
    const businessId = randomUUID();
    try {
      const userA = await createEntitlementTestUser(true);
      userIds.push(userA);
      const userB = await createEntitlementTestUser(true);
      userIds.push(userB);
      await insertAdminEntitlement(userA, "AI_SEVERANCE_ANALYSIS", 1);
      await reserveEntitlement(userA, "POLICY_CALC", businessId);

      await expect(
        reserveEntitlement(userB, "POLICY_CALC", businessId)
      ).rejects.toMatchObject({
        code: "BUSINESS_ID_CONFLICT"
      });
      await expect(
        reserveEntitlement(userA, "AI_SEVERANCE_ANALYSIS", businessId)
      ).rejects.toMatchObject({
        code: "BUSINESS_ID_CONFLICT"
      });

      const state = await query<{
        ai_remaining: number;
        user_b_entitlements: string;
      }>(
        `SELECT
           (
             SELECT remaining_uses
               FROM entitlements e
               JOIN products p ON p.id = e.product_id
              WHERE e.user_id = $1
                AND p.sku = 'AI_SEVERANCE_ANALYSIS'
           ) AS ai_remaining,
           (
             SELECT count(*)::text
               FROM entitlements
              WHERE user_id = $2
           ) AS user_b_entitlements`,
        [userA, userB]
      );
      expect(state.rows[0]).toEqual({
        ai_remaining: 1,
        user_b_entitlements: "0"
      });
    } finally {
      await cleanupEntitlementTestUsers(userIds);
    }
  });

  it("lets two verified users each receive the first-free promotion", async () => {
    await seedPolicyFoundation();
    const userIds: string[] = [];
    try {
      const userA = await createEntitlementTestUser(true);
      userIds.push(userA);
      const userB = await createEntitlementTestUser(true);
      userIds.push(userB);
      const reservations = await Promise.all([
        reserveEntitlement(userA, "POLICY_CALC", randomUUID()),
        reserveEntitlement(userB, "POLICY_CALC", randomUUID())
      ]);
      expect(reservations.map((item) => item.sourceType)).toEqual([
        "first_free",
        "first_free"
      ]);
      const grants = await query<{ user_id: string; count: string }>(
        `SELECT user_id, count(*)::text AS count
           FROM entitlements
          WHERE user_id = ANY($1::uuid[])
            AND source_type = 'first_free'
          GROUP BY user_id
          ORDER BY user_id`,
        [[userA, userB]]
      );
      expect(grants.rows).toEqual(
        [userA, userB]
          .sort()
          .map((userId) => ({ user_id: userId, count: "1" }))
      );
    } finally {
      await cleanupEntitlementTestUsers(userIds);
    }
  });

  it("keeps multi-use reserve, consume and release transitions atomic and idempotent", async () => {
    await seedPolicyFoundation();
    let userId: string | undefined;
    const businessA = randomUUID();
    const businessB = randomUUID();
    const businessC = randomUUID();
    try {
      userId = await createEntitlementTestUser(false);
      const entitlementId = await insertAdminEntitlement(
        userId,
        "AI_SEVERANCE_ANALYSIS",
        2
      );
      const [reservationA, reservationB] = await Promise.all([
        reserveEntitlement(
          userId,
          "AI_SEVERANCE_ANALYSIS",
          businessA
        ),
        reserveEntitlement(
          userId,
          "AI_SEVERANCE_ANALYSIS",
          businessB
        )
      ]);
      await expect(
        reserveEntitlement(userId, "AI_SEVERANCE_ANALYSIS", randomUUID())
      ).rejects.toMatchObject({
        code: "ENTITLEMENT_NOT_AVAILABLE"
      });

      const consumedA = await consumeEntitlement(reservationA.usageId);
      await expect(
        consumeEntitlement(reservationA.usageId)
      ).resolves.toEqual(consumedA);
      await expect(
        releaseEntitlement(reservationA.usageId)
      ).rejects.toMatchObject({
        code: "ENTITLEMENT_USAGE_CLOSED"
      });

      const releasedB = await releaseEntitlement(reservationB.usageId);
      await expect(
        releaseEntitlement(reservationB.usageId)
      ).resolves.toEqual(releasedB);
      await expect(
        consumeEntitlement(reservationB.usageId)
      ).rejects.toMatchObject({
        code: "ENTITLEMENT_USAGE_CLOSED"
      });

      await expect(
        getAvailableEntitlements(userId, "AI_SEVERANCE_ANALYSIS")
      ).resolves.toEqual([
        expect.objectContaining({
          id: entitlementId,
          remainingUses: 1,
          status: "active"
        })
      ]);

      const reservationC = await reserveEntitlement(
        userId,
        "AI_SEVERANCE_ANALYSIS",
        businessC
      );
      await consumeEntitlement(reservationC.usageId);

      const entitlement = await query<{
        remaining_uses: number;
        status: string;
      }>(
        `SELECT remaining_uses, status
           FROM entitlements
          WHERE id = $1`,
        [entitlementId]
      );
      expect(entitlement.rows[0]).toEqual({
        remaining_uses: 0,
        status: "consumed"
      });
      const usages = await query<{ status: string; count: string }>(
        `SELECT status, count(*)::text AS count
           FROM entitlement_usages
          WHERE entitlement_id = $1
          GROUP BY status
          ORDER BY status`,
        [entitlementId]
      );
      expect(usages.rows).toEqual([
        { status: "consumed", count: "2" },
        { status: "released", count: "1" }
      ]);
    } finally {
      if (userId) await cleanupEntitlementTestUsers([userId]);
    }
  });

  it("allows only one terminal result when consume races release", async () => {
    await seedPolicyFoundation();
    let userId: string | undefined;
    try {
      userId = await createEntitlementTestUser(false);
      const entitlementId = await insertAdminEntitlement(
        userId,
        "AI_SEVERANCE_ANALYSIS",
        1
      );
      const reservation = await reserveEntitlement(
        userId,
        "AI_SEVERANCE_ANALYSIS",
        randomUUID()
      );

      const transitions = await Promise.allSettled([
        consumeEntitlement(reservation.usageId),
        releaseEntitlement(reservation.usageId)
      ]);
      const fulfilled = transitions.filter(
        (item) => item.status === "fulfilled"
      );
      const rejected = transitions.filter(
        (item) => item.status === "rejected"
      );
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toEqual([
        expect.objectContaining({
          reason: expect.objectContaining({
            code: "ENTITLEMENT_USAGE_CLOSED"
          })
        })
      ]);

      const terminalStatus =
        (fulfilled[0] as PromiseFulfilledResult<{ status: string }>).value
          .status;
      const persisted = await query<{
        remaining_uses: number;
        entitlement_status: string;
        usage_status: string;
      }>(
        `SELECT
           e.remaining_uses,
           e.status AS entitlement_status,
           eu.status AS usage_status
         FROM entitlements e
         JOIN entitlement_usages eu ON eu.entitlement_id = e.id
         WHERE e.id = $1`,
        [entitlementId]
      );
      expect(persisted.rows[0]).toEqual(
        terminalStatus === "consumed"
          ? {
              remaining_uses: 0,
              entitlement_status: "consumed",
              usage_status: "consumed"
            }
          : {
              remaining_uses: 1,
              entitlement_status: "active",
              usage_status: "released"
            }
      );
    } finally {
      if (userId) await cleanupEntitlementTestUsers([userId]);
    }
  });

  it.each(["consume", "release"] as const)(
    "rolls back usage and entitlement when %s persistence fails",
    async (transition) => {
      await seedPolicyFoundation();
      let userId: string | undefined;
      let triggerInstalled = false;
      try {
        userId = await createEntitlementTestUser(false);
        const entitlementId = await insertAdminEntitlement(
          userId,
          "AI_SEVERANCE_ANALYSIS",
          1
        );
        const reservation = await reserveEntitlement(
          userId,
          "AI_SEVERANCE_ANALYSIS",
          randomUUID()
        );
        await query(`
          CREATE OR REPLACE FUNCTION fail_entitlement_transition_for_task2()
          RETURNS trigger
          LANGUAGE plpgsql
          AS $$
          BEGIN
            RAISE EXCEPTION 'forced entitlement transition failure';
          END
          $$
        `);
        await query(`
          CREATE TRIGGER fail_entitlement_transition_for_task2_trigger
          BEFORE UPDATE ON entitlements
          FOR EACH ROW
          EXECUTE FUNCTION fail_entitlement_transition_for_task2()
        `);
        triggerInstalled = true;

        const operation =
          transition === "consume"
            ? consumeEntitlement(reservation.usageId)
            : releaseEntitlement(reservation.usageId);
        await expect(operation).rejects.toMatchObject({ code: "P0001" });

        const persisted = await query<{
          remaining_uses: number;
          entitlement_status: string;
          usage_status: string;
        }>(
          `SELECT
             e.remaining_uses,
             e.status AS entitlement_status,
             eu.status AS usage_status
           FROM entitlements e
           JOIN entitlement_usages eu ON eu.entitlement_id = e.id
           WHERE e.id = $1`,
          [entitlementId]
        );
        expect(persisted.rows[0]).toEqual({
          remaining_uses: 0,
          entitlement_status: "reserved",
          usage_status: "reserved"
        });
      } finally {
        if (triggerInstalled) {
          await query(
            "DROP TRIGGER IF EXISTS fail_entitlement_transition_for_task2_trigger ON entitlements"
          );
        }
        await query(
          "DROP FUNCTION IF EXISTS fail_entitlement_transition_for_task2()"
        );
        if (userId) await cleanupEntitlementTestUsers([userId]);
      }
    }
  );

  it("rolls back first-free grant when usage persistence fails", async () => {
    await seedPolicyFoundation();
    let userId: string | undefined;
    let triggerInstalled = false;
    try {
      userId = await createEntitlementTestUser(true);
      await query(`
        CREATE OR REPLACE FUNCTION fail_entitlement_usage_for_task2()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        BEGIN
          RAISE EXCEPTION 'forced entitlement usage failure';
        END
        $$
      `);
      await query(`
        CREATE TRIGGER fail_entitlement_usage_for_task2_trigger
        BEFORE INSERT ON entitlement_usages
        FOR EACH ROW
        EXECUTE FUNCTION fail_entitlement_usage_for_task2()
      `);
      triggerInstalled = true;

      await expect(
        reserveEntitlement(userId, "POLICY_CALC", randomUUID())
      ).rejects.toMatchObject({
        code: "P0001"
      });
      const persisted = await query<{ entitlements: string; usages: string }>(
        `SELECT
           (SELECT count(*)::text FROM entitlements WHERE user_id = $1)
             AS entitlements,
           (SELECT count(*)::text FROM entitlement_usages WHERE user_id = $1)
             AS usages`,
        [userId]
      );
      expect(persisted.rows[0]).toEqual({
        entitlements: "0",
        usages: "0"
      });
    } finally {
      if (triggerInstalled) {
        await query(
          "DROP TRIGGER IF EXISTS fail_entitlement_usage_for_task2_trigger ON entitlement_usages"
        );
      }
      await query(
        "DROP FUNCTION IF EXISTS fail_entitlement_usage_for_task2()"
      );
      if (userId) await cleanupEntitlementTestUsers([userId]);
    }
  });
});

describe("atomic commerce orders and payments", () => {
  it("isolates one user's main and AI order reads, payments and invoices", async () => {
    await seedPolicyFoundation();
    let userId: string | undefined;
    try {
      userId = await createEntitlementTestUser(true);
      const [mainOrder, aiOrder] = await Promise.all([
        createOrder({
          userId,
          sku: "POLICY_CALC",
          channel: "main",
          idempotencyKey: `isolation-main-${randomUUID()}`,
          businessDraftId: await insertPolicyDraft(userId, "main")
        }),
        createOrder({
          userId,
          sku: "AI_DOCUMENT_REVIEW",
          channel: "ai",
          idempotencyKey: `isolation-ai-${randomUUID()}`,
          businessDraftId: await insertPolicyDraft(userId, "ai")
        })
      ]);

      const [mainList, aiList] = await Promise.all([
        listOwnedOrders(userId, 1, 20, "main"),
        listOwnedOrders(userId, 1, 20, "ai")
      ]);
      expect(mainList).toMatchObject({ total: "1" });
      expect(mainList.items.map((item) => item.id)).toEqual([mainOrder.id]);
      expect(aiList).toMatchObject({ total: "1" });
      expect(aiList.items.map((item) => item.id)).toEqual([aiOrder.id]);
      await expect(
        getOwnedOrder(userId, mainOrder.id, "ai")
      ).rejects.toMatchObject({ code: "ORDER_NOT_FOUND" });
      await expect(
        getOwnedOrder(userId, aiOrder.id, "main")
      ).rejects.toMatchObject({ code: "ORDER_NOT_FOUND" });

      let createPaymentCalls = 0;
      let queryPaymentCalls = 0;
      const provider = {
        channel: "wechat_h5" as const,
        async createPayment() {
          createPaymentCalls += 1;
          throw new Error("cross-channel provider call");
        },
        async queryPayment() {
          queryPaymentCalls += 1;
          return null;
        },
        async refund() {
          return { channelRefundId: "unused", raw: {} };
        }
      };
      await expect(
        startPayment({
          userId,
          orderId: mainOrder.id,
          productChannel: "ai",
          provider,
          clientIp: "127.0.0.1",
          returnUrl: "https://ai.peileme.art/orders/cross-channel",
          notifyUrl: "/api/test-payments/notify"
        })
      ).rejects.toMatchObject({ code: "ORDER_NOT_FOUND" });
      await expect(
        createInvoiceRequest({
          userId,
          orderId: aiOrder.id,
          productChannel: "main",
          title: "Cross channel",
          email: "cross-channel@peileme.test"
        })
      ).rejects.toMatchObject({ code: "ORDER_NOT_FOUND" });
      expect({ createPaymentCalls, queryPaymentCalls }).toEqual({
        createPaymentCalls: 0,
        queryPaymentCalls: 0
      });
      const token = await signAccessToken({
        id: userId,
        role: "user",
        email: "channel-owner@peileme.test",
        phone: null,
        displayName: null,
        status: "active"
      });
      const app = createApp({ paymentProvider: provider });
      await request(app)
        .get(`/api/commerce/orders/${mainOrder.id}`)
        .set("host", "ai.peileme.art")
        .set("authorization", `Bearer ${token}`)
        .expect(404, {
          error: "ORDER_NOT_FOUND",
          message: "订单不存在"
        });
      for (const action of ["pay", "invoice"]) {
        const crossHost = await request(app)
          .post(`/api/commerce/orders/${mainOrder.id}/${action}`)
          .set("host", "ai.peileme.art")
          .set("authorization", `Bearer ${token}`)
          .send({});
        expect(crossHost.status).toBe(404);
        expect(crossHost.body.error).toBe("ORDER_NOT_FOUND");
      }
      await request(app)
        .post(`/api/commerce/orders/${mainOrder.id}/pay`)
        .set("host", "peileme.art")
        .set("authorization", `Bearer ${token}`)
        .send({})
        .expect(400);
      await request(app)
        .post(`/api/commerce/orders/${mainOrder.id}/invoice`)
        .set("host", "peileme.art")
        .set("authorization", `Bearer ${token}`)
        .send({})
        .expect(400);
      const sideEffects = await query<{
        attempts: string;
        invoices: string;
      }>(
        `SELECT
           (SELECT count(*)::text FROM payment_attempts WHERE order_id = ANY($1::uuid[])) AS attempts,
           (SELECT count(*)::text FROM invoice_requests WHERE order_id = ANY($1::uuid[])) AS invoices`,
        [[mainOrder.id, aiOrder.id]]
      );
      expect(sideEffects.rows[0]).toEqual({
        attempts: "0",
        invoices: "0"
      });
    } finally {
      if (userId) await cleanupEntitlementTestUsers([userId]);
    }
  });

  it("rejects completed, abandoned and wrong-step policy drafts without writes", async () => {
    await seedPolicyFoundation();
    let userId: string | undefined;
    try {
      userId = await createEntitlementTestUser(true);
      const drafts = await query<{ id: string; status: string }>(
        `INSERT INTO assessments(
           user_id,
           visitor_id,
           session_id,
           status,
           current_step,
           answers,
           product_channel,
           input_snapshot,
           completed_at
         )
         VALUES
           (
             $1, 'visitor_completed', 'session_completed', 'completed',
             'result', '{}', 'main', '{}', now()
           ),
           (
             $1, 'visitor_abandoned', 'session_abandoned', 'abandoned',
             'awaiting_entitlement', '{}', 'main', '{}', NULL
           ),
           (
             $1, 'visitor_wrong_step', 'session_wrong_step', 'in_progress',
             'questionnaire', '{}', 'main', '{}', NULL
           )
         RETURNING id, status`,
        [userId]
      );
      for (const draft of drafts.rows) {
        await expect(
          createOrder({
            userId,
            sku: "POLICY_CALC",
            channel: "main",
            idempotencyKey: `invalid-draft-${draft.status}-${draft.id}`,
            businessDraftId: draft.id
          })
        ).rejects.toMatchObject({
          code: "BUSINESS_DRAFT_NOT_FOUND"
        });
      }
      const persisted = await query<{ orders: string; items: string }>(
        `SELECT
           (SELECT count(*)::text FROM orders WHERE user_id = $1) AS orders,
           (
             SELECT count(*)::text
             FROM order_items oi
             JOIN orders o ON o.id = oi.order_id
             WHERE o.user_id = $1
           ) AS items`,
        [userId]
      );
      expect(persisted.rows[0]).toEqual({ orders: "0", items: "0" });
    } finally {
      if (userId) await cleanupEntitlementTestUsers([userId]);
    }
  });

  it("requires an owned ready business draft for every SKU and channel", async () => {
    await seedPolicyFoundation();
    const userIds: string[] = [];
    try {
      const ownerId = await createEntitlementTestUser(true);
      const otherUserId = await createEntitlementTestUser(true);
      userIds.push(ownerId, otherUserId);
      const aiDraftId = await insertPolicyDraft(ownerId, "ai");
      const otherAiDraftId = await insertPolicyDraft(otherUserId, "ai");

      for (const businessDraftId of [undefined, randomUUID(), otherAiDraftId]) {
        await expect(
          createOrder({
            userId: ownerId,
            sku: "AI_DOCUMENT_REVIEW",
            channel: "ai",
            idempotencyKey: `invalid-ai-draft-${randomUUID()}`,
            businessDraftId
          })
        ).rejects.toMatchObject({
          code: "BUSINESS_DRAFT_NOT_FOUND"
        });
      }
      await expect(
        createOrder({
          userId: ownerId,
          sku: "AI_DOCUMENT_REVIEW",
          channel: "main",
          idempotencyKey: `channel-draft-${randomUUID()}`,
          businessDraftId: aiDraftId
        })
      ).rejects.toMatchObject({
        code: "BUSINESS_DRAFT_NOT_FOUND"
      });

      await expect(
        createOrder({
          userId: ownerId,
          sku: "AI_DOCUMENT_REVIEW",
          channel: "ai",
          idempotencyKey: `valid-ai-document-${randomUUID()}`,
          businessDraftId: aiDraftId
        })
      ).resolves.toMatchObject({
        sku: "AI_DOCUMENT_REVIEW",
        channel: "ai",
        businessDraftId: aiDraftId
      });
      await expect(
        createOrder({
          userId: ownerId,
          sku: "AI_SEVERANCE_ANALYSIS",
          channel: "ai",
          idempotencyKey: `valid-ai-analysis-${randomUUID()}`,
          businessDraftId: await insertPolicyDraft(ownerId, "ai")
        })
      ).resolves.toMatchObject({
        sku: "AI_SEVERANCE_ANALYSIS",
        channel: "ai"
      });
    } finally {
      await cleanupEntitlementTestUsers(userIds);
    }
  });

  it("creates one order for concurrent retries and rejects changed intent", async () => {
    await seedPolicyFoundation();
    let userId: string | undefined;
    try {
      userId = await createEntitlementTestUser(true);
      const businessDraftId = await insertPolicyDraft(userId);
      const input = {
        userId,
        sku: "POLICY_CALC",
        channel: "main",
        idempotencyKey: `policy-${randomUUID()}`,
        businessDraftId
      } as const;

      const [first, second] = await Promise.all([
        createOrder(input),
        createOrder(input)
      ]);
      expect(second).toEqual(first);
      expect(first.amountFen).toBe("990");

      await expect(
        createOrder({
          ...input,
          sku: "AI_SEVERANCE_ANALYSIS",
          channel: "ai"
        })
      ).rejects.toMatchObject({
        code: "IDEMPOTENCY_CONFLICT"
      });
      await expect(
        createOrder({
          userId,
          sku: "AI_DOCUMENT_REVIEW",
          channel: "main",
          idempotencyKey: `wrong-site-${randomUUID()}`,
          businessDraftId: await insertPolicyDraft(userId, "main")
        })
      ).rejects.toMatchObject({
        code: "ORDER_CHANNEL_MISMATCH"
      });
      const aiBusinessDraftId = await insertPolicyDraft(userId, "ai");
      await expect(
        createOrder({
          userId,
          sku: "AI_DOCUMENT_REVIEW",
          channel: "ai",
          idempotencyKey: `ai-document-${randomUUID()}`,
          businessDraftId: aiBusinessDraftId
        })
      ).resolves.toMatchObject({
        sku: "AI_DOCUMENT_REVIEW",
        channel: "ai",
        amountFen: "2990"
      });

      let collisionCalls = 0;
      const recoveredOrderNo = `PLMRECOVERED${randomUUID()
        .replaceAll("-", "")
        .toUpperCase()}`;
      await expect(
        createOrder(
          {
            userId,
            sku: "POLICY_CALC",
            channel: "main",
            idempotencyKey: `order-no-retry-${randomUUID()}`,
            businessDraftId: await insertPolicyDraft(userId)
          },
          {
            orderNoFactory: () => {
              collisionCalls += 1;
              return collisionCalls === 1
                ? first.orderNo
                : recoveredOrderNo;
            }
          }
        )
      ).resolves.toMatchObject({ orderNo: recoveredOrderNo });
      expect(collisionCalls).toBe(2);

      let exhaustedCalls = 0;
      await expect(
        createOrder(
          {
            userId,
            sku: "POLICY_CALC",
            channel: "main",
            idempotencyKey: `order-no-exhausted-${randomUUID()}`,
            businessDraftId: await insertPolicyDraft(userId)
          },
          {
            orderNoFactory: () => {
              exhaustedCalls += 1;
              return first.orderNo;
            }
          }
        )
      ).rejects.toMatchObject({
        code: "ORDER_NUMBER_GENERATION_FAILED"
      });
      expect(exhaustedCalls).toBe(3);
      await query(
        "UPDATE orders SET created_at = TIMESTAMPTZ '2026-01-01 00:00:00+00' WHERE user_id = $1",
        [userId]
      );
      const expectedOrder = await query<{ id: string }>(
        "SELECT id FROM orders WHERE user_id = $1 AND product_channel = 'main' ORDER BY created_at DESC, id DESC",
        [userId]
      );
      const [pageOne, pageTwo] = await Promise.all([
        listOwnedOrders(userId, 1, 2, "main"),
        listOwnedOrders(userId, 2, 2, "main")
      ]);
      expect([
        ...pageOne.items.map((item) => item.id),
        ...pageTwo.items.map((item) => item.id)
      ]).toEqual(expectedOrder.rows.map((row) => row.id));
      const persisted = await query<{ orders: string; items: string }>(
        `SELECT
           count(DISTINCT o.id)::text AS orders,
           count(oi.id)::text AS items
         FROM orders o
         LEFT JOIN order_items oi ON oi.order_id = o.id
         WHERE o.user_id = $1
           AND o.idempotency_key = $2`,
        [userId, input.idempotencyKey]
      );
      expect(persisted.rows[0]).toEqual({ orders: "1", items: "1" });
    } finally {
      if (userId) await cleanupEntitlementTestUsers([userId]);
    }
  });

  it("fulfills a verified payment once", async () => {
    await seedPolicyFoundation();
    let userId: string | undefined;
    try {
      userId = await createEntitlementTestUser(true);
      const businessDraftId = await insertPolicyDraft(userId);
      const order = await createOrder({
        userId,
        sku: "POLICY_CALC",
        channel: "main",
        idempotencyKey: `paid-${randomUUID()}`,
        businessDraftId
      });
      const attempt = await insertIdentityAwarePaymentAttempt({
        orderId: order.id,
        channel: "wechat_h5",
        status: "PENDING"
      });
      const verified = {
        providerOrderNo: attempt.providerOrderNo,
        channel: "wechat_h5" as const,
        channelTransactionId: `fake-${randomUUID()}`,
        amountFen: order.amountFen,
        currency: "CNY" as const,
        paidAt: new Date().toISOString(),
        raw: { source: "task3-red" }
      };

      const completed = await markOrderPaid({
        orderId: order.id,
        paymentAttemptId: attempt.id,
        verified
      });
      await expect(
        markOrderPaid({
          orderId: order.id,
          paymentAttemptId: attempt.id,
          verified
        })
      ).resolves.toEqual(completed);

      const persisted = await query<{
        transactions: string;
        entitlements: string;
        order_status: string;
        attempt_status: string;
      }>(
        `SELECT
           (SELECT count(*)::text FROM payment_transactions WHERE order_id = $1)
             AS transactions,
           (SELECT count(*)::text FROM entitlements WHERE source_id = $1)
             AS entitlements,
           (SELECT status FROM orders WHERE id = $1) AS order_status,
           (SELECT status FROM payment_attempts WHERE id = $2) AS attempt_status`,
        [order.id, attempt.id]
      );
      expect(persisted.rows[0]).toEqual({
        transactions: "1",
        entitlements: "1",
        order_status: "COMPLETED",
        attempt_status: "SUCCEEDED"
      });
    } finally {
      if (userId) await cleanupEntitlementTestUsers([userId]);
    }
  });

  it("sanitizes nested provider create evidence before persisting it", async () => {
    await seedPolicyFoundation();
    let userId: string | undefined;
    try {
      userId = await createEntitlementTestUser(true);
      const order = await createOrder({
        userId,
        sku: "POLICY_CALC",
        channel: "main",
        idempotencyKey: `create-evidence-${randomUUID()}`,
        businessDraftId: await insertPolicyDraft(userId)
      });
      const sentinels = {
        authorization: `Bearer-${randomUUID()}`,
        signature: `Signature-${randomUUID()}`,
        token: `Token-${randomUUID()}`,
        secret: `Secret-${randomUUID()}`,
        privateKey: `Private-${randomUUID()}`,
        apiKey: `Api-${randomUUID()}`,
        payer: `Payer-${randomUUID()}`,
        openid: `Openid-${randomUUID()}`,
        buyerIds: `Buyer-${randomUUID()}`,
        phone: `Phone-${randomUUID()}`,
        email: `Email-${randomUUID()}`
      };
      await startPayment({
        userId,
        orderId: order.id,
        productChannel: "main",
        clientIp: "127.0.0.1",
        returnUrl: "https://peileme.test/return",
        notifyUrl: "https://peileme.test/notify",
        provider: paymentProviderWithResponse({
          safe: { code: "CREATE_OK" },
          authorization: sentinels.authorization,
          nested: {
            publicStatus: "accepted",
            "x-signature": sentinels.signature,
            access_token: sentinels.token,
            clientSecret: sentinels.secret,
            private_key: sentinels.privateKey,
            apiKey: sentinels.apiKey,
            payer: { value: sentinels.payer },
            openid: sentinels.openid,
            buyer_ids: [sentinels.buyerIds],
            phone_number: sentinels.phone,
            emailAddress: sentinels.email
          }
        })
      });
      const persisted = await query<{ response_snapshot: unknown }>(
        `SELECT response_snapshot
           FROM payment_attempts
          WHERE order_id = $1`,
        [order.id]
      );
      expect(persisted.rows[0].response_snapshot).toEqual({
        safe: { code: "CREATE_OK" },
        nested: { publicStatus: "accepted" }
      });
      const serialized = JSON.stringify(
        persisted.rows[0].response_snapshot
      );
      for (const sentinel of Object.values(sentinels)) {
        expect(serialized).not.toContain(sentinel);
      }
    } finally {
      if (userId) await cleanupEntitlementTestUsers([userId]);
    }
  });

  it("sanitizes verified evidence while preserving structured payment facts", async () => {
    await seedPolicyFoundation();
    let userId: string | undefined;
    try {
      userId = await createEntitlementTestUser(true);
      const order = await createOrder({
        userId,
        sku: "POLICY_CALC",
        channel: "main",
        idempotencyKey: `verified-evidence-${randomUUID()}`,
        businessDraftId: await insertPolicyDraft(userId)
      });
      const attempt = await insertIdentityAwarePaymentAttempt({
        orderId: order.id,
        channel: "wechat_h5",
        status: "PENDING"
      });
      const channelTransactionId = `verified-evidence-${randomUUID()}`;
      const secret = `VERIFIED_SECRET_${randomUUID()}`;
      await markOrderPaid({
        orderId: order.id,
        paymentAttemptId: attempt.id,
        verified: {
          providerOrderNo: attempt.providerOrderNo,
          channel: "wechat_h5",
          channelTransactionId,
          amountFen: order.amountFen,
          currency: "CNY",
          paidAt: new Date().toISOString(),
          raw: {
            safe: { providerState: "paid" },
            nested: {
              authorization: secret,
              buyer_ids: [secret],
              contact: { phone: secret, email: secret }
            }
          }
        }
      });
      const persisted = await query<{
        channel_transaction_id: string;
        amount_fen: string;
        currency: string;
        verified_payload: unknown;
      }>(
        `SELECT
           channel_transaction_id,
           amount_fen,
           currency,
           verified_payload
         FROM payment_transactions
         WHERE order_id = $1`,
        [order.id]
      );
      expect(persisted.rows[0]).toEqual({
        channel_transaction_id: channelTransactionId,
        amount_fen: order.amountFen,
        currency: "CNY",
        verified_payload: {
          safe: { providerState: "paid" },
          nested: { contact: {} }
        }
      });
      expect(JSON.stringify(persisted.rows[0].verified_payload)).not.toContain(
        secret
      );
    } finally {
      if (userId) await cleanupEntitlementTestUsers([userId]);
    }
  });

  it("persists circular and BigInt evidence without serialization failures", async () => {
    await seedPolicyFoundation();
    let userId: string | undefined;
    try {
      userId = await createEntitlementTestUser(true);
      const order = await createOrder({
        userId,
        sku: "POLICY_CALC",
        channel: "main",
        idempotencyKey: `cyclic-evidence-${randomUUID()}`,
        businessDraftId: await insertPolicyDraft(userId)
      });
      const cyclic: Record<string, unknown> = {
        safe: "kept",
        largeCounter: 9_007_199_254_740_993n
      };
      cyclic.self = cyclic;
      await expect(
        startPayment({
          userId,
          orderId: order.id,
          productChannel: "main",
          clientIp: "127.0.0.1",
          returnUrl: "https://peileme.test/return",
          notifyUrl: "https://peileme.test/notify",
          provider: paymentProviderWithResponse(cyclic)
        })
      ).resolves.toMatchObject({ status: "PAYING" });
      const persisted = await query<{ response_snapshot: unknown }>(
        `SELECT response_snapshot
           FROM payment_attempts
          WHERE order_id = $1`,
        [order.id]
      );
      expect(persisted.rows[0].response_snapshot).toEqual({
        safe: "kept",
        largeCounter: "9007199254740993",
        self: "[Circular]"
      });
    } finally {
      if (userId) await cleanupEntitlementTestUsers([userId]);
    }
  });

  it("replaces every oversized evidence shape with a bounded hash marker", async () => {
    await seedPolicyFoundation();
    const userIds: string[] = [];
    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let depth = 0; depth < 12; depth += 1) {
      const next: Record<string, unknown> = {};
      cursor.next = next;
      cursor = next;
    }
    const tooManyKeys = Object.fromEntries(
      Array.from({ length: 150 }, (_, index) => [`key${index}`, index])
    );
    const largeTotal = Object.fromEntries(
      Array.from(
        { length: 90 },
        (_, index) => [`chunk${index}`, "x".repeat(1_000)]
      )
    );
    const cases: Array<[string, Record<string, unknown>]> = [
      ["depth", deep],
      ["array", { items: Array.from({ length: 101 }, (_, index) => index) }],
      ["keys", tooManyKeys],
      ["string", { message: "x".repeat(5_000) }],
      ["total", largeTotal]
    ];
    try {
      for (const [name, response] of cases) {
        const userId = await createEntitlementTestUser(true);
        userIds.push(userId);
        const order = await createOrder({
          userId,
          sku: "POLICY_CALC",
          channel: "main",
          idempotencyKey: `oversized-${name}-${randomUUID()}`,
          businessDraftId: await insertPolicyDraft(userId)
        });
        await startPayment({
          userId,
          orderId: order.id,
          productChannel: "main",
          clientIp: "127.0.0.1",
          returnUrl: "https://peileme.test/return",
          notifyUrl: "https://peileme.test/notify",
          provider: paymentProviderWithResponse(response)
        });
        const persisted = await query<{ response_snapshot: unknown }>(
          `SELECT response_snapshot
             FROM payment_attempts
            WHERE order_id = $1`,
          [order.id]
        );
        expect(persisted.rows[0].response_snapshot, name).toEqual({
          _truncated: true,
          _reason: "evidence_limits_exceeded",
          _sha256: expect.stringMatching(/^[0-9a-f]{64}$/)
        });
        expect(
          Buffer.byteLength(
            JSON.stringify(persisted.rows[0].response_snapshot),
            "utf8"
          ),
          name
        ).toBeLessThan(256);
      }
    } finally {
      await cleanupEntitlementTestUsers(userIds);
    }
  });

  it("rejects provider payments made after expiry while preserving the payment fact", async () => {
    await seedPolicyFoundation();
    let userId: string | undefined;
    try {
      userId = await createEntitlementTestUser(true);
      const order = await createOrder({
        userId,
        sku: "POLICY_CALC",
        channel: "main",
        idempotencyKey: `late-provider-payment-${randomUUID()}`,
        businessDraftId: await insertPolicyDraft(userId)
      });
      const attempt = await insertIdentityAwarePaymentAttempt({
        orderId: order.id,
        channel: "wechat_h5",
        status: "PENDING"
      });
      await query(
        `UPDATE orders
         SET status = 'PAYING',
             created_at = now() - interval '2 minutes',
             expires_at = now() - interval '1 minute'
         WHERE id = $1`,
        [order.id]
      );
      const baseVerified = {
        providerOrderNo: attempt.providerOrderNo,
        channel: "wechat_h5" as const,
        channelTransactionId: `late-${randomUUID()}`,
        amountFen: order.amountFen,
        currency: "CNY" as const,
        raw: { source: "late-provider-payment" }
      };
      await expect(
        markOrderPaid({
          orderId: order.id,
          paymentAttemptId: attempt.id,
          verified: {
            ...baseVerified,
            paidAt: new Date().toISOString()
          }
        })
      ).rejects.toMatchObject({
        code: "PAYMENT_VERIFICATION_FAILED"
      });
      const rejected = await query<{
        order_status: string;
        attempt_status: string;
        anomalies: string;
        transactions: string;
        entitlements: string;
      }>(
        `SELECT
           (SELECT status FROM orders WHERE id = $1) AS order_status,
           (SELECT status FROM payment_attempts WHERE id = $2)
             AS attempt_status,
           (SELECT count(*)::text FROM payment_anomalies WHERE order_id = $1)
             AS anomalies,
           (SELECT count(*)::text FROM payment_transactions WHERE order_id = $1)
             AS transactions,
           (SELECT count(*)::text FROM entitlements WHERE source_id = $1)
             AS entitlements`,
        [order.id, attempt.id]
      );
      expect(rejected.rows[0]).toEqual({
        order_status: "CLOSED",
        attempt_status: "CLOSED",
        anomalies: "1",
        transactions: "1",
        entitlements: "0"
      });

      await expect(
        markOrderPaid({
          orderId: order.id,
          paymentAttemptId: attempt.id,
          verified: {
            ...baseVerified,
            paidAt: new Date(Date.now() - 120_000).toISOString()
          }
        })
      ).rejects.toMatchObject({ code: "PAYMENT_VERIFICATION_FAILED" });
    } finally {
      if (userId) await cleanupEntitlementTestUsers([userId]);
    }
  });

  it("keeps the legal order unchanged when payment identity evidence is forged", async () => {
    await seedPolicyFoundation();
    const userIds: string[] = [];
    try {
      const userId = await createEntitlementTestUser(true);
      userIds.push(userId);
      const makeOrder = async (marker: string) => {
        const order = await createOrder({
          userId,
          sku: "POLICY_CALC",
          channel: "main",
          idempotencyKey: `${marker}-${randomUUID()}`,
          businessDraftId: await insertPolicyDraft(userId)
        });
        const attempt = await insertIdentityAwarePaymentAttempt({
          orderId: order.id,
          channel: "wechat_h5",
          status: "PENDING"
        });
        await query(
          "UPDATE orders SET status = 'PAYING' WHERE id = $1",
          [order.id]
        );
        return {
          order,
          attemptId: attempt.id,
          providerOrderNo: attempt.providerOrderNo
        };
      };
      const legal = await makeOrder("identity-legal");
      const foreign = await makeOrder("identity-foreign");
      const base = {
        providerOrderNo: legal.providerOrderNo,
        channel: "wechat_h5" as const,
        channelTransactionId: `identity-${randomUUID()}`,
        amountFen: legal.order.amountFen,
        currency: "CNY" as const,
        paidAt: new Date().toISOString(),
        raw: { source: "identity-boundary" }
      };
      const invalid = await Promise.allSettled([
        markOrderPaid({
          orderId: legal.order.id,
          paymentAttemptId: legal.attemptId,
          verified: {
            ...base,
            providerOrderNo: foreign.providerOrderNo,
            channelTransactionId: `wrong-order-${randomUUID()}`
          }
        }),
        markOrderPaid({
          orderId: legal.order.id,
          paymentAttemptId: legal.attemptId,
          verified: {
            ...base,
            channel: "alipay_wap",
            channelTransactionId: `wrong-channel-${randomUUID()}`
          }
        }),
        markOrderPaid({
          orderId: legal.order.id,
          paymentAttemptId: legal.attemptId,
          verified: {
            ...base,
            channelTransactionId: "   "
          }
        }),
        markOrderPaid({
          orderId: legal.order.id,
          paymentAttemptId: foreign.attemptId,
          verified: {
            ...base,
            channelTransactionId: `wrong-attempt-${randomUUID()}`
          }
        })
      ]);
      expect(invalid).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            status: "rejected",
            reason: expect.objectContaining({
              code: "PAYMENT_VERIFICATION_FAILED"
            })
          })
        ])
      );
      expect(
        invalid.every(
          (result) =>
            result.status === "rejected" &&
            result.reason.code === "PAYMENT_VERIFICATION_FAILED"
        )
      ).toBe(true);
      const unchanged = await query<{
        order_status: string;
        attempt_status: string;
        reconciliation_state: string;
        anomalies: string;
        transactions: string;
        entitlements: string;
      }>(
        `SELECT
           o.status AS order_status,
           pa.status AS attempt_status,
           pa.reconciliation_state,
           (SELECT count(*)::text
              FROM payment_anomalies
             WHERE order_id = o.id) AS anomalies,
           (SELECT count(*)::text
              FROM payment_transactions
             WHERE order_id = o.id) AS transactions,
           (SELECT count(*)::text
              FROM entitlements
             WHERE source_id = o.id) AS entitlements
         FROM orders o
         JOIN payment_attempts pa ON pa.id = $2
         WHERE o.id = $1`,
        [legal.order.id, legal.attemptId]
      );
      expect(unchanged.rows[0]).toEqual({
        order_status: "PAYING",
        attempt_status: "PENDING",
        reconciliation_state: "NONE",
        anomalies: "0",
        transactions: "0",
        entitlements: "0"
      });
      await expect(
        markOrderPaid({
          orderId: legal.order.id,
          paymentAttemptId: legal.attemptId,
          verified: {
            ...base,
            channelTransactionId: `legal-${randomUUID()}`
          }
        })
      ).resolves.toMatchObject({ status: "COMPLETED" });
    } finally {
      await cleanupEntitlementTestUsers(userIds);
    }
  });

  it("persists one sanitized mismatch anomaly for the canonical provider identity", async () => {
    await seedPolicyFoundation();
    let userId: string | undefined;
    try {
      userId = await createEntitlementTestUser(true);
      const order = await createOrder({
        userId,
        sku: "POLICY_CALC",
        channel: "main",
        idempotencyKey: `mismatch-anomaly-${randomUUID()}`,
        businessDraftId: await insertPolicyDraft(userId)
      });
      await insertIdentityAwarePaymentAttempt({
        orderId: order.id,
        channel: "wechat_h5",
        status: "CLOSED",
        providerOrderNo: `WXOLD${randomUUID().replaceAll("-", "").slice(0, 24)}`,
        requestSnapshot: { marker: "old-wechat" },
        createdAt: new Date(Date.now() - 4 * 60_000)
      });
      await insertIdentityAwarePaymentAttempt({
        orderId: order.id,
        channel: "alipay_wap",
        status: "CLOSED",
        requestSnapshot: { marker: "old-alipay" },
        createdAt: new Date(Date.now() - 3 * 60_000)
      });
      const selected = await insertIdentityAwarePaymentAttempt({
        orderId: order.id,
        channel: "wechat_h5",
        status: "PENDING",
        requestSnapshot: { marker: "selected" },
        createdAt: new Date(Date.now() - 60_000)
      });
      await query(
        "UPDATE orders SET status = 'PAYING' WHERE id = $1",
        [order.id]
      );
      const rawSecret = `RAW_MUST_NOT_PERSIST_${randomUUID()}`;
      const longTransactionId =
        `mismatch-\n${"x".repeat(220)}-${randomUUID()}`;
      const verified = {
        providerOrderNo: selected.providerOrderNo,
        channel: "wechat_h5" as const,
        channelTransactionId: longTransactionId,
        amountFen: (BigInt(order.amountFen) + 1n).toString(),
        currency: "CNY" as const,
        paidAt: new Date().toISOString(),
        raw: {
          secret: rawSecret,
          nested: { credential: "provider-private-material" }
        }
      };
      const outcomes = await Promise.allSettled([
        markOrderPaid({
          orderId: order.id,
          paymentAttemptId: selected.id,
          verified
        }),
        markOrderPaid({
          orderId: order.id,
          paymentAttemptId: selected.id,
          verified
        })
      ]);
      expect(
        outcomes.every(
          (result) =>
            result.status === "rejected" &&
            result.reason.code === "PAYMENT_VERIFICATION_FAILED"
        )
      ).toBe(true);
      const persisted = await query<{
        order_status: string;
        kind: string;
        anomaly_status: string;
        attempt_channel: string;
        provider_channel: string;
        channel_transaction_id: string;
        provider_order_no: string;
        amount_fen: string;
        currency: string;
        paid_at: Date | null;
        anomalies: string;
        transactions: string;
        entitlements: string;
        serialized: string;
      }>(
        `SELECT
           o.status AS order_status,
           anomaly.kind,
           anomaly.status AS anomaly_status,
           anomaly.attempt_channel,
           anomaly.provider_channel,
           anomaly.channel_transaction_id,
           anomaly.provider_order_no,
           anomaly.amount_fen,
           anomaly.currency,
           anomaly.paid_at,
           (SELECT count(*)::text
              FROM payment_anomalies
             WHERE order_id = o.id) AS anomalies,
           (SELECT count(*)::text
              FROM payment_transactions
             WHERE order_id = o.id) AS transactions,
           (SELECT count(*)::text
              FROM entitlements
             WHERE source_id = o.id) AS entitlements,
           row_to_json(anomaly)::text AS serialized
         FROM orders o
         JOIN payment_anomalies anomaly ON anomaly.order_id = o.id
         WHERE o.id = $1`,
        [order.id]
      );
      expect(persisted.rows[0]).toMatchObject({
        order_status: "CLOSED",
        kind: "PAYMENT_VERIFICATION_FAILED",
        anomaly_status: "PENDING_REVIEW",
        attempt_channel: "wechat_h5",
        provider_channel: "wechat_h5",
        provider_order_no: selected.providerOrderNo,
        amount_fen: verified.amountFen,
        currency: "CNY",
        paid_at: expect.any(Date),
        anomalies: "1",
        transactions: "0",
        entitlements: "0"
      });
      expect(persisted.rows[0].channel_transaction_id.length).toBeLessThanOrEqual(
        160
      );
      expect(persisted.rows[0].channel_transaction_id).not.toMatch(
        /[\u0000-\u001f\u007f]/
      );
      expect(persisted.rows[0].serialized).not.toContain(rawSecret);
      expect(persisted.rows[0].serialized).not.toContain(
        "provider-private-material"
      );
      const attemptStates = await query<{
        marker: string;
        status: string;
        reconciliation_state: string;
        reconciliation_last_result: string | null;
        scheduled: boolean;
      }>(
        `SELECT
           request_snapshot->>'marker' AS marker,
           status,
           reconciliation_state,
           reconciliation_last_result,
           reconciliation_next_at IS NOT NULL
             AND reconciliation_deadline_at IS NOT NULL AS scheduled
         FROM payment_attempts
         WHERE order_id = $1
         ORDER BY marker`,
        [order.id]
      );
      expect(attemptStates.rows).toEqual([
        {
          marker: "old-alipay",
          status: "CLOSED",
          reconciliation_state: "NONE",
          reconciliation_last_result: null,
          scheduled: false
        },
        {
          marker: "old-wechat",
          status: "CLOSED",
          reconciliation_state: "NONE",
          reconciliation_last_result: null,
          scheduled: false
        },
        {
          marker: "selected",
          status: "CLOSED",
          reconciliation_state: "TERMINAL",
          reconciliation_last_result: "PAYMENT_VERIFICATION_FAILED",
          scheduled: false
        }
      ]);
      const conflictingOrder = await createOrder({
        userId,
        sku: "POLICY_CALC",
        channel: "main",
        idempotencyKey: `mismatch-owner-conflict-${randomUUID()}`,
        businessDraftId: await insertPolicyDraft(userId)
      });
      const conflictingAttempt = await insertIdentityAwarePaymentAttempt({
        orderId: conflictingOrder.id,
        channel: "wechat_h5",
        status: "PENDING"
      });
      await query(
        "UPDATE orders SET status = 'PAYING' WHERE id = $1",
        [conflictingOrder.id]
      );
      await expect(
        markOrderPaid({
          orderId: conflictingOrder.id,
          paymentAttemptId: conflictingAttempt.id,
          verified: {
            ...verified,
            providerOrderNo: conflictingAttempt.providerOrderNo,
            amountFen: (
              BigInt(conflictingOrder.amountFen) + 1n
            ).toString()
          }
        })
      ).rejects.toMatchObject({
        code: "PAYMENT_VERIFICATION_FAILED"
      });
      const conflictState = await query<{
        order_status: string;
        attempt_status: string;
        anomalies: string;
        provider_transaction_anomalies: string;
      }>(
        `SELECT
           o.status AS order_status,
           pa.status AS attempt_status,
           (SELECT count(*)::text
              FROM payment_anomalies
             WHERE order_id = o.id) AS anomalies,
           (SELECT count(*)::text
              FROM payment_anomalies
             WHERE provider_channel = 'wechat_h5'
               AND channel_transaction_id = $3)
             AS provider_transaction_anomalies
         FROM orders o
         JOIN payment_attempts pa ON pa.id = $2
         WHERE o.id = $1`,
        [
          conflictingOrder.id,
          conflictingAttempt.id,
          persisted.rows[0].channel_transaction_id
        ]
      );
      expect(conflictState.rows[0]).toEqual({
        order_status: "PAYING",
        attempt_status: "PENDING",
        anomalies: "0",
        provider_transaction_anomalies: "1"
      });
    } finally {
      if (userId) await cleanupEntitlementTestUsers([userId]);
    }
  });

  it("commits a startPayment late-payment anomaly before rejecting and skips repeat provider queries", async () => {
    await seedPolicyFoundation();
    let userId: string | undefined;
    try {
      userId = await createEntitlementTestUser(true);
      const order = await createOrder({
        userId,
        sku: "POLICY_CALC",
        channel: "main",
        idempotencyKey: `start-late-anomaly-${randomUUID()}`,
        businessDraftId: await insertPolicyDraft(userId)
      });
      const attempt = await insertIdentityAwarePaymentAttempt({
        orderId: order.id,
        channel: "wechat_h5",
        status: "PENDING"
      });
      await query(
        `UPDATE orders
         SET status = 'PAYING',
             created_at = now() - interval '3 minutes',
             expires_at = now() - interval '1 minute'
         WHERE id = $1`,
        [order.id]
      );
      let queryCalls = 0;
      const lateTransactionId = `start-late-${randomUUID()}`;
      const provider = {
        channel: "wechat_h5" as const,
        async createPayment() {
          throw new Error("must not create");
        },
        async queryPayment(orderNo: string) {
          queryCalls += 1;
          return {
            providerOrderNo: orderNo,
            channel: "wechat_h5" as const,
            channelTransactionId: lateTransactionId,
            amountFen: order.amountFen,
            currency: "CNY" as const,
            paidAt: new Date().toISOString(),
            raw: { secret: "START_LATE_RAW_MUST_NOT_PERSIST" }
          };
        },
        async refund() {
          return { channelRefundId: "unused", raw: {} };
        }
      };
      const start = () =>
        startPayment({
          userId: userId!,
          orderId: order.id,
          productChannel: order.channel,
          provider,
          clientIp: "127.0.0.1",
          returnUrl: "http://peileme.test/return",
          notifyUrl: "http://peileme.test/notify",
          providerTimeoutMs: 100
        });

      await expect(start()).rejects.toMatchObject({
        code: "PAYMENT_VERIFICATION_FAILED"
      });
      await expect(start()).rejects.toMatchObject({
        code: "ORDER_STATE_CONFLICT"
      });
      expect(queryCalls).toBe(1);
      const persisted = await query<{
        order_status: string;
        attempt_status: string;
        reconciliation_state: string;
        reconciliation_last_result: string;
        kind: string;
        anomalies: string;
        transactions: string;
        transaction_attempt_id: string;
        transaction_channel: string;
        channel_transaction_id: string;
        transaction_amount_fen: string;
        transaction_currency: string;
        entitlements: string;
        serialized: string;
      }>(
        `SELECT
           o.status AS order_status,
           pa.status AS attempt_status,
           pa.reconciliation_state,
           pa.reconciliation_last_result,
           anomaly.kind,
           (SELECT count(*)::text
              FROM payment_anomalies
             WHERE order_id = o.id) AS anomalies,
           (SELECT count(*)::text
              FROM payment_transactions
             WHERE order_id = o.id) AS transactions,
           transaction.payment_attempt_id AS transaction_attempt_id,
           transaction.channel AS transaction_channel,
           transaction.channel_transaction_id,
           transaction.amount_fen::text AS transaction_amount_fen,
           transaction.currency AS transaction_currency,
           (SELECT count(*)::text
              FROM entitlements
             WHERE source_id = o.id) AS entitlements,
           row_to_json(anomaly)::text AS serialized
         FROM orders o
         JOIN payment_attempts pa ON pa.id = $2
         JOIN payment_anomalies anomaly
           ON anomaly.payment_attempt_id = pa.id
         JOIN payment_transactions transaction
           ON transaction.order_id = o.id
          AND transaction.payment_attempt_id = pa.id
          AND transaction.status = 'SUCCESS'
         WHERE o.id = $1`,
        [order.id, attempt.id]
      );
      expect(persisted.rows[0]).toMatchObject({
        order_status: "CLOSED",
        attempt_status: "CLOSED",
        reconciliation_state: "TERMINAL",
        reconciliation_last_result: "PAYMENT_AFTER_EXPIRY",
        kind: "PAYMENT_AFTER_EXPIRY",
        anomalies: "1",
        transactions: "1",
        transaction_attempt_id: attempt.id,
        transaction_channel: "wechat_h5",
        channel_transaction_id: lateTransactionId,
        transaction_amount_fen: order.amountFen,
        transaction_currency: "CNY",
        entitlements: "0"
      });
      expect(persisted.rows[0].serialized).not.toContain(
        "START_LATE_RAW_MUST_NOT_PERSIST"
      );
    } finally {
      if (userId) await cleanupEntitlementTestUsers([userId]);
    }
  });

  it("terminalizes open worker late and mismatch results without a hot loop", async () => {
    await seedPolicyFoundation();
    const userIds: string[] = [];
    try {
      for (const anomalyCase of [
        {
          marker: "worker-late",
          kind: "PAYMENT_AFTER_EXPIRY",
          amountDelta: 0n,
          paidAtOffsetMs: 0
        },
        {
          marker: "worker-mismatch",
          kind: "PAYMENT_VERIFICATION_FAILED",
          amountDelta: 1n,
          paidAtOffsetMs: -120_000
        }
      ] as const) {
        const userId = await createEntitlementTestUser(true);
        userIds.push(userId);
        const order = await createOrder({
          userId,
          sku: "POLICY_CALC",
          channel: "main",
          idempotencyKey: `${anomalyCase.marker}-${randomUUID()}`,
          businessDraftId: await insertPolicyDraft(userId)
        });
        const attempt = await insertIdentityAwarePaymentAttempt({
          orderId: order.id,
          channel: "wechat_h5",
          status: "PENDING"
        });
        await query(
          `UPDATE orders
           SET status = 'PAYING',
               created_at = now() - interval '3 minutes',
               expires_at = now() - interval '1 minute'
           WHERE id = $1`,
          [order.id]
        );
        let queryCalls = 0;
        const provider = {
          channel: "wechat_h5" as const,
          async createPayment() {
            throw new Error("must not create");
          },
          async queryPayment(orderNo: string) {
            queryCalls += 1;
            return {
              providerOrderNo: orderNo,
              channel: "wechat_h5" as const,
              channelTransactionId:
                `${anomalyCase.marker}-${randomUUID()}`,
              amountFen: (
                BigInt(order.amountFen) + anomalyCase.amountDelta
              ).toString(),
              currency: "CNY" as const,
              paidAt: new Date(
                Date.now() + anomalyCase.paidAtOffsetMs
              ).toISOString(),
              raw: { secret: `${anomalyCase.marker}-raw` }
            };
          },
          async refund() {
            return { channelRefundId: "unused", raw: {} };
          }
        };
        const first = await reconcileAndCloseExpiredOrders({
          provider,
          limit: 5,
          providerQueryBudget: 1,
          providerTimeoutMs: 100
        });
        const repeated = await reconcileAndCloseExpiredOrders({
          provider,
          limit: 5,
          providerQueryBudget: 1,
          providerTimeoutMs: 100
        });
        expect(queryCalls).toBe(1);
        expect(first.summary).toMatchObject({
          scannedCount: 1,
          providerConfirmedPaidCount: 0,
          deferredCount: 0,
          terminalCount: 1,
          hasMore: false,
          scheduledRecoveryCount: 0,
          deferredByReason: {
            paymentVerificationFailed: 0
          },
          closedRecovery: {
            scannedCount: 0,
            terminalCount: 0,
            terminalByReason: {
              deadlineExceeded: 0,
              noPaymentLimitExceeded: 0,
              paymentAfterExpiry: 0,
              paymentVerificationFailed: 0
            }
          }
        });
        expect(repeated.summary).toMatchObject({
          scannedCount: 0,
          providerConfirmedPaidCount: 0,
          deferredCount: 0,
          hasMore: false,
          scheduledRecoveryCount: 0
        });
        const persisted = await query<{
          order_status: string;
          attempt_status: string;
          reconciliation_state: string;
          reconciliation_last_result: string;
          kind: string;
          anomalies: string;
          transactions: string;
          entitlements: string;
        }>(
          `SELECT
             o.status AS order_status,
             pa.status AS attempt_status,
             pa.reconciliation_state,
             pa.reconciliation_last_result,
             anomaly.kind,
             (SELECT count(*)::text
                FROM payment_anomalies
               WHERE order_id = o.id) AS anomalies,
             (SELECT count(*)::text
                FROM payment_transactions
               WHERE order_id = o.id) AS transactions,
             (SELECT count(*)::text
                FROM entitlements
               WHERE source_id = o.id) AS entitlements
           FROM orders o
           JOIN payment_attempts pa ON pa.id = $2
           JOIN payment_anomalies anomaly
             ON anomaly.payment_attempt_id = pa.id
           WHERE o.id = $1`,
          [order.id, attempt.id]
        );
        expect(persisted.rows[0]).toMatchObject({
          order_status: "CLOSED",
          attempt_status: "CLOSED",
          reconciliation_state: "TERMINAL",
          reconciliation_last_result: anomalyCase.kind,
          kind: anomalyCase.kind,
          anomalies: "1",
          transactions:
            anomalyCase.kind === "PAYMENT_AFTER_EXPIRY" ? "1" : "0",
          entitlements: "0"
        });
      }
    } finally {
      await cleanupEntitlementTestUsers(userIds);
    }
  });

  it("records a second verified payment after completion once without granting twice", async () => {
    await seedPolicyFoundation();
    let userId: string | undefined;
    try {
      userId = await createEntitlementTestUser(true);
      const order = await createOrder({
        userId,
        sku: "POLICY_CALC",
        channel: "main",
        idempotencyKey: `duplicate-payment-${randomUUID()}`,
        businessDraftId: await insertPolicyDraft(userId)
      });
      const firstAttempt = await insertIdentityAwarePaymentAttempt({
        orderId: order.id,
        channel: "wechat_h5",
        status: "PENDING"
      });
      const firstVerified = {
        providerOrderNo: firstAttempt.providerOrderNo,
        channel: "wechat_h5" as const,
        channelTransactionId: `first-paid-${randomUUID()}`,
        amountFen: order.amountFen,
        currency: "CNY" as const,
        paidAt: new Date().toISOString(),
        raw: { source: "first-payment" }
      };
      const completed = await markOrderPaid({
        orderId: order.id,
        paymentAttemptId: firstAttempt.id,
        verified: firstVerified
      });
      await expect(
        markOrderPaid({
          orderId: order.id,
          paymentAttemptId: firstAttempt.id,
          verified: firstVerified
        })
      ).resolves.toEqual(completed);
      const secondAttempt = await insertIdentityAwarePaymentAttempt({
        orderId: order.id,
        channel: "alipay_wap",
        status: "PENDING"
      });
      const rawSecret = `DUPLICATE_RAW_${randomUUID()}`;
      const duplicateVerified = {
        providerOrderNo: secondAttempt.providerOrderNo,
        channel: "alipay_wap" as const,
        channelTransactionId: `second-paid-${randomUUID()}`,
        amountFen: order.amountFen,
        currency: "CNY" as const,
        paidAt: new Date().toISOString(),
        raw: { secret: rawSecret }
      };
      const duplicates = await Promise.allSettled([
        markOrderPaid({
          orderId: order.id,
          paymentAttemptId: secondAttempt.id,
          verified: duplicateVerified
        }),
        markOrderPaid({
          orderId: order.id,
          paymentAttemptId: secondAttempt.id,
          verified: duplicateVerified
        })
      ]);
      expect(
        duplicates.every(
          (result) =>
            result.status === "rejected" &&
            result.reason.code === "PAYMENT_VERIFICATION_FAILED"
        )
      ).toBe(true);
      const persisted = await query<{
        order_status: string;
        second_status: string;
        second_state: string;
        second_result: string;
        kind: string;
        anomaly_status: string;
        anomalies: string;
        transactions: string;
        entitlements: string;
        serialized: string;
      }>(
        `SELECT
           o.status AS order_status,
           second.status AS second_status,
           second.reconciliation_state AS second_state,
           second.reconciliation_last_result AS second_result,
           anomaly.kind,
           anomaly.status AS anomaly_status,
           (SELECT count(*)::text
              FROM payment_anomalies
             WHERE order_id = o.id) AS anomalies,
           (SELECT count(*)::text
              FROM payment_transactions
             WHERE order_id = o.id) AS transactions,
           (SELECT count(*)::text
              FROM entitlements
             WHERE source_id = o.id) AS entitlements,
           row_to_json(anomaly)::text AS serialized
         FROM orders o
         JOIN payment_attempts second ON second.id = $2
         JOIN payment_anomalies anomaly
           ON anomaly.payment_attempt_id = second.id
         WHERE o.id = $1`,
        [order.id, secondAttempt.id]
      );
      expect(persisted.rows[0]).toMatchObject({
        order_status: "COMPLETED",
        second_status: "CLOSED",
        second_state: "TERMINAL",
        second_result: "DUPLICATE_PAYMENT",
        kind: "DUPLICATE_PAYMENT",
        anomaly_status: "PENDING_REVIEW",
        anomalies: "1",
        transactions: "2",
        entitlements: "1"
      });
      const transactionFacts = await query<{
        payment_attempt_id: string;
        channel: string;
        channel_transaction_id: string;
        amount_fen: string;
        currency: string;
      }>(
        `SELECT
           payment_attempt_id,
           channel,
           channel_transaction_id,
           amount_fen::text AS amount_fen,
           currency
         FROM payment_transactions
         WHERE order_id = $1
           AND status = 'SUCCESS'
         ORDER BY channel, channel_transaction_id`,
        [order.id]
      );
      expect(transactionFacts.rows).toEqual([
        {
          payment_attempt_id: secondAttempt.id,
          channel: "alipay_wap",
          channel_transaction_id: duplicateVerified.channelTransactionId,
          amount_fen: order.amountFen,
          currency: "CNY"
        },
        {
          payment_attempt_id: firstAttempt.id,
          channel: "wechat_h5",
          channel_transaction_id: firstVerified.channelTransactionId,
          amount_fen: order.amountFen,
          currency: "CNY"
        }
      ]);
      expect(persisted.rows[0].serialized).not.toContain(rawSecret);
    } finally {
      if (userId) await cleanupEntitlementTestUsers([userId]);
    }
  });

  it("terminalizes every other unresolved or scheduled attempt after successful payment", async () => {
    await seedPolicyFoundation();
    let userId: string | undefined;
    try {
      userId = await createEntitlementTestUser(true);
      const order = await createOrder({
        userId,
        sku: "POLICY_CALC",
        channel: "main",
        idempotencyKey: `paid-attempt-cleanup-${randomUUID()}`,
        businessDraftId: await insertPolicyDraft(userId)
      });
      const ordinaryAlipay = await insertIdentityAwarePaymentAttempt({
        orderId: order.id,
        channel: "alipay_wap",
        status: "FAILED",
        origin: "legacy_order_no",
        requestSnapshot: { marker: "ordinary-alipay" }
      });
      const scheduledWechat = await insertIdentityAwarePaymentAttempt({
        orderId: order.id,
        channel: "wechat_h5",
        status: "CLOSED",
        providerOrderNo: `WXSCH${randomUUID().replaceAll("-", "").slice(0, 24)}`,
        requestSnapshot: { marker: "scheduled-wechat" },
        reconciliationState: "REQUIRED",
        reconciliationNextAt: new Date(),
        reconciliationDeadlineAt: new Date(Date.now() + 60 * 60_000),
        reconciliationLastResult: "LOCAL_CLOSE_PENDING_FINAL_QUERY"
      });
      const selected = await insertIdentityAwarePaymentAttempt({
        orderId: order.id,
        channel: "wechat_h5",
        status: "PENDING",
        requestSnapshot: { marker: "selected" }
      });
      await expect(
        markOrderPaid({
          orderId: order.id,
          paymentAttemptId: selected.id,
          verified: {
            providerOrderNo: selected.providerOrderNo,
            channel: "wechat_h5",
            channelTransactionId: `cleanup-paid-${randomUUID()}`,
            amountFen: order.amountFen,
            currency: "CNY",
            paidAt: new Date().toISOString(),
            raw: { source: "attempt-cleanup" }
          }
        })
      ).resolves.toMatchObject({ status: "COMPLETED" });
      const states = await query<{
        marker: string;
        status: string;
        reconciliation_state: string;
        reconciliation_last_result: string;
        reconciliation_next_at: Date | null;
        reconciliation_deadline_at: Date | null;
      }>(
        `SELECT
           request_snapshot->>'marker' AS marker,
           status,
           reconciliation_state,
           reconciliation_last_result,
           reconciliation_next_at,
           reconciliation_deadline_at
         FROM payment_attempts
         WHERE order_id = $1
           AND id <> $2
         ORDER BY marker`,
        [order.id, selected.id]
      );
      expect(states.rows).toEqual([
        {
          marker: "ordinary-alipay",
          status: "CLOSED",
          reconciliation_state: "TERMINAL",
          reconciliation_last_result:
            "ORDER_COMPLETED_BY_OTHER_ATTEMPT",
          reconciliation_next_at: null,
          reconciliation_deadline_at: null
        },
        {
          marker: "scheduled-wechat",
          status: "CLOSED",
          reconciliation_state: "TERMINAL",
          reconciliation_last_result:
            "ORDER_COMPLETED_BY_OTHER_ATTEMPT",
          reconciliation_next_at: null,
          reconciliation_deadline_at: null
        }
      ]);
      expect(ordinaryAlipay.id).toBeTruthy();
      expect(scheduledWechat.id).toBeTruthy();
    } finally {
      if (userId) await cleanupEntitlementTestUsers([userId]);
    }
  });

  it("recovers a paid order through the exported idempotent fulfillment entry", async () => {
    await seedPolicyFoundation();
    let userId: string | undefined;
    try {
      userId = await createEntitlementTestUser(true);
      const order = await createOrder({
        userId,
        sku: "POLICY_CALC",
        channel: "main",
        idempotencyKey: `fulfillment-recovery-${randomUUID()}`,
        businessDraftId: await insertPolicyDraft(userId)
      });
      const attempt = await insertIdentityAwarePaymentAttempt({
        orderId: order.id,
        channel: "wechat_h5",
        status: "SUCCEEDED"
      });
      await query(
        "UPDATE orders SET status = 'PAID', paid_at = now() WHERE id = $1",
        [order.id]
      );
      await expect(fulfillOrder(order.id)).rejects.toMatchObject({
        code: "ORDER_STATE_CONFLICT"
      });
      await query(
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
         VALUES ($1, $2, 'wechat_h5', $3, $4, 'CNY', 'SUCCESS', '{}', now())`,
        [
          order.id,
          attempt.id,
          `fulfill-${randomUUID()}`,
          order.amountFen
        ]
      );
      await query(
        `UPDATE order_items
         SET entitlement_policy = '{"grantCount":"invalid"}'::jsonb
         WHERE order_id = $1`,
        [order.id]
      );
      await expect(fulfillOrder(order.id)).rejects.toMatchObject({
        code: "INVALID_ENTITLEMENT_POLICY"
      });
      const afterFailure = await query<{
        status: string;
        entitlements: string;
      }>(
        `SELECT
           status,
           (SELECT count(*)::text FROM entitlements WHERE source_id = $1)
             AS entitlements
         FROM orders
         WHERE id = $1`,
        [order.id]
      );
      expect(afterFailure.rows[0]).toEqual({
        status: "PAID",
        entitlements: "0"
      });
      await query(
        `UPDATE order_items
         SET entitlement_policy = '{"grantCount":1}'::jsonb
         WHERE order_id = $1`,
        [order.id]
      );

      const first = await fulfillOrder(order.id);
      await expect(fulfillOrder(order.id)).resolves.toEqual(first);
      const persisted = await query<{
        status: string;
        entitlements: string;
      }>(
        `SELECT
           status,
           (SELECT count(*)::text FROM entitlements WHERE source_id = $1)
             AS entitlements
         FROM orders
         WHERE id = $1`,
        [order.id]
      );
      expect(persisted.rows[0]).toEqual({
        status: "COMPLETED",
        entitlements: "1"
      });
    } finally {
      if (userId) await cleanupEntitlementTestUsers([userId]);
    }
  });

  it("keeps provider I/O outside order row locks", async () => {
    await seedPolicyFoundation();
    let userId: string | undefined;
    let releaseProvider: (() => void) | undefined;
    try {
      userId = await createEntitlementTestUser(true);
      const businessDraftId = await insertPolicyDraft(userId);
      const order = await createOrder({
        userId,
        sku: "POLICY_CALC",
        channel: "main",
        idempotencyKey: `provider-lock-${randomUUID()}`,
        businessDraftId
      });
      let signalProviderEntered!: () => void;
      const providerEntered = new Promise<void>((resolve) => {
        signalProviderEntered = resolve;
      });
      const providerRelease = new Promise<void>((resolve) => {
        releaseProvider = resolve;
      });
      const payment = startPayment({
        userId,
        orderId: order.id,
        productChannel: order.channel,
        clientIp: "127.0.0.1",
        returnUrl: "http://peileme.test/return",
        notifyUrl: "http://peileme.test/notify",
        provider: {
          channel: "wechat_h5",
          async createPayment(input) {
            signalProviderEntered();
            await providerRelease;
            return {
              prepayId: `lock-${input.attemptId}`,
              launchUrl: `/lock/${input.orderNo}`,
              response: {}
            };
          },
          async queryPayment() {
            return null;
          },
          async refund() {
            return { channelRefundId: "unused", raw: {} };
          }
        }
      });
      await providerEntered;

      const probe = await getPool().connect();
      try {
        await probe.query("BEGIN");
        await expect(
          probe.query(
            "SELECT id FROM orders WHERE id = $1 FOR UPDATE NOWAIT",
            [order.id]
          )
        ).resolves.toMatchObject({ rowCount: 1 });
        await probe.query("ROLLBACK");
      } finally {
        probe.release();
      }

      releaseProvider();
      await expect(payment).resolves.toMatchObject({
        orderId: order.id,
        status: "PAYING"
      });
    } finally {
      releaseProvider?.();
      if (userId) await cleanupEntitlementTestUsers([userId]);
    }
  });

  it("keeps a provider-create failure locked and queries the same provider identity", async () => {
    await seedPolicyFoundation();
    let userId: string | undefined;
    try {
      userId = await createEntitlementTestUser(true);
      const order = await createOrder({
        userId,
        sku: "POLICY_CALC",
        channel: "main",
        idempotencyKey: `provider-retry-${randomUUID()}`,
        businessDraftId: await insertPolicyDraft(userId)
      });
      const seenAttempts: string[] = [];
      const createdProviderOrderNos: string[] = [];
      const queriedProviderOrderNos: string[] = [];
      let calls = 0;
      const provider = {
        channel: "wechat_h5" as const,
        async createPayment(input: {
          attemptId: string;
          orderNo: string;
          providerOrderNo: string;
        }) {
          seenAttempts.push(input.attemptId);
          createdProviderOrderNos.push(input.providerOrderNo);
          calls += 1;
          throw new Error("provider sentinel secret");
        },
        async queryPayment(providerOrderNo: string) {
          queriedProviderOrderNos.push(providerOrderNo);
          return null;
        },
        async refund() {
          return { channelRefundId: "unused", raw: {} };
        }
      };
      const start = () =>
        startPayment({
          userId: userId!,
          orderId: order.id,
          productChannel: order.channel,
          provider,
          clientIp: "127.0.0.1",
          returnUrl: "http://peileme.test/return",
          notifyUrl: "http://peileme.test/notify"
        });

      await expect(start()).rejects.toMatchObject({
        code: "PAYMENT_PROVIDER_FAILED",
        message: "PAYMENT_PROVIDER_FAILED"
      });
      await expect(start()).rejects.toMatchObject({
        code: "PAYMENT_INITIALIZING"
      });
      expect(seenAttempts).toHaveLength(1);
      expect(queriedProviderOrderNos).toEqual(createdProviderOrderNos);
      const attempts = await query<{
        count: string;
        provider_order_no: string;
        status: string;
      }>(
        `SELECT
           count(*)::text AS count,
           max(identity.provider_order_no) AS provider_order_no,
           max(status) AS status
         FROM payment_attempts attempt
         JOIN provider_payment_orders identity
           ON identity.id = attempt.provider_payment_order_id
         WHERE attempt.order_id = $1`,
        [order.id]
      );
      expect(attempts.rows[0]).toEqual({
        count: "1",
        provider_order_no: createdProviderOrderNos[0],
        status: "CREATE_UNKNOWN"
      });
    } finally {
      if (userId) await cleanupEntitlementTestUsers([userId]);
    }
  });

  it("recovers an expired PAYING order on the first user retry when the provider already captured payment", async () => {
    await seedPolicyFoundation();
    let userId: string | undefined;
    try {
      userId = await createEntitlementTestUser(true);
      const order = await createOrder({
        userId,
        sku: "POLICY_CALC",
        channel: "main",
        idempotencyKey: `expired-paying-recovery-${randomUUID()}`,
        businessDraftId: await insertPolicyDraft(userId)
      });
      const attempt = await insertIdentityAwarePaymentAttempt({
        orderId: order.id,
        channel: "wechat_h5",
        status: "PENDING"
      });
      await query(
        `UPDATE orders
         SET status = 'PAYING',
             created_at = now() - interval '3 minutes',
             expires_at = now() - interval '1 minute'
         WHERE id = $1`,
        [order.id]
      );
      let createCalls = 0;
      let queryCalls = 0;
      const provider = {
        channel: "wechat_h5" as const,
        async createPayment() {
          createCalls += 1;
          throw new Error("must not create");
        },
        async queryPayment(orderNo: string) {
          queryCalls += 1;
          return {
            providerOrderNo: orderNo,
            channel: "wechat_h5" as const,
            channelTransactionId: `expired-paying-${randomUUID()}`,
            amountFen: order.amountFen,
            currency: "CNY" as const,
            paidAt: new Date(Date.now() - 2 * 60_000).toISOString(),
            raw: { source: "provider-query" }
          };
        },
        async refund() {
          return { channelRefundId: "unused", raw: {} };
        }
      };

      await expect(
        startPayment({
          userId,
          orderId: order.id,
          productChannel: order.channel,
          provider,
          clientIp: "127.0.0.1",
          returnUrl: "http://peileme.test/return",
          notifyUrl: "http://peileme.test/notify",
          providerTimeoutMs: 100
        })
      ).resolves.toMatchObject({
        status: "COMPLETED",
        paymentAttemptId: attempt.id,
        launchUrl: "http://peileme.test/return"
      });
      expect({ createCalls, queryCalls }).toEqual({
        createCalls: 0,
        queryCalls: 1
      });
      const persisted = await query<{
        status: string;
        attempt_status: string;
        transactions: string;
        entitlements: string;
      }>(
        `SELECT
           o.status,
           pa.status AS attempt_status,
           (SELECT count(*)::text
              FROM payment_transactions
             WHERE order_id = o.id) AS transactions,
           (SELECT count(*)::text
              FROM entitlements
             WHERE source_id = o.id) AS entitlements
         FROM orders o
         JOIN payment_attempts pa ON pa.id = $2
         WHERE o.id = $1`,
        [order.id, attempt.id]
      );
      expect(persisted.rows[0]).toEqual({
        status: "COMPLETED",
        attempt_status: "SUCCEEDED",
        transactions: "1",
        entitlements: "1"
      });
    } finally {
      if (userId) await cleanupEntitlementTestUsers([userId]);
    }
  });

  it("isolates PAYING recovery by owner and channel and aborts a timed out provider query", async () => {
    await seedPolicyFoundation();
    const userIds: string[] = [];
    try {
      const ownerId = await createEntitlementTestUser(true);
      const otherUserId = await createEntitlementTestUser(true);
      userIds.push(ownerId, otherUserId);
      const order = await createOrder({
        userId: ownerId,
        sku: "POLICY_CALC",
        channel: "main",
        idempotencyKey: `paying-recovery-boundary-${randomUUID()}`,
        businessDraftId: await insertPolicyDraft(ownerId)
      });
      const attempt = await insertIdentityAwarePaymentAttempt({
        orderId: order.id,
        channel: "wechat_h5",
        status: "PENDING"
      });
      await query(
        `UPDATE orders
         SET status = 'PAYING',
             created_at = now() - interval '3 minutes',
             expires_at = now() - interval '1 minute'
         WHERE id = $1`,
        [order.id]
      );
      let queryCalls = 0;
      let createCalls = 0;
      let timedOutSignal: AbortSignal | undefined;
      const fakeProvider = {
        channel: "wechat_h5" as const,
        async createPayment() {
          createCalls += 1;
          throw new Error("must not create");
        },
        async queryPayment(_orderNo: string, signal: AbortSignal) {
          queryCalls += 1;
          timedOutSignal = signal;
          return await new Promise<never>((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => reject(new Error("provider query aborted")),
              { once: true }
            );
          });
        },
        async refund() {
          return { channelRefundId: "unused", raw: {} };
        }
      };
      const start = (userId: string) =>
        startPayment({
          userId,
          orderId: order.id,
          productChannel: order.channel,
          provider: fakeProvider,
          clientIp: "127.0.0.1",
          returnUrl: "http://peileme.test/return",
          notifyUrl: "http://peileme.test/notify",
          providerTimeoutMs: 20
        });

      await expect(
        startPayment({
          userId: ownerId,
          orderId: order.id,
          productChannel: "ai",
          provider: fakeProvider,
          clientIp: "127.0.0.1",
          returnUrl: "http://ai.peileme.test/return",
          notifyUrl: "http://peileme.test/notify",
          providerTimeoutMs: 20
        })
      ).rejects.toMatchObject({ code: "ORDER_NOT_FOUND" });
      expect({ createCalls, queryCalls }).toEqual({
        createCalls: 0,
        queryCalls: 0
      });
      await expect(start(otherUserId)).rejects.toMatchObject({
        code: "ORDER_NOT_FOUND"
      });
      expect(queryCalls).toBe(0);
      await expect(start(ownerId)).rejects.toMatchObject({
        code: "PAYMENT_PROVIDER_FAILED"
      });
      expect(timedOutSignal?.aborted).toBe(true);
      expect({ createCalls, queryCalls }).toEqual({
        createCalls: 0,
        queryCalls: 1
      });
      const afterTimeout = await query<{
        order_status: string;
        attempt_status: string;
      }>(
        `SELECT o.status AS order_status, pa.status AS attempt_status
         FROM orders o
         JOIN payment_attempts pa ON pa.id = $2
         WHERE o.id = $1`,
        [order.id, attempt.id]
      );
      expect(afterTimeout.rows[0]).toEqual({
        order_status: "PAYING",
        attempt_status: "PENDING"
      });

      let wrongChannelQueries = 0;
      const alipayProvider = {
        channel: "alipay_wap" as const,
        async createPayment() {
          throw new Error("must not create");
        },
        async queryPayment() {
          wrongChannelQueries += 1;
          return null;
        },
        async refund() {
          return { channelRefundId: "unused", raw: {} };
        }
      };
      await expect(
        startPayment({
          userId: ownerId,
          orderId: order.id,
          productChannel: order.channel,
          provider: alipayProvider,
          clientIp: "127.0.0.1",
          returnUrl: "http://peileme.test/return",
          notifyUrl: "http://peileme.test/notify",
          providerTimeoutMs: 100
        })
      ).rejects.toMatchObject({ code: "PAYMENT_CHANNEL_LOCKED" });
      expect(wrongChannelQueries).toBe(0);
      const locked = await query<{
        order_status: string;
        attempt_status: string;
        reconciliation_state: string;
      }>(
        `SELECT
           o.status AS order_status,
           pa.status AS attempt_status,
           pa.reconciliation_state
         FROM orders o
         JOIN payment_attempts pa ON pa.id = $2
         WHERE o.id = $1`,
        [order.id, attempt.id]
      );
      expect(locked.rows[0]).toEqual({
        order_status: "PAYING",
        attempt_status: "PENDING",
        reconciliation_state: "NONE"
      });
    } finally {
      await cleanupEntitlementTestUsers(userIds);
    }
  });

  it("keeps an expired uncertain payment locked after an inconclusive query", async () => {
    await seedPolicyFoundation();
    let userId: string | undefined;
    try {
      userId = await createEntitlementTestUser(true);
      const order = await createOrder({
        userId,
        sku: "POLICY_CALC",
        channel: "main",
        idempotencyKey: `expired-start-${randomUUID()}`,
        businessDraftId: await insertPolicyDraft(userId)
      });
      const attempt = await insertIdentityAwarePaymentAttempt({
        orderId: order.id,
        channel: "wechat_h5",
        status: "PENDING"
      });
      await query(
        `UPDATE orders
         SET status = 'PAYING',
             created_at = now() - interval '2 minutes',
             expires_at = now() - interval '1 minute'
         WHERE id = $1`,
        [order.id]
      );
      let createCalls = 0;
      const provider = {
        channel: "wechat_h5" as const,
        async createPayment() {
          createCalls += 1;
          throw new Error("must not create");
        },
        async queryPayment() {
          return null;
        },
        async refund() {
          return { channelRefundId: "unused", raw: {} };
        }
      };
      const start = () =>
        startPayment({
          userId: userId!,
          orderId: order.id,
          productChannel: order.channel,
          provider,
          clientIp: "127.0.0.1",
          returnUrl: "http://peileme.test/return",
          notifyUrl: "http://peileme.test/notify",
          providerTimeoutMs: 100
        });

      await expect(start()).rejects.toMatchObject({
        code: "PAYMENT_CHANNEL_LOCKED"
      });
      const first = await query<{
        status: string;
        closed_at: Date | null;
        attempt_status: string;
        reconciliation_state: string;
        reconciliation_attempt_count: number;
        reconciliation_next_at: Date | null;
        reconciliation_deadline_at: Date | null;
      }>(
        `SELECT
           o.status,
           o.closed_at,
           pa.status AS attempt_status,
           pa.reconciliation_state,
           pa.reconciliation_attempt_count,
           pa.reconciliation_next_at,
           pa.reconciliation_deadline_at
         FROM orders o
         JOIN payment_attempts pa ON pa.order_id = o.id
         WHERE o.id = $1`,
        [order.id]
      );
      expect(first.rows[0]).toMatchObject({
        status: "PAYING",
        closed_at: null,
        attempt_status: "PENDING",
        reconciliation_state: "NONE",
        reconciliation_attempt_count: 0,
        reconciliation_next_at: null,
        reconciliation_deadline_at: null
      });
      await expect(start()).rejects.toMatchObject({
        code: "PAYMENT_CHANNEL_LOCKED"
      });
      expect(createCalls).toBe(0);
    } finally {
      if (userId) await cleanupEntitlementTestUsers([userId]);
    }
  });

  it("keeps an expired uncertain attempt locked until the background query confirms payment", async () => {
    await seedPolicyFoundation();
    let userId: string | undefined;
    try {
      userId = await createEntitlementTestUser(true);
      const order = await createOrder({
        userId,
        sku: "POLICY_CALC",
        channel: "main",
        idempotencyKey: `closed-late-recovery-${randomUUID()}`,
        businessDraftId: await insertPolicyDraft(userId)
      });
      const attempt = await insertIdentityAwarePaymentAttempt({
        orderId: order.id,
        channel: "wechat_h5",
        status: "PENDING"
      });
      await query(
        `UPDATE orders
         SET status = 'PAYING',
             created_at = now() - interval '3 minutes',
             expires_at = now() - interval '1 minute'
         WHERE id = $1`,
        [order.id]
      );
      let queryCalls = 0;
      const provider = {
        channel: "wechat_h5" as const,
        async createPayment() {
          throw new Error("must not create");
        },
        async queryPayment(orderNo: string) {
          queryCalls += 1;
          if (queryCalls === 1) return null;
          return {
            providerOrderNo: orderNo,
            channel: "wechat_h5" as const,
            channelTransactionId: `closed-late-${randomUUID()}`,
            amountFen: order.amountFen,
            currency: "CNY" as const,
            paidAt: new Date(Date.now() - 2 * 60_000).toISOString(),
            raw: { source: "closed-final-query" }
          };
        },
        async refund() {
          return { channelRefundId: "unused", raw: {} };
        }
      };

      await expect(
        startPayment({
          userId,
          orderId: order.id,
          productChannel: order.channel,
          provider,
          clientIp: "127.0.0.1",
          returnUrl: "http://peileme.test/return",
          notifyUrl: "http://peileme.test/notify",
          providerTimeoutMs: 100
        })
      ).rejects.toMatchObject({ code: "PAYMENT_CHANNEL_LOCKED" });
      const stillLocked = await query<{
        order_status: string;
        attempt_status: string;
        reconciliation_state: string;
        reconciliation_attempt_count: number;
        reconciliation_next_at: Date | null;
        reconciliation_deadline_at: Date | null;
        reconciliation_last_result: string | null;
      }>(
        `SELECT
           o.status AS order_status,
           pa.status AS attempt_status,
           pa.reconciliation_state,
           pa.reconciliation_attempt_count,
           pa.reconciliation_next_at,
           pa.reconciliation_deadline_at,
           pa.reconciliation_last_result
         FROM orders o
         JOIN payment_attempts pa ON pa.id = $2
         WHERE o.id = $1`,
        [order.id, attempt.id]
      );
      expect(stillLocked.rows[0]).toMatchObject({
        order_status: "PAYING",
        attempt_status: "PENDING",
        reconciliation_state: "NONE",
        reconciliation_attempt_count: 0,
        reconciliation_next_at: null,
        reconciliation_deadline_at: null,
        reconciliation_last_result: null
      });

      const reconciliation = await reconcileAndCloseExpiredOrders({
        provider,
        limit: 5,
        providerQueryBudget: 5,
        providerTimeoutMs: 100
      });
      expect(queryCalls).toBe(2);
      expect(reconciliation.closedOrderIds).toEqual([]);
      expect(reconciliation.summary).toEqual({
        scannedCount: 1,
        closedCount: 0,
        providerConfirmedPaidCount: 1,
        deferredCount: 0,
        terminalCount: 0,
        hasMore: false,
        scheduledRecoveryCount: 0,
        deferredByReason: {
          providerQueryError: 0,
          paymentVerificationFailed: 0,
          closeCapacityExceeded: 0,
          unsafeOrChangedState: 0
        },
        closedRecovery: {
          scannedCount: 0,
          recoveredCount: 0,
          retryScheduledCount: 0,
          terminalCount: 0,
          changedStateCount: 0,
          retryByReason: {
            noPayment: 0,
            queryError: 0
          },
          terminalByReason: {
            deadlineExceeded: 0,
            noPaymentLimitExceeded: 0,
            paymentAfterExpiry: 0,
            paymentVerificationFailed: 0
          }
        }
      });
      const persisted = await query<{
        order_status: string;
        attempt_status: string;
        reconciliation_state: string;
        reconciliation_attempt_count: number;
        reconciliation_next_at: Date | null;
        transactions: string;
        entitlements: string;
      }>(
        `SELECT
           o.status AS order_status,
           pa.status AS attempt_status,
           pa.reconciliation_state,
           pa.reconciliation_attempt_count,
           pa.reconciliation_next_at,
           (SELECT count(*)::text
              FROM payment_transactions
             WHERE order_id = o.id) AS transactions,
           (SELECT count(*)::text
              FROM entitlements
             WHERE source_id = o.id) AS entitlements
         FROM orders o
         JOIN payment_attempts pa ON pa.id = $2
         WHERE o.id = $1`,
        [order.id, attempt.id]
      );
      expect(persisted.rows[0]).toEqual({
        order_status: "COMPLETED",
        attempt_status: "SUCCEEDED",
        reconciliation_state: "RECOVERED",
        reconciliation_attempt_count: 0,
        reconciliation_next_at: null,
        transactions: "1",
        entitlements: "1"
      });
    } finally {
      if (userId) await cleanupEntitlementTestUsers([userId]);
    }
  });

  it("rolls back CLOSED paid recovery with its audit while preserving only the claim lease", async () => {
    await seedPolicyFoundation();
    let userId: string | undefined;
    try {
      userId = await createEntitlementTestUser(true);
      const closed = await createScheduledClosedPaymentOrder(
        userId,
        "closed-paid-audit-rollback"
      );
      const verified = {
        providerOrderNo: closed.providerOrderNo,
        channel: "wechat_h5" as const,
        channelTransactionId: `closed-paid-audit-${randomUUID()}`,
        amountFen: closed.order.amountFen,
        currency: "CNY" as const,
        paidAt: new Date(Date.now() - 2 * 60_000).toISOString(),
        raw: { source: "closed-paid-audit-rollback" }
      };
      let releaseProvider!: () => void;
      const providerReleased = new Promise<void>((resolve) => {
        releaseProvider = resolve;
      });
      let reportProviderQuery!: () => void;
      const providerQueried = new Promise<void>((resolve) => {
        reportProviderQuery = resolve;
      });
      let queryCalls = 0;
      const provider = {
        channel: "wechat_h5" as const,
        async createPayment() {
          throw new Error("must not create");
        },
        async queryPayment() {
          queryCalls += 1;
          await query(
            "SELECT id FROM orders WHERE id = $1 FOR UPDATE NOWAIT",
            [closed.order.id]
          );
          await query(
            "SELECT id FROM payment_attempts WHERE id = $1 FOR UPDATE NOWAIT",
            [closed.attemptId]
          );
          reportProviderQuery();
          await providerReleased;
          return verified;
        },
        async refund() {
          return { channelRefundId: "unused", raw: {} };
        }
      };
      const forcedAuditFailure = new Error(
        "forced paid reconciliation audit failure"
      );
      const failingWorker = reconcileAndCloseExpiredOrders({
        provider,
        limit: 5,
        providerQueryBudget: 1,
        providerTimeoutMs: 1_000,
        onClosed: async () => {
          throw forcedAuditFailure;
        }
      });
      await providerQueried;
      const concurrentWorker = await reconcileAndCloseExpiredOrders({
        provider,
        limit: 5,
        providerQueryBudget: 1,
        providerTimeoutMs: 1_000
      });
      expect(concurrentWorker.summary.scannedCount).toBe(0);
      expect(queryCalls).toBe(1);
      releaseProvider();
      await expect(failingWorker).rejects.toThrow(
        "forced paid reconciliation audit failure"
      );

      const rolledBack = await query<{
        order_status: string;
        attempt_status: string;
        reconciliation_state: string;
        reconciliation_attempt_count: number;
        reconciliation_no_payment_count: number;
        reconciliation_query_error_count: number;
        reconciliation_next_at: Date | null;
        reconciliation_deadline_at: Date | null;
        reconciliation_last_result: string | null;
        error_code: string | null;
        transactions: string;
        entitlements: string;
        anomalies: string;
      }>(
        `SELECT
           o.status AS order_status,
           pa.status AS attempt_status,
           pa.reconciliation_state,
           pa.reconciliation_attempt_count,
           pa.reconciliation_no_payment_count,
           pa.reconciliation_query_error_count,
           pa.reconciliation_next_at,
           pa.reconciliation_deadline_at,
           pa.reconciliation_last_result,
           pa.error_code,
           (SELECT count(*)::text
              FROM payment_transactions
             WHERE order_id = o.id) AS transactions,
           (SELECT count(*)::text
              FROM entitlements
             WHERE source_id = o.id) AS entitlements,
           (SELECT count(*)::text
              FROM payment_anomalies
             WHERE order_id = o.id) AS anomalies
         FROM orders o
         JOIN payment_attempts pa ON pa.id = $2
         WHERE o.id = $1`,
        [closed.order.id, closed.attemptId]
      );
      expect(rolledBack.rows[0]).toMatchObject({
        order_status: "CLOSED",
        attempt_status: "CLOSED",
        reconciliation_state: "RETRY_SCHEDULED",
        reconciliation_attempt_count: 1,
        reconciliation_no_payment_count: 0,
        reconciliation_query_error_count: 0,
        reconciliation_next_at: expect.any(Date),
        reconciliation_deadline_at: expect.any(Date),
        reconciliation_last_result: "QUERY_IN_PROGRESS",
        error_code: null,
        transactions: "0",
        entitlements: "0",
        anomalies: "0"
      });

      await paymentWriteQuery(
        `UPDATE payment_attempts
         SET reconciliation_next_at = now() - interval '1 second'
         WHERE id = $1`,
        [closed.attemptId]
      );
      const auditAction = `commerce.reconcile.success.${randomUUID()}`;
      const succeeded = await reconcileAndCloseExpiredOrders({
        provider: {
          ...provider,
          async queryPayment() {
            queryCalls += 1;
            return verified;
          }
        },
        limit: 5,
        providerQueryBudget: 1,
        providerTimeoutMs: 1_000,
        onClosed: async (client, _closedOrderIds, summary) => {
          await client.query(
            `INSERT INTO admin_audit_logs(
               admin_user_id,
               action,
               target_type,
               target_id,
               detail
             )
             VALUES ($1, $2, 'order', $3, $4::jsonb)`,
            [
              userId,
              auditAction,
              closed.order.id,
              JSON.stringify(summary)
            ]
          );
        }
      });
      expect(succeeded.summary).toMatchObject({
        providerConfirmedPaidCount: 1,
        closedRecovery: {
          recoveredCount: 1
        }
      });
      const committed = await query<{
        order_status: string;
        attempt_status: string;
        reconciliation_state: string;
        transactions: string;
        entitlements: string;
        audits: string;
      }>(
        `SELECT
           o.status AS order_status,
           pa.status AS attempt_status,
           pa.reconciliation_state,
           (SELECT count(*)::text
              FROM payment_transactions
             WHERE order_id = o.id) AS transactions,
           (SELECT count(*)::text
              FROM entitlements
             WHERE source_id = o.id) AS entitlements,
           (SELECT count(*)::text
              FROM admin_audit_logs
             WHERE admin_user_id = $3
               AND action = $4) AS audits
         FROM orders o
         JOIN payment_attempts pa ON pa.id = $2
         WHERE o.id = $1`,
        [closed.order.id, closed.attemptId, userId, auditAction]
      );
      expect(committed.rows[0]).toEqual({
        order_status: "COMPLETED",
        attempt_status: "SUCCEEDED",
        reconciliation_state: "RECOVERED",
        transactions: "1",
        entitlements: "1",
        audits: "1"
      });
    } finally {
      if (userId) await cleanupEntitlementTestUsers([userId]);
    }
  });

  it("rolls back a failed paid apply to its claim before committing the summary audit", async () => {
    await seedPolicyFoundation();
    let userId: string | undefined;
    try {
      userId = await createEntitlementTestUser(true);
      const closed = await createScheduledClosedPaymentOrder(
        userId,
        "closed-invalid-entitlement-apply"
      );
      await query(
        `UPDATE order_items
         SET entitlement_policy =
           '{"grantCount":"invalid"}'::jsonb
         WHERE order_id = $1`,
        [closed.order.id]
      );
      const verified = {
        providerOrderNo: closed.providerOrderNo,
        channel: "wechat_h5" as const,
        channelTransactionId:
          `closed-invalid-entitlement-${randomUUID()}`,
        amountFen: closed.order.amountFen,
        currency: "CNY" as const,
        paidAt: new Date(Date.now() - 2 * 60_000).toISOString(),
        raw: { source: "closed-invalid-entitlement-apply" }
      };
      const auditAction =
        `commerce.reconcile.invalid-entitlement.${randomUUID()}`;
      const result = await reconcileAndCloseExpiredOrders({
        provider: {
          channel: "wechat_h5",
          async createPayment() {
            throw new Error("must not create");
          },
          async queryPayment() {
            return verified;
          },
          async refund() {
            return { channelRefundId: "unused", raw: {} };
          }
        },
        limit: 5,
        providerQueryBudget: 1,
        providerTimeoutMs: 100,
        onClosed: async (client, _closedOrderIds, summary) => {
          await client.query(
            `INSERT INTO admin_audit_logs(
               admin_user_id,
               action,
               target_type,
               target_id,
               detail
             )
             VALUES ($1, $2, 'order', $3, $4::jsonb)`,
            [
              userId,
              auditAction,
              closed.order.id,
              JSON.stringify(summary)
            ]
          );
        }
      });
      expect(result.summary).toMatchObject({
        scannedCount: 1,
        closedCount: 0,
        providerConfirmedPaidCount: 0,
        deferredCount: 1,
        terminalCount: 0,
        hasMore: false,
        scheduledRecoveryCount: 1,
        deferredByReason: {
          unsafeOrChangedState: 1
        },
        closedRecovery: {
          scannedCount: 1,
          recoveredCount: 0,
          retryScheduledCount: 0,
          terminalCount: 0
        }
      });
      expect(result.summary.scannedCount).toBe(
        result.summary.closedCount +
          result.summary.providerConfirmedPaidCount +
          result.summary.deferredCount +
          result.summary.terminalCount
      );
      const persisted = await query<{
        order_status: string;
        attempt_status: string;
        reconciliation_state: string;
        reconciliation_attempt_count: number;
        reconciliation_last_result: string | null;
        transactions: string;
        entitlements: string;
        audits: string;
      }>(
        `SELECT
           o.status AS order_status,
           pa.status AS attempt_status,
           pa.reconciliation_state,
           pa.reconciliation_attempt_count,
           pa.reconciliation_last_result,
           (SELECT count(*)::text
              FROM payment_transactions
             WHERE order_id = o.id) AS transactions,
           (SELECT count(*)::text
              FROM entitlements
             WHERE source_id = o.id) AS entitlements,
           (SELECT count(*)::text
              FROM admin_audit_logs
             WHERE admin_user_id = $3
               AND action = $4) AS audits
         FROM orders o
         JOIN payment_attempts pa ON pa.id = $2
         WHERE o.id = $1`,
        [closed.order.id, closed.attemptId, userId, auditAction]
      );
      expect(persisted.rows[0]).toEqual({
        order_status: "CLOSED",
        attempt_status: "CLOSED",
        reconciliation_state: "RETRY_SCHEDULED",
        reconciliation_attempt_count: 1,
        reconciliation_last_result: "QUERY_IN_PROGRESS",
        transactions: "0",
        entitlements: "0",
        audits: "1"
      });
    } finally {
      if (userId) {
        await query(
          `UPDATE order_items
           SET entitlement_policy = '{"grantCount":1}'::jsonb
           WHERE order_id IN (
             SELECT id
             FROM orders
             WHERE user_id = $1
           )`,
          [userId]
        );
        await cleanupEntitlementTestUsers([userId]);
      }
    }
  });

  it("rolls back a terminal CLOSED no-payment result when its audit fails", async () => {
    await seedPolicyFoundation();
    let userId: string | undefined;
    try {
      userId = await createEntitlementTestUser(true);
      const closed = await createScheduledClosedPaymentOrder(
        userId,
        "closed-null-audit-rollback"
      );
      await paymentWriteQuery(
        `UPDATE payment_attempts
         SET reconciliation_no_payment_count = 4
         WHERE id = $1`,
        [closed.attemptId]
      );
      let queryCalls = 0;
      const provider = {
        channel: "wechat_h5" as const,
        async createPayment() {
          throw new Error("must not create");
        },
        async queryPayment() {
          queryCalls += 1;
          return null;
        },
        async refund() {
          return { channelRefundId: "unused", raw: {} };
        }
      };
      await expect(
        reconcileAndCloseExpiredOrders({
          provider,
          limit: 5,
          providerQueryBudget: 1,
          providerTimeoutMs: 100,
          onClosed: async () => {
            throw new Error("forced null reconciliation audit failure");
          }
        })
      ).rejects.toThrow("forced null reconciliation audit failure");
      expect(queryCalls).toBe(1);
      const rolledBack = await query<{
        reconciliation_state: string;
        reconciliation_attempt_count: number;
        reconciliation_no_payment_count: number;
        reconciliation_query_error_count: number;
        reconciliation_next_at: Date | null;
        reconciliation_deadline_at: Date | null;
        reconciliation_last_result: string | null;
        error_code: string | null;
      }>(
        `SELECT
           reconciliation_state,
           reconciliation_attempt_count,
           reconciliation_no_payment_count,
           reconciliation_query_error_count,
           reconciliation_next_at,
           reconciliation_deadline_at,
           reconciliation_last_result,
           error_code
         FROM payment_attempts
         WHERE id = $1`,
        [closed.attemptId]
      );
      expect(rolledBack.rows[0]).toMatchObject({
        reconciliation_state: "RETRY_SCHEDULED",
        reconciliation_attempt_count: 1,
        reconciliation_no_payment_count: 4,
        reconciliation_query_error_count: 0,
        reconciliation_next_at: expect.any(Date),
        reconciliation_deadline_at: expect.any(Date),
        reconciliation_last_result: "QUERY_IN_PROGRESS",
        error_code: null
      });
    } finally {
      if (userId) await cleanupEntitlementTestUsers([userId]);
    }
  });

  it("rolls back CLOSED and open provider-query errors when their audit fails", async () => {
    await seedPolicyFoundation();
    let userId: string | undefined;
    try {
      userId = await createEntitlementTestUser(true);
      const closed = await createScheduledClosedPaymentOrder(
        userId,
        "closed-error-audit-rollback"
      );
      const open = await createFailedPaymentOrder(
        userId,
        "open-error-audit-rollback"
      );
      await query(
        `UPDATE orders
         SET status = 'PAYING',
             created_at = now() - interval '2 minutes',
             expires_at = now() - interval '1 second',
             updated_at = now() - interval '1 minute'
         WHERE id = $1`,
        [open.order.id]
      );
      await paymentWriteQuery(
        `UPDATE payment_attempts
         SET status = 'PENDING',
             reconciliation_state = 'NONE',
             error_code = NULL,
             error_message = NULL,
             updated_at = now() - interval '1 minute'
         WHERE id = $1`,
        [open.attemptId]
      );
      let queryCalls = 0;
      const provider = {
        channel: "wechat_h5" as const,
        async createPayment() {
          throw new Error("must not create");
        },
        async queryPayment() {
          queryCalls += 1;
          throw new Error("forced provider query failure");
        },
        async refund() {
          return { channelRefundId: "unused", raw: {} };
        }
      };
      await expect(
        reconcileAndCloseExpiredOrders({
          provider,
          limit: 5,
          providerQueryBudget: 2,
          providerTimeoutMs: 100,
          onClosed: async () => {
            throw new Error("forced error reconciliation audit failure");
          }
        })
      ).rejects.toThrow("forced error reconciliation audit failure");
      expect(queryCalls).toBe(2);
      const rolledBack = await query<{
        id: string;
        status: string;
        reconciliation_state: string;
        reconciliation_attempt_count: number;
        reconciliation_query_error_count: number;
        reconciliation_last_result: string | null;
        error_code: string | null;
        error_message: string | null;
      }>(
        `SELECT
           id,
           status,
           reconciliation_state,
           reconciliation_attempt_count,
           reconciliation_query_error_count,
           reconciliation_last_result,
           error_code,
           error_message
         FROM payment_attempts
         WHERE id = ANY($1::uuid[])
         ORDER BY id`,
        [[closed.attemptId, open.attemptId]]
      );
      const byId = new Map(
        rolledBack.rows.map((attempt) => [attempt.id, attempt])
      );
      expect(byId.get(closed.attemptId)).toMatchObject({
        status: "CLOSED",
        reconciliation_state: "RETRY_SCHEDULED",
        reconciliation_attempt_count: 1,
        reconciliation_query_error_count: 0,
        reconciliation_last_result: "QUERY_IN_PROGRESS",
        error_code: null,
        error_message: null
      });
      expect(byId.get(open.attemptId)).toMatchObject({
        status: "PENDING",
        reconciliation_state: "NONE",
        reconciliation_attempt_count: 0,
        reconciliation_query_error_count: 0,
        reconciliation_last_result: null,
        error_code: null,
        error_message: null
      });
      const openOrder = await query<{ status: string }>(
        "SELECT status FROM orders WHERE id = $1",
        [open.order.id]
      );
      expect(openOrder.rows[0].status).toBe("PAYING");
    } finally {
      if (userId) await cleanupEntitlementTestUsers([userId]);
    }
  });

  it("accounts for an open query-error race as changed state after its callback wins", async () => {
    await seedPolicyFoundation();
    let userId: string | undefined;
    try {
      userId = await createEntitlementTestUser(true);
      const open = await createFailedPaymentOrder(
        userId,
        "open-query-error-callback-race"
      );
      await query(
        `UPDATE orders
         SET status = 'PAYING',
             created_at = now() - interval '3 minutes',
             expires_at = now() - interval '1 minute',
             updated_at = now() - interval '1 minute'
         WHERE id = $1`,
        [open.order.id]
      );
      await paymentWriteQuery(
        `UPDATE payment_attempts
         SET status = 'PENDING',
             reconciliation_state = 'NONE',
             error_code = NULL,
             error_message = NULL,
             updated_at = now() - interval '1 minute'
         WHERE id = $1`,
        [open.attemptId]
      );
      const verified = {
        providerOrderNo: open.providerOrderNo,
        channel: "wechat_h5" as const,
        channelTransactionId:
          `open-query-error-callback-${randomUUID()}`,
        amountFen: open.order.amountFen,
        currency: "CNY" as const,
        paidAt: new Date(Date.now() - 2 * 60_000).toISOString(),
        raw: { source: "open-query-error-callback-race" }
      };
      let releaseProvider!: () => void;
      const providerReleased = new Promise<void>((resolve) => {
        releaseProvider = resolve;
      });
      let reportProviderQuery!: () => void;
      const providerQueried = new Promise<void>((resolve) => {
        reportProviderQuery = resolve;
      });
      const provider = {
        channel: "wechat_h5" as const,
        async createPayment() {
          throw new Error("must not create");
        },
        async queryPayment() {
          reportProviderQuery();
          await providerReleased;
          throw new Error("stale open provider query failed");
        },
        async refund() {
          return { channelRefundId: "unused", raw: {} };
        }
      };
      const worker = reconcileAndCloseExpiredOrders({
        provider,
        limit: 5,
        providerQueryBudget: 1,
        providerTimeoutMs: 1_000
      });
      await providerQueried;
      await markOrderPaid({
        orderId: open.order.id,
        paymentAttemptId: open.attemptId,
        verified
      });
      releaseProvider();
      const result = await worker;
      expect(result.summary).toMatchObject({
        scannedCount: 1,
        providerConfirmedPaidCount: 0,
        deferredCount: 1,
        terminalCount: 0,
        hasMore: false,
        deferredByReason: {
          providerQueryError: 0,
          unsafeOrChangedState: 1
        }
      });
      expect(result.summary.scannedCount).toBe(
        result.summary.closedCount +
          result.summary.providerConfirmedPaidCount +
          result.summary.deferredCount +
          result.summary.terminalCount
      );
      const persisted = await query<{
        order_status: string;
        attempt_status: string;
        error_code: string | null;
        transactions: string;
        entitlements: string;
      }>(
        `SELECT
           o.status AS order_status,
           pa.status AS attempt_status,
           pa.error_code,
           (SELECT count(*)::text
              FROM payment_transactions
             WHERE order_id = o.id) AS transactions,
           (SELECT count(*)::text
              FROM entitlements
             WHERE source_id = o.id) AS entitlements
         FROM orders o
         JOIN payment_attempts pa ON pa.id = $2
         WHERE o.id = $1`,
        [open.order.id, open.attemptId]
      );
      expect(persisted.rows[0]).toEqual({
        order_status: "COMPLETED",
        attempt_status: "SUCCEEDED",
        error_code: null,
        transactions: "1",
        entitlements: "1"
      });
    } finally {
      if (userId) await cleanupEntitlementTestUsers([userId]);
    }
  });

  it("rolls back an open late-payment anomaly when its audit fails", async () => {
    await seedPolicyFoundation();
    let userId: string | undefined;
    try {
      userId = await createEntitlementTestUser(true);
      const open = await createFailedPaymentOrder(
        userId,
        "open-anomaly-audit-rollback"
      );
      await query(
        `UPDATE orders
         SET status = 'PAYING',
             created_at = now() - interval '3 minutes',
             expires_at = now() - interval '1 minute',
             updated_at = now() - interval '1 minute'
         WHERE id = $1`,
        [open.order.id]
      );
      await paymentWriteQuery(
        `UPDATE payment_attempts
         SET status = 'PENDING',
             reconciliation_state = 'NONE',
             updated_at = now() - interval '1 minute'
         WHERE id = $1`,
        [open.attemptId]
      );
      const provider = {
        channel: "wechat_h5" as const,
        async createPayment() {
          throw new Error("must not create");
        },
        async queryPayment(orderNo: string) {
          return {
            providerOrderNo: orderNo,
            channel: "wechat_h5" as const,
            channelTransactionId: `open-late-audit-${randomUUID()}`,
            amountFen: open.order.amountFen,
            currency: "CNY" as const,
            paidAt: new Date().toISOString(),
            raw: { source: "open-anomaly-audit-rollback" }
          };
        },
        async refund() {
          return { channelRefundId: "unused", raw: {} };
        }
      };
      await expect(
        reconcileAndCloseExpiredOrders({
          provider,
          limit: 5,
          providerQueryBudget: 1,
          providerTimeoutMs: 100,
          onClosed: async () => {
            throw new Error("forced anomaly reconciliation audit failure");
          }
        })
      ).rejects.toThrow("forced anomaly reconciliation audit failure");
      const rolledBack = await query<{
        order_status: string;
        attempt_status: string;
        reconciliation_state: string;
        reconciliation_last_result: string | null;
        error_code: string | null;
        anomalies: string;
        transactions: string;
        entitlements: string;
      }>(
        `SELECT
           o.status AS order_status,
           pa.status AS attempt_status,
           pa.reconciliation_state,
           pa.reconciliation_last_result,
           pa.error_code,
           (SELECT count(*)::text
              FROM payment_anomalies
             WHERE order_id = o.id) AS anomalies,
           (SELECT count(*)::text
              FROM payment_transactions
             WHERE order_id = o.id) AS transactions,
           (SELECT count(*)::text
              FROM entitlements
             WHERE source_id = o.id) AS entitlements
         FROM orders o
         JOIN payment_attempts pa ON pa.id = $2
         WHERE o.id = $1`,
        [open.order.id, open.attemptId]
      );
      expect(rolledBack.rows[0]).toEqual({
        order_status: "PAYING",
        attempt_status: "PENDING",
        reconciliation_state: "NONE",
        reconciliation_last_result: null,
        error_code: null,
        anomalies: "0",
        transactions: "0",
        entitlements: "0"
      });
    } finally {
      if (userId) await cleanupEntitlementTestUsers([userId]);
    }
  });

  it("ignores a stale paid result after a newer CLOSED claim generation", async () => {
    await seedPolicyFoundation();
    let userId: string | undefined;
    try {
      userId = await createEntitlementTestUser(true);
      const closed = await createScheduledClosedPaymentOrder(
        userId,
        "closed-stale-paid-generation"
      );
      const staleVerified = {
        providerOrderNo: closed.providerOrderNo,
        channel: "wechat_h5" as const,
        channelTransactionId: `closed-stale-paid-${randomUUID()}`,
        amountFen: closed.order.amountFen,
        currency: "CNY" as const,
        paidAt: new Date(Date.now() - 2 * 60_000).toISOString(),
        raw: { source: "closed-stale-paid-generation" }
      };
      let releaseFirstQuery!: () => void;
      const firstQueryReleased = new Promise<void>((resolve) => {
        releaseFirstQuery = resolve;
      });
      let reportFirstQuery!: () => void;
      const firstQueryStarted = new Promise<void>((resolve) => {
        reportFirstQuery = resolve;
      });
      let queryCalls = 0;
      const provider = {
        channel: "wechat_h5" as const,
        async createPayment() {
          throw new Error("must not create");
        },
        async queryPayment() {
          queryCalls += 1;
          if (queryCalls === 1) {
            await query(
              "SELECT id FROM orders WHERE id = $1 FOR UPDATE NOWAIT",
              [closed.order.id]
            );
            await query(
              "SELECT id FROM payment_attempts WHERE id = $1 FOR UPDATE NOWAIT",
              [closed.attemptId]
            );
            reportFirstQuery();
            await firstQueryReleased;
            return staleVerified;
          }
          return null;
        },
        async refund() {
          return { channelRefundId: "unused", raw: {} };
        }
      };

      const staleWorker = reconcileAndCloseExpiredOrders({
        provider,
        limit: 5,
        providerQueryBudget: 1,
        providerTimeoutMs: 1_000
      });
      await firstQueryStarted;
      await paymentWriteQuery(
        `UPDATE payment_attempts
         SET reconciliation_next_at = now() - interval '1 second'
         WHERE id = $1`,
        [closed.attemptId]
      );
      const newerWorker = await reconcileAndCloseExpiredOrders({
        provider,
        limit: 5,
        providerQueryBudget: 1,
        providerTimeoutMs: 1_000
      });
      expect(newerWorker.summary).toMatchObject({
        deferredCount: 1,
        closedRecovery: {
          retryScheduledCount: 1,
          retryByReason: {
            noPayment: 1
          }
        }
      });
      releaseFirstQuery();
      await staleWorker;
      expect(queryCalls).toBe(2);

      const persisted = await query<{
        order_status: string;
        attempt_status: string;
        reconciliation_state: string;
        reconciliation_attempt_count: number;
        reconciliation_no_payment_count: number;
        reconciliation_query_error_count: number;
        reconciliation_last_result: string | null;
        transactions: string;
        entitlements: string;
      }>(
        `SELECT
           o.status AS order_status,
           pa.status AS attempt_status,
           pa.reconciliation_state,
           pa.reconciliation_attempt_count,
           pa.reconciliation_no_payment_count,
           pa.reconciliation_query_error_count,
           pa.reconciliation_last_result,
           (SELECT count(*)::text
              FROM payment_transactions
             WHERE order_id = o.id) AS transactions,
           (SELECT count(*)::text
              FROM entitlements
             WHERE source_id = o.id) AS entitlements
         FROM orders o
         JOIN payment_attempts pa ON pa.id = $2
         WHERE o.id = $1`,
        [closed.order.id, closed.attemptId]
      );
      expect(persisted.rows[0]).toEqual({
        order_status: "CLOSED",
        attempt_status: "CLOSED",
        reconciliation_state: "RETRY_SCHEDULED",
        reconciliation_attempt_count: 2,
        reconciliation_no_payment_count: 1,
        reconciliation_query_error_count: 0,
        reconciliation_last_result: "NO_PAYMENT",
        transactions: "0",
        entitlements: "0"
      });
    } finally {
      if (userId) await cleanupEntitlementTestUsers([userId]);
    }
  });

  it("keeps a newer paid generation when an older CLOSED query errors", async () => {
    await seedPolicyFoundation();
    let userId: string | undefined;
    try {
      userId = await createEntitlementTestUser(true);
      const closed = await createScheduledClosedPaymentOrder(
        userId,
        "closed-newer-paid-generation"
      );
      const verified = {
        providerOrderNo: closed.providerOrderNo,
        channel: "wechat_h5" as const,
        channelTransactionId: `closed-newer-paid-${randomUUID()}`,
        amountFen: closed.order.amountFen,
        currency: "CNY" as const,
        paidAt: new Date(Date.now() - 2 * 60_000).toISOString(),
        raw: { source: "closed-newer-paid-generation" }
      };
      let releaseFirstQuery!: () => void;
      const firstQueryReleased = new Promise<void>((resolve) => {
        releaseFirstQuery = resolve;
      });
      let reportFirstQuery!: () => void;
      const firstQueryStarted = new Promise<void>((resolve) => {
        reportFirstQuery = resolve;
      });
      let queryCalls = 0;
      const provider = {
        channel: "wechat_h5" as const,
        async createPayment() {
          throw new Error("must not create");
        },
        async queryPayment() {
          queryCalls += 1;
          if (queryCalls === 1) {
            reportFirstQuery();
            await firstQueryReleased;
            throw new Error("stale provider query failed");
          }
          return verified;
        },
        async refund() {
          return { channelRefundId: "unused", raw: {} };
        }
      };
      const staleWorker = reconcileAndCloseExpiredOrders({
        provider,
        limit: 5,
        providerQueryBudget: 1,
        providerTimeoutMs: 1_000
      });
      await firstQueryStarted;
      await paymentWriteQuery(
        `UPDATE payment_attempts
         SET reconciliation_next_at = now() - interval '1 second'
         WHERE id = $1`,
        [closed.attemptId]
      );
      const newerWorker = await reconcileAndCloseExpiredOrders({
        provider,
        limit: 5,
        providerQueryBudget: 1,
        providerTimeoutMs: 1_000
      });
      expect(newerWorker.summary.providerConfirmedPaidCount).toBe(1);
      releaseFirstQuery();
      await staleWorker;
      expect(queryCalls).toBe(2);
      const persisted = await query<{
        order_status: string;
        reconciliation_state: string;
        reconciliation_attempt_count: number;
        reconciliation_no_payment_count: number;
        reconciliation_query_error_count: number;
        transactions: string;
        entitlements: string;
      }>(
        `SELECT
           o.status AS order_status,
           pa.reconciliation_state,
           pa.reconciliation_attempt_count,
           pa.reconciliation_no_payment_count,
           pa.reconciliation_query_error_count,
           (SELECT count(*)::text
              FROM payment_transactions
             WHERE order_id = o.id) AS transactions,
           (SELECT count(*)::text
              FROM entitlements
             WHERE source_id = o.id) AS entitlements
         FROM orders o
         JOIN payment_attempts pa ON pa.id = $2
         WHERE o.id = $1`,
        [closed.order.id, closed.attemptId]
      );
      expect(persisted.rows[0]).toEqual({
        order_status: "COMPLETED",
        reconciliation_state: "RECOVERED",
        reconciliation_attempt_count: 2,
        reconciliation_no_payment_count: 0,
        reconciliation_query_error_count: 0,
        transactions: "1",
        entitlements: "1"
      });
    } finally {
      if (userId) await cleanupEntitlementTestUsers([userId]);
    }
  });

  it("bounds persistent CLOSED no-payment reconciliation and persists a terminal state", async () => {
    await seedPolicyFoundation();
    let userId: string | undefined;
    try {
      userId = await createEntitlementTestUser(true);
      const closed = await createScheduledClosedPaymentOrder(
        userId,
        "closed-persistent-null"
      );
      let queryCalls = 0;
      const provider = {
        channel: "wechat_h5" as const,
        async createPayment() {
          throw new Error("must not create");
        },
        async queryPayment() {
          queryCalls += 1;
          return null;
        },
        async refund() {
          return { channelRefundId: "unused", raw: {} };
        }
      };
      const summaries = [];
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        await paymentWriteQuery(
          `UPDATE payment_attempts
           SET reconciliation_next_at = now() - interval '1 second'
           WHERE id = $1`,
          [closed.attemptId]
        );
        const reconciliation = await reconcileAndCloseExpiredOrders({
          provider,
          limit: 5,
          providerQueryBudget: 1,
          providerTimeoutMs: 100
        });
        summaries.push(reconciliation.summary);
        expect(reconciliation.summary.scannedCount).toBe(
          reconciliation.summary.closedCount +
            reconciliation.summary.providerConfirmedPaidCount +
            reconciliation.summary.deferredCount +
            reconciliation.summary.terminalCount
        );
        if (attempt < 5) {
          expect(reconciliation.summary).toMatchObject({
            scannedCount: 1,
            deferredCount: 1,
            terminalCount: 0,
            hasMore: false,
            scheduledRecoveryCount: 1,
            closedRecovery: {
              retryScheduledCount: 1,
              terminalCount: 0,
              retryByReason: {
                noPayment: 1,
                queryError: 0
              }
            }
          });
        }
      }
      expect(queryCalls).toBe(5);
      expect(summaries[4]).toMatchObject({
        scannedCount: 1,
        deferredCount: 0,
        terminalCount: 1,
        hasMore: false,
        scheduledRecoveryCount: 0,
        closedRecovery: {
          retryScheduledCount: 0,
          terminalCount: 1,
          terminalByReason: {
            noPaymentLimitExceeded: 1
          }
        }
      });

      const afterTerminal = await reconcileAndCloseExpiredOrders({
        provider,
        limit: 5,
        providerQueryBudget: 1,
        providerTimeoutMs: 100
      });
      expect(afterTerminal.summary).toMatchObject({
        scannedCount: 0,
        terminalCount: 0,
        hasMore: false,
        scheduledRecoveryCount: 0
      });
      expect(queryCalls).toBe(5);
      const persisted = await query<{
        reconciliation_state: string;
        reconciliation_attempt_count: number;
        reconciliation_no_payment_count: number;
        reconciliation_query_error_count: number;
        reconciliation_next_at: Date | null;
        reconciliation_deadline_at: Date | null;
        reconciliation_last_result: string | null;
        transactions: string;
        entitlements: string;
      }>(
        `SELECT
           pa.reconciliation_state,
           pa.reconciliation_attempt_count,
           pa.reconciliation_no_payment_count,
           pa.reconciliation_query_error_count,
           pa.reconciliation_next_at,
           pa.reconciliation_deadline_at,
           pa.reconciliation_last_result,
           (SELECT count(*)::text
              FROM payment_transactions
             WHERE order_id = pa.order_id) AS transactions,
           (SELECT count(*)::text
              FROM entitlements
             WHERE source_id = pa.order_id) AS entitlements
         FROM payment_attempts pa
         WHERE pa.id = $1`,
        [closed.attemptId]
      );
      expect(persisted.rows[0]).toEqual({
        reconciliation_state: "TERMINAL",
        reconciliation_attempt_count: 5,
        reconciliation_no_payment_count: 5,
        reconciliation_query_error_count: 0,
        reconciliation_next_at: null,
        reconciliation_deadline_at: null,
        reconciliation_last_result: "NO_PAYMENT_LIMIT_EXCEEDED",
        transactions: "0",
        entitlements: "0"
      });
    } finally {
      if (userId) await cleanupEntitlementTestUsers([userId]);
    }
  });

  it("backs off a CLOSED provider query error and recovers on a later due retry", async () => {
    await seedPolicyFoundation();
    let userId: string | undefined;
    try {
      userId = await createEntitlementTestUser(true);
      const closed = await createScheduledClosedPaymentOrder(
        userId,
        "closed-query-error"
      );
      let queryCalls = 0;
      const provider = {
        channel: "wechat_h5" as const,
        async createPayment() {
          throw new Error("must not create");
        },
        async queryPayment(orderNo: string) {
          queryCalls += 1;
          if (queryCalls === 1) {
            throw new Error("temporary provider query failure");
          }
          return {
            providerOrderNo: orderNo,
            channel: "wechat_h5" as const,
            channelTransactionId: `closed-query-retry-${randomUUID()}`,
            amountFen: closed.order.amountFen,
            currency: "CNY" as const,
            paidAt: new Date(Date.now() - 2 * 60_000).toISOString(),
            raw: { source: "closed-query-retry" }
          };
        },
        async refund() {
          return { channelRefundId: "unused", raw: {} };
        }
      };

      const errored = await reconcileAndCloseExpiredOrders({
        provider,
        limit: 5,
        providerQueryBudget: 1,
        providerTimeoutMs: 100
      });
      expect(errored.summary).toMatchObject({
        scannedCount: 1,
        deferredCount: 1,
        terminalCount: 0,
        hasMore: false,
        scheduledRecoveryCount: 1,
        closedRecovery: {
          retryScheduledCount: 1,
          retryByReason: {
            noPayment: 0,
            queryError: 1
          }
        }
      });
      const afterError = await query<{
        reconciliation_state: string;
        reconciliation_attempt_count: number;
        reconciliation_no_payment_count: number;
        reconciliation_query_error_count: number;
        reconciliation_next_at: Date;
        reconciliation_last_result: string;
        error_code: string;
      }>(
        `SELECT
           reconciliation_state,
           reconciliation_attempt_count,
           reconciliation_no_payment_count,
           reconciliation_query_error_count,
           reconciliation_next_at,
           reconciliation_last_result,
           error_code
         FROM payment_attempts
         WHERE id = $1`,
        [closed.attemptId]
      );
      expect(afterError.rows[0]).toMatchObject({
        reconciliation_state: "RETRY_SCHEDULED",
        reconciliation_attempt_count: 1,
        reconciliation_no_payment_count: 0,
        reconciliation_query_error_count: 1,
        reconciliation_next_at: expect.any(Date),
        reconciliation_last_result: "QUERY_ERROR",
        error_code: "RECONCILIATION_QUERY_FAILED"
      });
      expect(afterError.rows[0].reconciliation_next_at.getTime())
        .toBeGreaterThan(Date.now());

      const immediate = await reconcileAndCloseExpiredOrders({
        provider,
        limit: 5,
        providerQueryBudget: 1,
        providerTimeoutMs: 100
      });
      expect(immediate.summary).toMatchObject({
        scannedCount: 0,
        hasMore: false,
        scheduledRecoveryCount: 1
      });
      expect(queryCalls).toBe(1);

      await paymentWriteQuery(
        `UPDATE payment_attempts
         SET reconciliation_next_at = now() - interval '1 second'
         WHERE id = $1`,
        [closed.attemptId]
      );
      const recovered = await reconcileAndCloseExpiredOrders({
        provider,
        limit: 5,
        providerQueryBudget: 1,
        providerTimeoutMs: 100
      });
      expect(recovered.summary).toMatchObject({
        scannedCount: 1,
        providerConfirmedPaidCount: 1,
        deferredCount: 0,
        terminalCount: 0,
        scheduledRecoveryCount: 0,
        closedRecovery: {
          recoveredCount: 1
        }
      });
      expect(queryCalls).toBe(2);
      const persisted = await query<{
        status: string;
        reconciliation_state: string;
        reconciliation_attempt_count: number;
        transactions: string;
        entitlements: string;
      }>(
        `SELECT
           o.status,
           pa.reconciliation_state,
           pa.reconciliation_attempt_count,
           (SELECT count(*)::text
              FROM payment_transactions
             WHERE order_id = o.id) AS transactions,
           (SELECT count(*)::text
              FROM entitlements
             WHERE source_id = o.id) AS entitlements
         FROM orders o
         JOIN payment_attempts pa ON pa.id = $2
         WHERE o.id = $1`,
        [closed.order.id, closed.attemptId]
      );
      expect(persisted.rows[0]).toEqual({
        status: "COMPLETED",
        reconciliation_state: "RECOVERED",
        reconciliation_attempt_count: 2,
        transactions: "1",
        entitlements: "1"
      });
    } finally {
      if (userId) await cleanupEntitlementTestUsers([userId]);
    }
  });

  it("keeps CLOSED query errors scheduled beyond five attempts until the recovery deadline", async () => {
    await seedPolicyFoundation();
    let userId: string | undefined;
    try {
      userId = await createEntitlementTestUser(true);
      const closed = await createScheduledClosedPaymentOrder(
        userId,
        "closed-query-error-deadline"
      );
      let queryCalls = 0;
      const provider = {
        channel: "wechat_h5" as const,
        async createPayment() {
          throw new Error("must not create");
        },
        async queryPayment() {
          queryCalls += 1;
          throw new Error("provider remains temporarily unavailable");
        },
        async refund() {
          return { channelRefundId: "unused", raw: {} };
        }
      };

      for (let attempt = 1; attempt <= 6; attempt += 1) {
        await paymentWriteQuery(
          `UPDATE payment_attempts
           SET reconciliation_next_at = now() - interval '1 second'
           WHERE id = $1`,
          [closed.attemptId]
        );
        const reconciliation = await reconcileAndCloseExpiredOrders({
          provider,
          limit: 5,
          providerQueryBudget: 1,
          providerTimeoutMs: 100
        });
        expect(reconciliation.summary).toMatchObject({
          scannedCount: 1,
          deferredCount: 1,
          terminalCount: 0,
          scheduledRecoveryCount: 1,
          closedRecovery: {
            retryScheduledCount: 1,
            retryByReason: {
              noPayment: 0,
              queryError: 1
            }
          }
        });
      }
      expect(queryCalls).toBe(6);
      const stillScheduled = await query<{
        reconciliation_state: string;
        reconciliation_attempt_count: number;
        reconciliation_no_payment_count: number;
        reconciliation_query_error_count: number;
      }>(
        `SELECT
           reconciliation_state,
           reconciliation_attempt_count,
           reconciliation_no_payment_count,
           reconciliation_query_error_count
         FROM payment_attempts
         WHERE id = $1`,
        [closed.attemptId]
      );
      expect(stillScheduled.rows[0]).toEqual({
        reconciliation_state: "RETRY_SCHEDULED",
        reconciliation_attempt_count: 6,
        reconciliation_no_payment_count: 0,
        reconciliation_query_error_count: 6
      });

      await paymentWriteQuery(
        `UPDATE payment_attempts
         SET reconciliation_next_at = now() - interval '2 seconds',
             reconciliation_deadline_at = now() - interval '1 second'
         WHERE id = $1`,
        [closed.attemptId]
      );
      const terminal = await reconcileAndCloseExpiredOrders({
        provider,
        limit: 5,
        providerQueryBudget: 1,
        providerTimeoutMs: 100
      });
      expect(terminal.summary).toMatchObject({
        scannedCount: 1,
        deferredCount: 0,
        terminalCount: 1,
        hasMore: false,
        scheduledRecoveryCount: 0,
        closedRecovery: {
          terminalCount: 1,
          terminalByReason: {
            deadlineExceeded: 1
          }
        }
      });
      expect(queryCalls).toBe(6);
      const persisted = await query<{
        reconciliation_state: string;
        reconciliation_last_result: string;
      }>(
        `SELECT reconciliation_state, reconciliation_last_result
         FROM payment_attempts
         WHERE id = $1`,
        [closed.attemptId]
      );
      expect(persisted.rows[0]).toEqual({
        reconciliation_state: "TERMINAL",
        reconciliation_last_result: "DEADLINE_EXCEEDED"
      });
    } finally {
      if (userId) await cleanupEntitlementTestUsers([userId]);
    }
  });

  it("terminally rejects a CLOSED provider payment captured after order expiry", async () => {
    await seedPolicyFoundation();
    let userId: string | undefined;
    try {
      userId = await createEntitlementTestUser(true);
      const closed = await createScheduledClosedPaymentOrder(
        userId,
        "closed-late-paid"
      );
      let queryCalls = 0;
      const lateTransactionId = `closed-after-expiry-${randomUUID()}`;
      const provider = {
        channel: "wechat_h5" as const,
        async createPayment() {
          throw new Error("must not create");
        },
        async queryPayment(orderNo: string) {
          queryCalls += 1;
          return {
            providerOrderNo: orderNo,
            channel: "wechat_h5" as const,
            channelTransactionId: lateTransactionId,
            amountFen: closed.order.amountFen,
            currency: "CNY" as const,
            paidAt: new Date().toISOString(),
            raw: { source: "closed-after-expiry" }
          };
        },
        async refund() {
          return { channelRefundId: "unused", raw: {} };
        }
      };

      const reconciliation = await reconcileAndCloseExpiredOrders({
        provider,
        limit: 5,
        providerQueryBudget: 1,
        providerTimeoutMs: 100
      });
      expect(reconciliation.summary).toMatchObject({
        scannedCount: 1,
        providerConfirmedPaidCount: 0,
        deferredCount: 0,
        terminalCount: 1,
        hasMore: false,
        scheduledRecoveryCount: 0,
        closedRecovery: {
          terminalCount: 1,
          terminalByReason: {
            paymentAfterExpiry: 1
          }
        }
      });
      expect(queryCalls).toBe(1);
      const persisted = await query<{
        order_status: string;
        reconciliation_state: string;
        reconciliation_attempt_count: number;
        reconciliation_last_result: string;
        transactions: string;
        transaction_attempt_id: string;
        transaction_channel_id: string;
        transaction_amount_fen: string;
        entitlements: string;
      }>(
        `SELECT
           o.status AS order_status,
           pa.reconciliation_state,
           pa.reconciliation_attempt_count,
           pa.reconciliation_last_result,
           (SELECT count(*)::text
              FROM payment_transactions
             WHERE order_id = o.id) AS transactions,
           transaction.payment_attempt_id AS transaction_attempt_id,
           transaction.channel_transaction_id AS transaction_channel_id,
           transaction.amount_fen::text AS transaction_amount_fen,
           (SELECT count(*)::text
              FROM entitlements
             WHERE source_id = o.id) AS entitlements
         FROM orders o
         JOIN payment_attempts pa ON pa.id = $2
         JOIN payment_transactions transaction
           ON transaction.order_id = o.id
          AND transaction.payment_attempt_id = pa.id
          AND transaction.status = 'SUCCESS'
         WHERE o.id = $1`,
        [closed.order.id, closed.attemptId]
      );
      expect(persisted.rows[0]).toEqual({
        order_status: "CLOSED",
        reconciliation_state: "TERMINAL",
        reconciliation_attempt_count: 1,
        reconciliation_last_result: "PAYMENT_AFTER_EXPIRY",
        transactions: "1",
        transaction_attempt_id: closed.attemptId,
        transaction_channel_id: lateTransactionId,
        transaction_amount_fen: closed.order.amountFen,
        entitlements: "0"
      });
    } finally {
      if (userId) await cleanupEntitlementTestUsers([userId]);
    }
  });

  it("keeps CLOSED worker recovery idempotent with a concurrent payment callback", async () => {
    await seedPolicyFoundation();
    let userId: string | undefined;
    try {
      userId = await createEntitlementTestUser(true);
      const closed = await createScheduledClosedPaymentOrder(
        userId,
        "closed-callback-race"
      );
      const verified = {
        providerOrderNo: closed.providerOrderNo,
        channel: "wechat_h5" as const,
        channelTransactionId: `closed-callback-${randomUUID()}`,
        amountFen: closed.order.amountFen,
        currency: "CNY" as const,
        paidAt: new Date(Date.now() - 2 * 60_000).toISOString(),
        raw: { source: "closed-callback-race" }
      };
      let releaseProvider!: () => void;
      const providerReleased = new Promise<void>((resolve) => {
        releaseProvider = resolve;
      });
      let reportProviderQuery!: () => void;
      const providerQueried = new Promise<void>((resolve) => {
        reportProviderQuery = resolve;
      });
      let queryCalls = 0;
      const provider = {
        channel: "wechat_h5" as const,
        async createPayment() {
          throw new Error("must not create");
        },
        async queryPayment() {
          queryCalls += 1;
          reportProviderQuery();
          await providerReleased;
          return null;
        },
        async refund() {
          return { channelRefundId: "unused", raw: {} };
        }
      };

      const worker = reconcileAndCloseExpiredOrders({
        provider,
        limit: 5,
        providerQueryBudget: 1,
        providerTimeoutMs: 1_000
      });
      await providerQueried;
      const callback = markOrderPaid({
        orderId: closed.order.id,
        paymentAttemptId: closed.attemptId,
        verified
      });
      await callback;
      releaseProvider();
      await expect(worker).resolves.toMatchObject({
        summary: {
          providerConfirmedPaidCount: 0,
          closedRecovery: {
            recoveredCount: 0,
            changedStateCount: 1
          }
        }
      });
      expect(queryCalls).toBe(1);
      const persisted = await query<{
        status: string;
        attempt_status: string;
        reconciliation_state: string;
        transactions: string;
        entitlements: string;
      }>(
        `SELECT
           o.status,
           pa.status AS attempt_status,
           pa.reconciliation_state,
           (SELECT count(*)::text
              FROM payment_transactions
             WHERE order_id = o.id) AS transactions,
           (SELECT count(*)::text
              FROM entitlements
             WHERE source_id = o.id) AS entitlements
         FROM orders o
         JOIN payment_attempts pa ON pa.id = $2
         WHERE o.id = $1`,
        [closed.order.id, closed.attemptId]
      );
      expect(persisted.rows[0]).toEqual({
        status: "COMPLETED",
        attempt_status: "SUCCEEDED",
        reconciliation_state: "RECOVERED",
        transactions: "1",
        entitlements: "1"
      });
    } finally {
      if (userId) await cleanupEntitlementTestUsers([userId]);
    }
  });

  it("schedules the latest due attempt per order and provider channel", async () => {
    await seedPolicyFoundation();
    let userId: string | undefined;
    try {
      userId = await createEntitlementTestUser(true);
      const makeMultiChannelClosedOrder = async (marker: string) => {
        const order = await createOrder({
          userId: userId!,
          sku: "POLICY_CALC",
          channel: "main",
          idempotencyKey: `${marker}-${randomUUID()}`,
          businessDraftId: await insertPolicyDraft(userId!)
        });
        await query(
          `UPDATE orders
           SET status = 'CLOSED',
               created_at = now() - interval '3 minutes',
               expires_at = now() - interval '1 minute',
               closed_at = now(),
               updated_at = now()
           WHERE id = $1`,
          [order.id]
        );
        const wechatAttempt = await insertIdentityAwarePaymentAttempt({
          orderId: order.id,
          channel: "wechat_h5",
          status: "CLOSED",
          reconciliationState: "REQUIRED",
          reconciliationNextAt: new Date(Date.now() - 1_000),
          reconciliationDeadlineAt: new Date(Date.now() + 24 * 60 * 60_000),
          reconciliationLastResult: "LOCAL_CLOSE_PENDING_FINAL_QUERY",
          createdAt: new Date(Date.now() - 2 * 60_000)
        });
        const alipayAttempt = await insertIdentityAwarePaymentAttempt({
          orderId: order.id,
          channel: "alipay_wap",
          status: "CLOSED",
          reconciliationState: "REQUIRED",
          reconciliationNextAt: new Date(Date.now() - 1_000),
          reconciliationDeadlineAt: new Date(Date.now() + 24 * 60 * 60_000),
          reconciliationLastResult: "LOCAL_CLOSE_PENDING_FINAL_QUERY",
          createdAt: new Date(Date.now() - 60_000)
        });
        return {
          order,
          attemptByChannel: new Map(
            [wechatAttempt, alipayAttempt].map((attempt) => [
              attempt.channel,
              attempt.id
            ])
          ),
          providerOrderNoByChannel: new Map(
            [wechatAttempt, alipayAttempt].map((attempt) => [
              attempt.channel,
              attempt.providerOrderNo
            ])
          )
        };
      };
      const recovered = await makeMultiChannelClosedOrder(
        "multi-channel-recovered"
      );
      const terminal = await makeMultiChannelClosedOrder(
        "multi-channel-terminal"
      );
      const wechatCalls: string[] = [];
      const wechatProvider = {
        channel: "wechat_h5" as const,
        async createPayment() {
          throw new Error("must not create");
        },
        async queryPayment(orderNo: string) {
          wechatCalls.push(orderNo);
          if (
            orderNo === terminal.providerOrderNoByChannel.get("wechat_h5")
          ) return null;
          return {
            providerOrderNo: orderNo,
            channel: "wechat_h5" as const,
            channelTransactionId: `wechat-recovered-${randomUUID()}`,
            amountFen: recovered.order.amountFen,
            currency: "CNY" as const,
            paidAt: new Date(Date.now() - 2 * 60_000).toISOString(),
            raw: { source: "multi-channel-wechat" }
          };
        },
        async refund() {
          return { channelRefundId: "unused", raw: {} };
        }
      };
      const wechat = await reconcileAndCloseExpiredOrders({
        provider: wechatProvider,
        limit: 5,
        providerQueryBudget: 5,
        providerTimeoutMs: 100
      });
      expect(wechatCalls.sort()).toEqual(
        [
          recovered.providerOrderNoByChannel.get("wechat_h5"),
          terminal.providerOrderNoByChannel.get("wechat_h5")
        ].sort()
      );
      expect(wechat.summary).toMatchObject({
        scannedCount: 2,
        providerConfirmedPaidCount: 1,
        deferredCount: 1,
        terminalCount: 0,
        scheduledRecoveryCount: 1,
        closedRecovery: {
          scannedCount: 2,
          recoveredCount: 1,
          retryScheduledCount: 1
        }
      });

      let alipayCalls = 0;
      const alipayProvider = {
        channel: "alipay_wap" as const,
        async createPayment() {
          throw new Error("must not create");
        },
        async queryPayment(orderNo: string) {
          alipayCalls += 1;
          expect(orderNo).toBe(
            terminal.providerOrderNoByChannel.get("alipay_wap")
          );
          return {
            providerOrderNo: orderNo,
            channel: "alipay_wap" as const,
            channelTransactionId: `alipay-terminal-${randomUUID()}`,
            amountFen: terminal.order.amountFen,
            currency: "CNY" as const,
            paidAt: new Date().toISOString(),
            raw: { source: "multi-channel-alipay" }
          };
        },
        async refund() {
          return { channelRefundId: "unused", raw: {} };
        }
      };
      const alipay = await reconcileAndCloseExpiredOrders({
        provider: alipayProvider,
        limit: 5,
        providerQueryBudget: 5,
        providerTimeoutMs: 100
      });
      expect(alipayCalls).toBe(1);
      expect(alipay.summary).toMatchObject({
        scannedCount: 1,
        providerConfirmedPaidCount: 0,
        deferredCount: 0,
        terminalCount: 1,
        scheduledRecoveryCount: 0,
        closedRecovery: {
          scannedCount: 1,
          terminalCount: 1,
          terminalByReason: {
            paymentAfterExpiry: 1
          }
        }
      });

      const persisted = await query<{
        order_id: string;
        channel: string;
        reconciliation_state: string;
      }>(
        `SELECT order_id, channel, reconciliation_state
         FROM payment_attempts
         WHERE order_id = ANY($1::uuid[])
         ORDER BY order_id, channel`,
        [[recovered.order.id, terminal.order.id]]
      );
      expect(
        new Map(
          persisted.rows.map((row) => [
            `${row.order_id}:${row.channel}`,
            row.reconciliation_state
          ])
        )
      ).toEqual(
        new Map([
          [
            `${recovered.order.id}:wechat_h5`,
            "RECOVERED"
          ],
          [
            `${recovered.order.id}:alipay_wap`,
            "TERMINAL"
          ],
          [
            `${terminal.order.id}:wechat_h5`,
            "RETRY_SCHEDULED"
          ],
          [
            `${terminal.order.id}:alipay_wap`,
            "TERMINAL"
          ]
        ])
      );
    } finally {
      if (userId) await cleanupEntitlementTestUsers([userId]);
    }
  });

  it("aborts a timed out provider and delays prepay retry during grace", async () => {
    await seedPolicyFoundation();
    let userId: string | undefined;
    try {
      userId = await createEntitlementTestUser(true);
      const order = await createOrder({
        userId,
        sku: "POLICY_CALC",
        channel: "main",
        idempotencyKey: `provider-timeout-${randomUUID()}`,
        businessDraftId: await insertPolicyDraft(userId)
      });
      const seenAttempts: string[] = [];
      const createdProviderOrderNos: string[] = [];
      const queriedProviderOrderNos: string[] = [];
      let timedOutSignal: AbortSignal | undefined;
      let queryCalls = 0;
      let calls = 0;
      const provider = {
        channel: "wechat_h5" as const,
        async createPayment(input: {
          attemptId: string;
          orderNo: string;
          providerOrderNo: string;
          signal: AbortSignal;
        }) {
          seenAttempts.push(input.attemptId);
          createdProviderOrderNos.push(input.providerOrderNo);
          calls += 1;
          if (calls === 1) {
            timedOutSignal = input.signal;
            return await new Promise<never>((_resolve, reject) => {
              input.signal.addEventListener(
                "abort",
                () => reject(new Error("provider aborted")),
                { once: true }
              );
            });
          }
          return {
            prepayId: `timeout-retry-${input.attemptId}`,
            launchUrl: `/timeout-retry/${input.orderNo}`,
            response: {}
          };
        },
        async queryPayment(providerOrderNo: string, signal: AbortSignal) {
          expect(signal.aborted).toBe(false);
          queryCalls += 1;
          queriedProviderOrderNos.push(providerOrderNo);
          return null;
        },
        async refund() {
          return { channelRefundId: "unused", raw: {} };
        }
      };
      const start = () =>
        startPayment({
          userId: userId!,
          orderId: order.id,
          productChannel: order.channel,
          provider,
          clientIp: "127.0.0.1",
          returnUrl: "http://peileme.test/return",
          notifyUrl: "http://peileme.test/notify",
          providerTimeoutMs: 20
        });

      const startedAt = Date.now();
      await expect(start()).rejects.toMatchObject({
        code: "PAYMENT_PROVIDER_FAILED"
      });
      expect(Date.now() - startedAt).toBeLessThan(1_000);
      expect(timedOutSignal?.aborted).toBe(true);
      const timedOutAttempt = await query<{
        error_code: string | null;
        status: string;
      }>(
        `SELECT error_code, status
         FROM payment_attempts
         WHERE order_id = $1`,
        [order.id]
      );
      expect(timedOutAttempt.rows[0]).toEqual({
        error_code: "PAYMENT_PROVIDER_TIMEOUT",
        status: "CREATE_UNKNOWN"
      });
      await expect(start()).rejects.toMatchObject({
        code: "PAYMENT_INITIALIZING"
      });
      expect({ calls, queryCalls }).toEqual({ calls: 1, queryCalls: 1 });
      expect(seenAttempts).toHaveLength(1);
      expect(queriedProviderOrderNos).toEqual(createdProviderOrderNos);
    } finally {
      if (userId) await cleanupEntitlementTestUsers([userId]);
    }
  });

  it("recovers a provider-confirmed failed payment without creating a new prepay", async () => {
    await seedPolicyFoundation();
    let userId: string | undefined;
    try {
      userId = await createEntitlementTestUser(true);
      const failed = await createFailedPaymentOrder(
        userId,
        "query-paid-recovery"
      );
      let createCalls = 0;
      let queryCalls = 0;
      const provider = {
        channel: "wechat_h5" as const,
        async createPayment() {
          createCalls += 1;
          throw new Error("must not create");
        },
        async queryPayment(orderNo: string) {
          queryCalls += 1;
          return {
            providerOrderNo: orderNo,
            channel: "wechat_h5" as const,
            channelTransactionId: `query-paid-${randomUUID()}`,
            amountFen: failed.order.amountFen,
            currency: "CNY" as const,
            paidAt: new Date().toISOString(),
            raw: { source: "provider-query" }
          };
        },
        async refund() {
          return { channelRefundId: "unused", raw: {} };
        }
      };
      await expect(
        startPayment({
          userId,
          orderId: failed.order.id,
          productChannel: failed.order.channel,
          provider,
          clientIp: "127.0.0.1",
          returnUrl: "http://peileme.test/return",
          notifyUrl: "http://peileme.test/notify",
          providerTimeoutMs: 100
        })
      ).resolves.toMatchObject({
        status: "COMPLETED",
        paymentAttemptId: failed.attemptId,
        launchUrl: "http://peileme.test/return"
      });
      expect({ createCalls, queryCalls }).toEqual({
        createCalls: 0,
        queryCalls: 1
      });
      const persisted = await query<{
        attempts: string;
        transactions: string;
        entitlements: string;
      }>(
        `SELECT
           (SELECT count(*)::text FROM payment_attempts WHERE order_id = $1)
             AS attempts,
           (SELECT count(*)::text FROM payment_transactions WHERE order_id = $1)
             AS transactions,
           (SELECT count(*)::text FROM entitlements WHERE source_id = $1)
             AS entitlements`,
        [failed.order.id]
      );
      expect(persisted.rows[0]).toEqual({
        attempts: "1",
        transactions: "1",
        entitlements: "1"
      });
    } finally {
      if (userId) await cleanupEntitlementTestUsers([userId]);
    }
  });

  it("keeps the uncertain attempt locked when provider query reports no payment", async () => {
    await seedPolicyFoundation();
    let userId: string | undefined;
    try {
      userId = await createEntitlementTestUser(true);
      const failed = await createFailedPaymentOrder(
        userId,
        "query-null-retry"
      );
      let createCalls = 0;
      let queryCalls = 0;
      const provider = {
        channel: "wechat_h5" as const,
        async createPayment(input: {
          attemptId: string;
          orderNo: string;
        }) {
          createCalls += 1;
          return {
            prepayId: `query-null-${input.attemptId}`,
            launchUrl: `/query-null/${input.orderNo}`,
            response: {}
          };
        },
        async queryPayment() {
          queryCalls += 1;
          return null;
        },
        async refund() {
          return { channelRefundId: "unused", raw: {} };
        }
      };
      await expect(
        startPayment({
          userId,
          orderId: failed.order.id,
          productChannel: failed.order.channel,
          provider,
          clientIp: "127.0.0.1",
          returnUrl: "http://peileme.test/return",
          notifyUrl: "http://peileme.test/notify",
          providerTimeoutMs: 100
        })
      ).rejects.toMatchObject({ code: "PAYMENT_INITIALIZING" });
      expect({ createCalls, queryCalls }).toEqual({
        createCalls: 0,
        queryCalls: 1
      });
      const attempts = await query<{ count: string; status: string }>(
        `SELECT count(*)::text AS count, max(status) AS status
           FROM payment_attempts
          WHERE order_id = $1`,
        [failed.order.id]
      );
      expect(attempts.rows[0]).toEqual({
        count: "1",
        status: "CREATE_UNKNOWN"
      });
    } finally {
      if (userId) await cleanupEntitlementTestUsers([userId]);
    }
  });

  it("keeps a failed order unchanged when provider query errors", async () => {
    await seedPolicyFoundation();
    let userId: string | undefined;
    try {
      userId = await createEntitlementTestUser(true);
      const failed = await createFailedPaymentOrder(
        userId,
        "query-error-safe"
      );
      let createCalls = 0;
      const provider = {
        channel: "wechat_h5" as const,
        async createPayment() {
          createCalls += 1;
          throw new Error("must not create");
        },
        async queryPayment() {
          throw new Error("provider query unavailable secret");
        },
        async refund() {
          return { channelRefundId: "unused", raw: {} };
        }
      };
      await expect(
        startPayment({
          userId,
          orderId: failed.order.id,
          productChannel: failed.order.channel,
          provider,
          clientIp: "127.0.0.1",
          returnUrl: "http://peileme.test/return",
          notifyUrl: "http://peileme.test/notify",
          providerTimeoutMs: 100
        })
      ).rejects.toMatchObject({
        code: "PAYMENT_PROVIDER_FAILED"
      });
      expect(createCalls).toBe(0);
      const persisted = await query<{
        status: string;
        attempts: string;
        transactions: string;
      }>(
        `SELECT
           status,
           (SELECT count(*)::text FROM payment_attempts WHERE order_id = $1)
             AS attempts,
           (SELECT count(*)::text FROM payment_transactions WHERE order_id = $1)
             AS transactions
         FROM orders
         WHERE id = $1`,
        [failed.order.id]
      );
      expect(persisted.rows[0]).toEqual({
        status: "PAYING",
        attempts: "1",
        transactions: "0"
      });
    } finally {
      if (userId) await cleanupEntitlementTestUsers([userId]);
    }
  });

  it("recovers paid CLOSED orders and preserves null or errored ones", async () => {
    await seedPolicyFoundation();
    let userId: string | undefined;
    try {
      userId = await createEntitlementTestUser(true);
      const paid = await createFailedPaymentOrder(userId, "closed-paid");
      const unpaid = await createFailedPaymentOrder(userId, "closed-unpaid");
      const errored = await createFailedPaymentOrder(
        userId,
        "closed-query-error"
      );
      await query(
        `UPDATE orders
         SET status = 'CLOSED',
             closed_at = now()
         WHERE id = ANY($1::uuid[])`,
        [[paid.order.id, unpaid.order.id, errored.order.id]]
      );
      await paymentWriteQuery(
        `UPDATE payment_attempts
         SET status = 'CLOSED',
             reconciliation_state = 'REQUIRED',
             reconciliation_next_at = now() - interval '1 second',
             reconciliation_deadline_at = now() + interval '24 hours',
             reconciliation_last_result = 'LOCAL_CLOSE_PENDING_FINAL_QUERY'
         WHERE order_id = ANY($1::uuid[])`,
        [[paid.order.id, unpaid.order.id, errored.order.id]]
      );
      let mode: "paid" | "null" | "error" = "paid";
      let createCalls = 0;
      const provider = {
        channel: "wechat_h5" as const,
        async createPayment() {
          createCalls += 1;
          throw new Error("must not create");
        },
        async queryPayment(orderNo: string, signal: AbortSignal) {
          expect(signal.aborted).toBe(false);
          if (mode === "error") {
            throw new Error("closed provider query secret");
          }
          if (mode === "null") return null;
          return {
            providerOrderNo: orderNo,
            channel: "wechat_h5" as const,
            channelTransactionId: `closed-paid-${randomUUID()}`,
            amountFen: paid.order.amountFen,
            currency: "CNY" as const,
            paidAt: new Date().toISOString(),
            raw: { source: "closed-recovery" }
          };
        },
        async refund() {
          return { channelRefundId: "unused", raw: {} };
        }
      };
      const start = (orderId: string) =>
        startPayment({
          userId: userId!,
          orderId,
          productChannel: "main",
          provider,
          clientIp: "127.0.0.1",
          returnUrl: "http://peileme.test/return",
          notifyUrl: "http://peileme.test/notify",
          providerTimeoutMs: 100
        });

      await expect(start(paid.order.id)).resolves.toMatchObject({
        status: "COMPLETED",
        paymentAttemptId: paid.attemptId
      });
      mode = "null";
      await expect(start(unpaid.order.id)).rejects.toMatchObject({
        code: "PAYMENT_CHANNEL_LOCKED"
      });
      mode = "error";
      await expect(start(errored.order.id)).rejects.toMatchObject({
        code: "PAYMENT_PROVIDER_FAILED"
      });
      expect(createCalls).toBe(0);
      const states = await query<{
        id: string;
        status: string;
        transactions: string;
        entitlements: string;
      }>(
        `SELECT
           o.id,
           o.status,
           (
             SELECT count(*)::text
             FROM payment_transactions pt
             WHERE pt.order_id = o.id
           ) AS transactions,
           (
             SELECT count(*)::text
             FROM entitlements e
             WHERE e.source_id = o.id
           ) AS entitlements
         FROM orders o
         WHERE o.id = ANY($1::uuid[])
         ORDER BY o.id`,
        [[paid.order.id, unpaid.order.id, errored.order.id]]
      );
      expect(
        new Map(states.rows.map((row) => [row.id, row]))
      ).toEqual(
        new Map([
          [
            paid.order.id,
            {
              id: paid.order.id,
              status: "COMPLETED",
              transactions: "1",
              entitlements: "1"
            }
          ],
          [
            unpaid.order.id,
            {
              id: unpaid.order.id,
              status: "CLOSED",
              transactions: "0",
              entitlements: "0"
            }
          ],
          [
            errored.order.id,
            {
              id: errored.order.id,
              status: "CLOSED",
              transactions: "0",
              entitlements: "0"
            }
          ]
        ])
      );
    } finally {
      if (userId) await cleanupEntitlementTestUsers([userId]);
    }
  });

  it("allows one of two orders to own a concurrent provider transaction ID", async () => {
    await seedPolicyFoundation();
    const userIds: string[] = [];
    try {
      const userId = await createEntitlementTestUser(true);
      userIds.push(userId);
      const makePayableOrder = async () => {
        const businessDraftId = await insertPolicyDraft(userId);
        const order = await createOrder({
          userId,
          sku: "POLICY_CALC",
          channel: "main",
          idempotencyKey: `transaction-owner-${randomUUID()}`,
          businessDraftId
        });
        const attempt = await insertIdentityAwarePaymentAttempt({
          orderId: order.id,
          channel: "wechat_h5",
          status: "PENDING"
        });
        return {
          order,
          attemptId: attempt.id,
          providerOrderNo: attempt.providerOrderNo
        };
      };
      const [first, second] = await Promise.all([
        makePayableOrder(),
        makePayableOrder()
      ]);
      const channelTransactionId = `shared-${randomUUID()}`;
      const settle = ({ order, attemptId, providerOrderNo }: typeof first) =>
        markOrderPaid({
          orderId: order.id,
          paymentAttemptId: attemptId,
          verified: {
            providerOrderNo,
            channel: "wechat_h5",
            channelTransactionId,
            amountFen: order.amountFen,
            currency: "CNY",
            paidAt: new Date().toISOString(),
            raw: { source: "transaction-owner-race" }
          }
        });
      const outcomes = await Promise.allSettled([
        settle(first),
        settle(second)
      ]);
      expect(outcomes.filter((item) => item.status === "fulfilled"))
        .toHaveLength(1);
      expect(outcomes.filter((item) => item.status === "rejected")).toEqual([
        expect.objectContaining({
          reason: expect.objectContaining({
            code: "PAYMENT_VERIFICATION_FAILED"
          })
        })
      ]);

      const persisted = await query<{
        transactions: string;
        entitlements: string;
        completed: string;
        anomalies: string;
        closed: string;
      }>(
        `SELECT
           (SELECT count(*)::text
              FROM payment_transactions
             WHERE channel_transaction_id = $1) AS transactions,
           (SELECT count(*)::text
              FROM entitlements
             WHERE source_id = ANY($2::uuid[])) AS entitlements,
           (SELECT count(*)::text
              FROM orders
             WHERE id = ANY($2::uuid[])
               AND status = 'COMPLETED') AS completed,
           (SELECT count(*)::text
              FROM payment_anomalies
             WHERE provider_channel = 'wechat_h5'
               AND channel_transaction_id = $1) AS anomalies,
           (SELECT count(*)::text
              FROM orders
             WHERE id = ANY($2::uuid[])
               AND status = 'CLOSED') AS closed`,
        [channelTransactionId, [first.order.id, second.order.id]]
      );
      expect(persisted.rows[0]).toEqual({
        transactions: "1",
        entitlements: "1",
        completed: "1",
        anomalies: "1",
        closed: "1"
      });
    } finally {
      await cleanupEntitlementTestUsers(userIds);
    }
  });

  it("settles payment versus expiry closure without partial fulfillment", async () => {
    await seedPolicyFoundation();
    let userId: string | undefined;
    try {
      userId = await createEntitlementTestUser(true);
      const order = await createOrder({
        userId,
        sku: "POLICY_CALC",
        channel: "main",
        idempotencyKey: `expiry-race-${randomUUID()}`,
        businessDraftId: await insertPolicyDraft(userId)
      });
      const attempt = await insertIdentityAwarePaymentAttempt({
        orderId: order.id,
        channel: "wechat_h5",
        status: "PENDING"
      });
      await query(
        `UPDATE orders
            SET status = 'PAYING',
                created_at = now() - interval '2 seconds',
                expires_at = now() - interval '1 second'
          WHERE id = $1`,
        [order.id]
      );
      const payment = markOrderPaid({
        orderId: order.id,
        paymentAttemptId: attempt.id,
        verified: {
          providerOrderNo: attempt.providerOrderNo,
          channel: "wechat_h5",
          channelTransactionId: `expiry-${randomUUID()}`,
          amountFen: order.amountFen,
          currency: "CNY",
          paidAt: new Date().toISOString(),
          raw: { source: "expiry-race" }
        }
      });
      const cleanupProvider = {
        channel: "wechat_h5" as const,
        async createPayment() {
          throw new Error("cleanup must not create");
        },
        async queryPayment() {
          return null;
        },
        async refund() {
          return { channelRefundId: "unused", raw: {} };
        }
      };
      const close = () =>
        reconcileAndCloseExpiredOrders({
          provider: cleanupProvider,
          limit: 10,
          providerTimeoutMs: 100
        });
      const outcomes = await Promise.allSettled([
        payment,
        close()
      ]);
      expect(outcomes[1].status).toBe("fulfilled");
      if (outcomes[1].status === "fulfilled") {
        const summary = outcomes[1].value.summary;
        expect(summary.scannedCount).toBe(
          summary.closedCount +
            summary.providerConfirmedPaidCount +
            summary.deferredCount +
            summary.terminalCount
        );
      }
      if (outcomes[0].status === "rejected") {
        await close();
      }

      const persisted = await query<{
        status: string;
        attempt_status: string;
        transactions: string;
        entitlements: string;
      }>(
        `SELECT
           o.status,
           pa.status AS attempt_status,
           (SELECT count(*)::text FROM payment_transactions WHERE order_id = o.id)
             AS transactions,
           (SELECT count(*)::text FROM entitlements WHERE source_id = o.id)
             AS entitlements
         FROM orders o
         JOIN payment_attempts pa ON pa.order_id = o.id
         WHERE o.id = $1`,
        [order.id]
      );
      expect(persisted.rows[0]).toEqual(
        outcomes[0].status === "fulfilled"
          ? {
              status: "COMPLETED",
              attempt_status: "SUCCEEDED",
              transactions: "1",
              entitlements: "1"
            }
          : {
              status: "CLOSED",
              attempt_status: "CLOSED",
              transactions: "1",
              entitlements: "0"
            }
      );
      if (outcomes[0].status === "rejected") {
        expect([
          "ORDER_STATE_CONFLICT",
          "PAYMENT_VERIFICATION_FAILED"
        ]).toContain(outcomes[0].reason.code);
      }
    } finally {
      if (userId) await cleanupEntitlementTestUsers([userId]);
    }
  });

  it(
    "keeps CLOSED reconciliation index-bounded with fifty thousand ineligible attempts",
    async () => {
      const originalDatabaseUrl = process.env.DATABASE_URL!;
      const baseUrl = new URL(originalDatabaseUrl);
      const databaseName =
        `peileme_plan_${randomUUID().replaceAll("-", "")}`;
      const adminUrl = new URL(baseUrl);
      adminUrl.pathname = "/postgres";
      const isolatedUrl = new URL(baseUrl);
      isolatedUrl.pathname = `/${databaseName}`;
      const admin = new Client({ connectionString: adminUrl.toString() });
      let databaseCreated = false;
      try {
        await admin.connect();
        await admin.query(`CREATE DATABASE "${databaseName}"`);
        databaseCreated = true;
        await closePool();
        process.env.DATABASE_URL = isolatedUrl.toString();
        resetConfigForTests();
        await runMigrations();
        await query("VACUUM (ANALYZE) orders, payment_attempts");
        const user = await query<{ id: string }>(
          `INSERT INTO users(email, email_verified_at)
           VALUES ($1, now())
           RETURNING id`,
          [`plan-${randomUUID()}@peileme.test`]
        );
        const userId = user.rows[0].id;
        const initialGuards = await query<{
          tgname: string;
          tgenabled: string;
        }>(
          `SELECT tgname, tgenabled
             FROM pg_trigger
            WHERE tgname IN (
              'provider_payment_owner_guard_trigger',
              'payment_attempt_provider_owner_guard_trigger'
            )
            ORDER BY tgname`
        );
        expect(initialGuards.rows).toEqual([
          {
            tgname: "payment_attempt_provider_owner_guard_trigger",
            tgenabled: "O"
          },
          {
            tgname: "provider_payment_owner_guard_trigger",
            tgenabled: "O"
          }
        ]);
        await withTransaction(async (client) => {
          await client.query("SET LOCAL statement_timeout = '20s'");
          await enableIdentityPaymentWrites(client);
          await client.query(
            `WITH generated_orders AS (
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
               created_at,
               updated_at
             )
             SELECT
               'PLMPLAN' || lpad(value::text, 8, '0'),
               $1,
               'main',
               'CLOSED',
               0,
               'CNY',
               'reconciliation-plan-' || value::text,
               now() - interval '1 hour',
               now() - interval '30 minutes',
               now() - interval '2 hours',
               now() - interval '30 minutes'
             FROM generate_series(1, 50010) value
             RETURNING id, order_no
           ), prepared_attempts AS (
             SELECT
               id AS order_id,
               order_no,
               gen_random_uuid() AS identity_id,
               gen_random_uuid() AS attempt_id
             FROM generated_orders
           ), inserted_identities AS (
             INSERT INTO provider_payment_orders(
               id,
               order_id,
               channel,
               provider_order_no,
               origin,
               allocated_at,
               canonical_attempt_id,
               manual_review_required
             )
             SELECT
               identity_id,
               order_id,
               'wechat_h5',
               order_no,
               'legacy_order_no',
               now(),
               attempt_id,
               false
             FROM prepared_attempts
             RETURNING id
           )
           INSERT INTO payment_attempts(
             id,
             order_id,
             channel,
             status,
             provider_payment_order_id,
             provider_identity_role,
             provider_operation_eligible,
             request_snapshot,
             reconciliation_state,
             reconciliation_next_at,
             reconciliation_deadline_at,
             reconciliation_last_result
           )
           SELECT
             prepared.attempt_id,
             prepared.order_id,
             'wechat_h5',
             'CLOSED',
             prepared.identity_id,
             'canonical_owner',
             true,
             jsonb_build_object('providerOrderNo', prepared.order_no),
             CASE
               WHEN prepared.order_no > 'PLMPLAN00050000'
                 THEN 'REQUIRED'
               ELSE 'NONE'
             END,
             CASE
               WHEN prepared.order_no > 'PLMPLAN00050000'
                 THEN now() - interval '1 second'
               ELSE NULL
             END,
             CASE
               WHEN prepared.order_no > 'PLMPLAN00050000'
                 THEN now() + interval '24 hours'
               ELSE NULL
             END,
             CASE
               WHEN prepared.order_no > 'PLMPLAN00050000'
                 THEN 'LOCAL_CLOSE_PENDING_FINAL_QUERY'
               ELSE NULL
             END
           FROM prepared_attempts prepared
           JOIN inserted_identities identity
             ON identity.id = prepared.identity_id`,
            [userId]
          );
          const invariant = await client.query<{ invalid_count: string }>(
            `SELECT count(*)::text AS invalid_count
             FROM provider_payment_orders identity
             LEFT JOIN payment_attempts attempt
               ON attempt.id = identity.canonical_attempt_id
             WHERE identity.order_id IN (
               SELECT id
               FROM orders
               WHERE user_id = $1
                 AND idempotency_key LIKE 'reconciliation-plan-%'
             )
               AND (
                 attempt.id IS NULL
                 OR attempt.order_id <> identity.order_id
                 OR attempt.channel <> identity.channel
                 OR attempt.provider_payment_order_id <> identity.id
                 OR attempt.provider_identity_role <> 'canonical_owner'
                 OR NOT attempt.provider_operation_eligible
                 OR attempt.request_snapshot ->> 'providerOrderNo'
                      IS DISTINCT FROM identity.provider_order_no
               )`,
            [userId]
          );
          expect(invariant.rows[0]?.invalid_count).toBe("0");
          await client.query("SET CONSTRAINTS ALL IMMEDIATE");
        });

        const statusUpdateStartedAt = Date.now();
        await withTransaction(async (client) => {
          await client.query("SET LOCAL statement_timeout = '20s'");
          await enableIdentityPaymentWrites(client);
          const updated = await client.query(
            `UPDATE payment_attempts attempt
                SET status = 'CLOSED',
                    updated_at = attempt.updated_at
               FROM orders order_row
              WHERE order_row.id = attempt.order_id
                AND order_row.user_id = $1
                AND order_row.idempotency_key LIKE 'reconciliation-plan-%'`,
            [userId]
          );
          expect(updated.rowCount).toBe(50_010);
          await client.query("SET CONSTRAINTS ALL IMMEDIATE");
        });
        expect(Date.now() - statusUpdateStartedAt).toBeLessThan(20_000);

        const enabledGuards = await query<{
          tgname: string;
          tgenabled: string;
        }>(
          `SELECT tgname, tgenabled
             FROM pg_trigger
            WHERE tgname IN (
              'provider_payment_owner_guard_trigger',
              'payment_attempt_provider_owner_guard_trigger'
            )
            ORDER BY tgname`
        );
        expect(enabledGuards.rows).toEqual(initialGuards.rows);

        await query("ANALYZE orders, payment_attempts");
        const ownerLookup = await query<{ "QUERY PLAN": unknown }>(
          `EXPLAIN (FORMAT JSON)
           SELECT id
             FROM provider_payment_orders
            WHERE canonical_attempt_id = (
              SELECT id
                FROM payment_attempts
               LIMIT 1
            )`
        );
        expect(JSON.stringify(ownerLookup.rows[0]["QUERY PLAN"])).toContain(
          "provider_payment_orders_canonical_attempt_unique"
        );
        const explained = await query<{ "QUERY PLAN": unknown }>(
          `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
           WITH due_attempts AS MATERIALIZED (
             SELECT
               pa.id,
               pa.order_id,
               pa.channel,
               pa.reconciliation_next_at,
               pa.reconciliation_deadline_at
             FROM payment_attempts pa
             WHERE pa.channel = 'wechat_h5'
               AND pa.reconciliation_state IN (
                 'REQUIRED',
                 'RETRY_SCHEDULED'
               )
               AND (
                 pa.reconciliation_next_at <= now()
                 OR pa.reconciliation_deadline_at <= now()
               )
             ORDER BY
               LEAST(
                 pa.reconciliation_next_at,
                 pa.reconciliation_deadline_at
               ),
               pa.updated_at,
               pa.id
             LIMIT 10
           )
           SELECT due_attempts.id
           FROM due_attempts
           JOIN orders o ON o.id = due_attempts.order_id
           WHERE o.status = 'CLOSED'`
        );
        const plan = JSON.stringify(explained.rows[0]["QUERY PLAN"]);
        expect(plan).not.toMatch(
          /"Node Type":"Seq Scan"[^}]*"Relation Name":"orders"/
        );
        expect(plan).not.toMatch(
          /"Actual Loops":50000|"Actual Loops":50010/
        );

        await closePool();
        await query(
          `SELECT
             pg_stat_reset_single_table_counters(
               'orders'::regclass::oid
             ),
             pg_stat_reset_single_table_counters(
               'payment_attempts'::regclass::oid
             )`
        );
        let queryCalls = 0;
        const reconciliation = await reconcileAndCloseExpiredOrders({
          provider: {
            channel: "wechat_h5",
            async createPayment() {
              throw new Error("plan probe must not create");
            },
            async queryPayment() {
              queryCalls += 1;
              return null;
            },
            async refund() {
              return { channelRefundId: "unused", raw: {} };
            }
          },
          limit: 10,
          providerQueryBudget: 10,
          providerTimeoutMs: 100
        });
        expect(queryCalls).toBe(10);
        expect(reconciliation.summary).toMatchObject({
          scannedCount: 10,
          deferredCount: 10,
          terminalCount: 0,
          hasMore: false,
          scheduledRecoveryCount: 10
        });
        await query("SELECT pg_stat_force_next_flush()");
        const stats = await query<{
          relname: string;
          seq_scan: string;
          idx_scan: string;
        }>(
          `SELECT
             relname,
             seq_scan::text,
             idx_scan::text
           FROM pg_stat_all_tables
           WHERE schemaname = 'public'
             AND relname = ANY(ARRAY['orders', 'payment_attempts'])
           ORDER BY relname`
        );
        expect(stats.rows).toEqual([
          {
            relname: "orders",
            seq_scan: "0",
            idx_scan: expect.any(String)
          },
          {
            relname: "payment_attempts",
            seq_scan: "0",
            idx_scan: expect.any(String)
          }
        ]);
        expect(
          stats.rows.every((row) => Number(row.idx_scan) > 0)
        ).toBe(true);
      } finally {
        await closePool();
        process.env.DATABASE_URL = originalDatabaseUrl;
        resetConfigForTests();
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
        const leftover = await admin.query<{ count: string }>(
          `SELECT count(*)::text AS count
             FROM pg_database
            WHERE datname = $1`,
          [databaseName]
        );
        expect(leftover.rows[0].count).toBe("0");
        await admin.end();
      }
    },
    240_000
  );

  it("queries attempted expired orders before safe close and defers errors", async () => {
    await seedPolicyFoundation();
    const userIds: string[] = [];
    try {
      const userId = await createEntitlementTestUser(true);
      userIds.push(userId);
      const adminId = await createEntitlementTestUser(true);
      userIds.push(adminId);
      await query("UPDATE users SET role = 'admin' WHERE id = $1", [adminId]);
      const admin = await query<{ email: string }>(
        "SELECT email FROM users WHERE id = $1",
        [adminId]
      );
      const adminToken = await signAccessToken({
        id: adminId,
        role: "admin",
        email: admin.rows[0].email,
        phone: null,
        displayName: null,
        status: "active"
      });
      const paid = await createFailedPaymentOrder(userId, "cleanup-paid");
      const unpaid = await createFailedPaymentOrder(userId, "cleanup-unpaid");
      const errored = await createFailedPaymentOrder(
        userId,
        "cleanup-error"
      );
      const noProvider = await createFailedPaymentOrder(
        userId,
        "cleanup-no-provider",
        "alipay_wap"
      );
      const created = await createOrder({
        userId,
        sku: "POLICY_CALC",
        channel: "main",
        idempotencyKey: `cleanup-created-${randomUUID()}`,
        businessDraftId: await insertPolicyDraft(userId)
      });
      const allIds = [
        paid.order.id,
        unpaid.order.id,
        errored.order.id,
        noProvider.order.id,
        created.id
      ];
      await query(
        `UPDATE orders
         SET created_at = now() - interval '2 minutes',
             expires_at = now() - interval '1 minute'
         WHERE id = ANY($1::uuid[])`,
        [allIds]
      );
      const queryCalls: string[] = [];
      let activeQueries = 0;
      let maxActiveQueries = 0;
      const provider = {
        channel: "wechat_h5" as const,
        async createPayment() {
          throw new Error("cleanup must not create");
        },
        async queryPayment(orderNo: string, signal: AbortSignal) {
          expect(signal.aborted).toBe(false);
          queryCalls.push(orderNo);
          activeQueries += 1;
          maxActiveQueries = Math.max(maxActiveQueries, activeQueries);
          try {
            await new Promise((resolve) => setTimeout(resolve, 20));
            if (orderNo === errored.providerOrderNo) {
              throw new Error("cleanup query secret");
            }
            if (orderNo === unpaid.providerOrderNo) return null;
            return {
              providerOrderNo: orderNo,
              channel: "wechat_h5" as const,
              channelTransactionId: `cleanup-paid-${randomUUID()}`,
              amountFen: paid.order.amountFen,
              currency: "CNY" as const,
              paidAt: new Date(Date.now() - 120_000).toISOString(),
              raw: { source: "cleanup-reconcile" }
            };
          } finally {
            activeQueries -= 1;
          }
        },
        async refund() {
          return { channelRefundId: "unused", raw: {} };
        }
      };

      const app = createApp({ paymentProvider: provider });
      const closed = await request(app)
        .post("/api/admin/commerce/close-expired")
        .set("authorization", `Bearer ${adminToken}`)
        .send({ limit: 5 })
        .expect(200);
      expect(closed.body.closedOrderIds.sort()).toEqual(
        [unpaid.order.id, created.id].sort()
      );
      expect(queryCalls.sort()).toEqual(
        [
          paid.providerOrderNo,
          unpaid.providerOrderNo,
          errored.providerOrderNo
        ].sort()
      );
      expect(maxActiveQueries).toBeGreaterThan(1);
      expect(maxActiveQueries).toBeLessThanOrEqual(10);

      const states = await query<{ id: string; status: string }>(
        `SELECT id, status
         FROM orders
         WHERE id = ANY($1::uuid[])`,
        [allIds]
      );
      expect(
        new Map(states.rows.map((row) => [row.id, row.status]))
      ).toEqual(
        new Map([
          [paid.order.id, "COMPLETED"],
          [unpaid.order.id, "CLOSED"],
          [errored.order.id, "PAYING"],
          [noProvider.order.id, "PAYING"],
          [created.id, "CLOSED"]
        ])
      );
    } finally {
      await cleanupEntitlementTestUsers(userIds);
    }
  });

  it("scans past deferred provider failures to close later safe expired orders", async () => {
    await seedPolicyFoundation();
    let userId: string | undefined;
    try {
      userId = await createEntitlementTestUser(true);
      const firstQueryError = await createFailedPaymentOrder(
        userId,
        "fair-close-query-error-first"
      );
      const secondQueryError = await createFailedPaymentOrder(
        userId,
        "fair-close-query-error-second"
      );
      const invalidVerified = await createFailedPaymentOrder(
        userId,
        "fair-close-invalid-verified"
      );
      const created = await createOrder({
        userId,
        sku: "POLICY_CALC",
        channel: "main",
        idempotencyKey: `fair-close-created-${randomUUID()}`,
        businessDraftId: await insertPolicyDraft(userId)
      });
      const unpaid = await createFailedPaymentOrder(
        userId,
        "fair-close-unpaid"
      );
      const allIds = [
        firstQueryError.order.id,
        secondQueryError.order.id,
        invalidVerified.order.id,
        created.id,
        unpaid.order.id
      ];
      await query(
        `UPDATE orders
         SET created_at = now() - interval '10 minutes',
             expires_at = now() - interval '5 minutes'
         WHERE id = ANY($1::uuid[])`,
        [allIds]
      );
      await paymentWriteQuery(
        `UPDATE payment_attempts
         SET updated_at = CASE
           WHEN id = $2 THEN now() - interval '8 minutes'
           WHEN id = $3 THEN now() - interval '7 minutes'
           WHEN id = $4 THEN now() - interval '6 minutes'
           ELSE now() - interval '5 minutes'
         END
         WHERE id = ANY($1::uuid[])`,
        [
          [
            firstQueryError.attemptId,
            secondQueryError.attemptId,
            invalidVerified.attemptId,
            unpaid.attemptId
          ],
          firstQueryError.attemptId,
          secondQueryError.attemptId,
          invalidVerified.attemptId
        ]
      );
      const queryCallsByRun: string[][] = [[], []];
      let currentRun = 0;
      const provider = {
        channel: "wechat_h5" as const,
        async createPayment() {
          throw new Error("cleanup must not create");
        },
        async queryPayment(orderNo: string, signal: AbortSignal) {
          expect(signal.aborted).toBe(false);
          queryCallsByRun[currentRun].push(orderNo);
          if (
            orderNo === firstQueryError.providerOrderNo ||
            orderNo === secondQueryError.providerOrderNo
          ) {
            throw new Error("persistent provider query failure");
          }
          if (orderNo === invalidVerified.providerOrderNo) {
            return {
              providerOrderNo: orderNo,
              channel: "wechat_h5" as const,
              channelTransactionId: `invalid-${randomUUID()}`,
              amountFen: (
                BigInt(invalidVerified.order.amountFen) + 1n
              ).toString(),
              currency: "CNY" as const,
              paidAt: new Date(Date.now() - 15 * 60_000).toISOString(),
              raw: { source: "invalid-reconciliation" }
            };
          }
          return null;
        },
        async refund() {
          return { channelRefundId: "unused", raw: {} };
        }
      };

      const firstReconciliation = await reconcileAndCloseExpiredOrders({
        provider,
        limit: 2,
        providerQueryBudget: 2,
        providerTimeoutMs: 100
      });
      currentRun = 1;
      const secondReconciliation = await reconcileAndCloseExpiredOrders({
        provider,
        limit: 2,
        providerQueryBudget: 2,
        providerTimeoutMs: 100
      });

      expect(firstReconciliation.closedOrderIds).toEqual([created.id]);
      expect(firstReconciliation.summary).toEqual({
        scannedCount: 3,
        closedCount: 1,
        providerConfirmedPaidCount: 0,
        deferredCount: 2,
        terminalCount: 0,
        hasMore: true,
        scheduledRecoveryCount: 0,
        deferredByReason: {
          providerQueryError: 2,
          paymentVerificationFailed: 0,
          closeCapacityExceeded: 0,
          unsafeOrChangedState: 0
        },
        closedRecovery: emptyClosedRecoverySummary()
      });
      expect(secondReconciliation.closedOrderIds).toEqual([
        unpaid.order.id
      ]);
      expect(secondReconciliation.summary).toEqual({
        scannedCount: 2,
        closedCount: 1,
        providerConfirmedPaidCount: 0,
        deferredCount: 0,
        terminalCount: 1,
        hasMore: true,
        scheduledRecoveryCount: 1,
        deferredByReason: {
          providerQueryError: 0,
          paymentVerificationFailed: 0,
          closeCapacityExceeded: 0,
          unsafeOrChangedState: 0
        },
        closedRecovery: emptyClosedRecoverySummary()
      });
      expect(queryCallsByRun).toEqual([
        [
          firstQueryError.providerOrderNo,
          secondQueryError.providerOrderNo
        ],
        [
          invalidVerified.providerOrderNo,
          unpaid.providerOrderNo
        ]
      ]);
      expect(queryCallsByRun.every((calls) => calls.length <= 2)).toBe(
        true
      );
      const states = await query<{
        id: string;
        status: string;
        error_code: string | null;
        transactions: string;
        entitlements: string;
      }>(
        `SELECT
           o.id,
           o.status,
           attempt.error_code,
           (SELECT count(*)::text
              FROM payment_transactions
             WHERE order_id = o.id) AS transactions,
           (SELECT count(*)::text
              FROM entitlements
             WHERE source_id = o.id) AS entitlements
         FROM orders o
         LEFT JOIN LATERAL (
           SELECT error_code
           FROM payment_attempts
           WHERE order_id = o.id
           ORDER BY created_at DESC, id DESC
           LIMIT 1
         ) attempt ON true
         WHERE o.id = ANY($1::uuid[])`,
        [allIds]
      );
      expect(new Map(states.rows.map((row) => [row.id, row]))).toEqual(
        new Map([
          [
            firstQueryError.order.id,
            {
              id: firstQueryError.order.id,
              status: "PAYING",
              error_code: "RECONCILIATION_QUERY_FAILED",
              transactions: "0",
              entitlements: "0"
            }
          ],
          [
            secondQueryError.order.id,
            {
              id: secondQueryError.order.id,
              status: "PAYING",
              error_code: "RECONCILIATION_QUERY_FAILED",
              transactions: "0",
              entitlements: "0"
            }
          ],
          [
            invalidVerified.order.id,
            {
              id: invalidVerified.order.id,
              status: "CLOSED",
              error_code: "PAYMENT_REVIEW_REQUIRED",
              transactions: "0",
              entitlements: "0"
            }
          ],
          [
            created.id,
            {
              id: created.id,
              status: "CLOSED",
              error_code: null,
              transactions: "0",
              entitlements: "0"
            }
          ],
          [
            unpaid.order.id,
            {
              id: unpaid.order.id,
              status: "CLOSED",
              error_code: null,
              transactions: "0",
              entitlements: "0"
            }
          ]
        ])
      );
    } finally {
      if (userId) await cleanupEntitlementTestUsers([userId]);
    }
  });

  it("accounts for a full-capacity callback race as changed state", async () => {
    await seedPolicyFoundation();
    let userId: string | undefined;
    try {
      userId = await createEntitlementTestUser(true);
      const noAttempt = await createOrder({
        userId,
        sku: "POLICY_CALC",
        channel: "main",
        idempotencyKey: `capacity-race-no-attempt-${randomUUID()}`,
        businessDraftId: await insertPolicyDraft(userId)
      });
      const open = await createFailedPaymentOrder(
        userId,
        "capacity-race-open"
      );
      await query(
        `UPDATE orders
         SET created_at = now() - interval '3 minutes',
             expires_at = now() - interval '1 minute'
         WHERE id = ANY($1::uuid[])`,
        [[noAttempt.id, open.order.id]]
      );
      const verified = {
        providerOrderNo: open.providerOrderNo,
        channel: "wechat_h5" as const,
        channelTransactionId: `capacity-race-${randomUUID()}`,
        amountFen: open.order.amountFen,
        currency: "CNY" as const,
        paidAt: new Date(Date.now() - 2 * 60_000).toISOString(),
        raw: { source: "capacity-race-open" }
      };
      let releaseProvider!: () => void;
      const providerReleased = new Promise<void>((resolve) => {
        releaseProvider = resolve;
      });
      let reportProviderQuery!: () => void;
      const providerQueried = new Promise<void>((resolve) => {
        reportProviderQuery = resolve;
      });
      const provider = {
        channel: "wechat_h5" as const,
        async createPayment() {
          throw new Error("must not create");
        },
        async queryPayment() {
          reportProviderQuery();
          await providerReleased;
          return null;
        },
        async refund() {
          return { channelRefundId: "unused", raw: {} };
        }
      };
      const worker = reconcileAndCloseExpiredOrders({
        provider,
        limit: 1,
        providerQueryBudget: 1,
        providerTimeoutMs: 1_000
      });
      await providerQueried;
      await markOrderPaid({
        orderId: open.order.id,
        paymentAttemptId: open.attemptId,
        verified
      });
      releaseProvider();
      const result = await worker;
      expect(result.closedOrderIds).toEqual([noAttempt.id]);
      expect(result.summary).toMatchObject({
        scannedCount: 2,
        closedCount: 1,
        providerConfirmedPaidCount: 0,
        deferredCount: 1,
        terminalCount: 0,
        hasMore: false,
        scheduledRecoveryCount: 0,
        deferredByReason: {
          closeCapacityExceeded: 0,
          unsafeOrChangedState: 1
        }
      });
      expect(result.summary.scannedCount).toBe(
        result.summary.closedCount +
          result.summary.providerConfirmedPaidCount +
          result.summary.deferredCount +
          result.summary.terminalCount
      );
      const persisted = await query<{
        id: string;
        status: string;
      }>(
        `SELECT id, status
         FROM orders
         WHERE id = ANY($1::uuid[])
         ORDER BY id`,
        [[noAttempt.id, open.order.id]]
      );
      expect(
        new Map(
          persisted.rows.map((order) => [order.id, order.status])
        )
      ).toEqual(
        new Map([
          [noAttempt.id, "CLOSED"],
          [open.order.id, "COMPLETED"]
        ])
      );
    } finally {
      if (userId) await cleanupEntitlementTestUsers([userId]);
    }
  });

  it("accounts for and rotates provider-null outcomes beyond close capacity", async () => {
    await seedPolicyFoundation();
    let userId: string | undefined;
    try {
      userId = await createEntitlementTestUser(true);
      const candidates = await Promise.all([
        createFailedPaymentOrder(userId, "capacity-null-first"),
        createFailedPaymentOrder(userId, "capacity-null-second"),
        createFailedPaymentOrder(userId, "capacity-null-third")
      ]);
      const orderIds = candidates.map((candidate) => candidate.order.id);
      const attemptIds = candidates.map((candidate) => candidate.attemptId);
      await query(
        `UPDATE orders
         SET created_at = now() - interval '10 minutes',
             expires_at = now() - interval '5 minutes'
         WHERE id = ANY($1::uuid[])`,
        [orderIds]
      );
      await paymentWriteQuery(
        `UPDATE payment_attempts
         SET updated_at = CASE
           WHEN id = $2 THEN now() - interval '8 minutes'
           WHEN id = $3 THEN now() - interval '7 minutes'
           ELSE now() - interval '6 minutes'
         END
         WHERE id = ANY($1::uuid[])`,
        [attemptIds, attemptIds[0], attemptIds[1]]
      );
      const queryCallsByRun: string[][] = [[], [], []];
      let currentRun = 0;
      const provider = {
        channel: "wechat_h5" as const,
        async createPayment() {
          throw new Error("cleanup must not create");
        },
        async queryPayment(orderNo: string, signal: AbortSignal) {
          expect(signal.aborted).toBe(false);
          queryCallsByRun[currentRun].push(orderNo);
          await new Promise((resolve) => setTimeout(resolve, 5));
          return null;
        },
        async refund() {
          return { channelRefundId: "unused", raw: {} };
        }
      };
      const reconciliations = [];
      for (currentRun = 0; currentRun < 3; currentRun += 1) {
        reconciliations.push(
          await reconcileAndCloseExpiredOrders({
            provider,
            limit: 1,
            providerQueryBudget: 3,
            providerTimeoutMs: 100
          })
        );
      }

      expect(queryCallsByRun.map((calls) => calls.length)).toEqual([
        3, 2, 1
      ]);
      expect(
        queryCallsByRun.every((calls) => calls.length <= 3)
      ).toBe(true);
      expect(reconciliations.map((result) => result.summary)).toEqual([
        {
          scannedCount: 3,
          closedCount: 1,
          providerConfirmedPaidCount: 0,
          deferredCount: 2,
          terminalCount: 0,
          hasMore: true,
          scheduledRecoveryCount: 1,
          deferredByReason: {
            providerQueryError: 0,
            paymentVerificationFailed: 0,
            closeCapacityExceeded: 2,
            unsafeOrChangedState: 0
          },
          closedRecovery: emptyClosedRecoverySummary()
        },
        {
          scannedCount: 2,
          closedCount: 1,
          providerConfirmedPaidCount: 0,
          deferredCount: 1,
          terminalCount: 0,
          hasMore: true,
          scheduledRecoveryCount: 2,
          deferredByReason: {
            providerQueryError: 0,
            paymentVerificationFailed: 0,
            closeCapacityExceeded: 1,
            unsafeOrChangedState: 0
          },
          closedRecovery: emptyClosedRecoverySummary()
        },
        {
          scannedCount: 1,
          closedCount: 1,
          providerConfirmedPaidCount: 0,
          deferredCount: 0,
          terminalCount: 0,
          hasMore: false,
          scheduledRecoveryCount: 3,
          deferredByReason: {
            providerQueryError: 0,
            paymentVerificationFailed: 0,
            closeCapacityExceeded: 0,
            unsafeOrChangedState: 0
          },
          closedRecovery: emptyClosedRecoverySummary()
        }
      ]);
      for (const reconciliation of reconciliations) {
        const summary = reconciliation.summary;
        expect(summary.scannedCount).toBe(
          summary.closedCount +
            summary.providerConfirmedPaidCount +
            summary.deferredCount +
            summary.terminalCount
        );
      }
      expect(
        reconciliations.flatMap((result) => result.closedOrderIds).sort()
      ).toEqual([...orderIds].sort());
      const persisted = await query<{
        id: string;
        status: string;
        error_code: string | null;
      }>(
        `SELECT o.id, o.status, attempt.error_code
         FROM orders o
         JOIN LATERAL (
           SELECT error_code
           FROM payment_attempts
           WHERE order_id = o.id
           ORDER BY created_at DESC, id DESC
           LIMIT 1
         ) attempt ON true
         WHERE o.id = ANY($1::uuid[])`,
        [orderIds]
      );
      expect(persisted.rows.every((row) => row.status === "CLOSED")).toBe(
        true
      );
      expect(
        persisted.rows.filter(
          (row) =>
            row.error_code ===
            "RECONCILIATION_CLOSE_CAPACITY_EXCEEDED"
        )
      ).toHaveLength(2);
    } finally {
      if (userId) await cleanupEntitlementTestUsers([userId]);
    }
  });

  it("recovers provider-confirmed payment while no-attempt close capacity is full", async () => {
    await seedPolicyFoundation();
    let userId: string | undefined;
    try {
      userId = await createEntitlementTestUser(true);
      const firstCreated = await createOrder({
        userId,
        sku: "POLICY_CALC",
        channel: "main",
        idempotencyKey: `paid-backlog-first-${randomUUID()}`,
        businessDraftId: await insertPolicyDraft(userId)
      });
      const secondCreated = await createOrder({
        userId,
        sku: "POLICY_CALC",
        channel: "main",
        idempotencyKey: `paid-backlog-second-${randomUUID()}`,
        businessDraftId: await insertPolicyDraft(userId)
      });
      const paid = await createFailedPaymentOrder(
        userId,
        "paid-backlog-provider"
      );
      await query(
        `UPDATE orders
         SET created_at = now() - interval '10 minutes',
             expires_at = CASE
               WHEN id = $2 THEN now() - interval '8 minutes'
               WHEN id = $3 THEN now() - interval '7 minutes'
               ELSE now() - interval '5 minutes'
             END
         WHERE id = ANY($1::uuid[])`,
        [
          [firstCreated.id, secondCreated.id, paid.order.id],
          firstCreated.id,
          secondCreated.id
        ]
      );
      const queryCalls: string[] = [];
      const provider = {
        channel: "wechat_h5" as const,
        async createPayment() {
          throw new Error("cleanup must not create");
        },
        async queryPayment(orderNo: string, signal: AbortSignal) {
          expect(signal.aborted).toBe(false);
          queryCalls.push(orderNo);
          return {
            providerOrderNo: orderNo,
            channel: "wechat_h5" as const,
            channelTransactionId: `paid-backlog-${randomUUID()}`,
            amountFen: paid.order.amountFen,
            currency: "CNY" as const,
            paidAt: new Date(Date.now() - 7 * 60_000).toISOString(),
            raw: { source: "paid-backlog-reconciliation" }
          };
        },
        async refund() {
          return { channelRefundId: "unused", raw: {} };
        }
      };

      const reconciliation = await reconcileAndCloseExpiredOrders({
        provider,
        limit: 1,
        providerQueryBudget: 1,
        providerTimeoutMs: 100
      });

      expect(queryCalls).toEqual([paid.providerOrderNo]);
      expect(reconciliation.closedOrderIds).toEqual([firstCreated.id]);
      expect(reconciliation.summary).toEqual({
        scannedCount: 2,
        closedCount: 1,
        providerConfirmedPaidCount: 1,
        deferredCount: 0,
        terminalCount: 0,
        hasMore: true,
        scheduledRecoveryCount: 0,
        deferredByReason: {
          providerQueryError: 0,
          paymentVerificationFailed: 0,
          closeCapacityExceeded: 0,
          unsafeOrChangedState: 0
        },
        closedRecovery: emptyClosedRecoverySummary()
      });
      const states = await query<{
        id: string;
        status: string;
        transactions: string;
        entitlements: string;
      }>(
        `SELECT
           o.id,
           o.status,
           (SELECT count(*)::text
              FROM payment_transactions
             WHERE order_id = o.id) AS transactions,
           (SELECT count(*)::text
              FROM entitlements
             WHERE source_id = o.id) AS entitlements
         FROM orders o
         WHERE o.id = ANY($1::uuid[])`,
        [[firstCreated.id, secondCreated.id, paid.order.id]]
      );
      expect(new Map(states.rows.map((row) => [row.id, row]))).toEqual(
        new Map([
          [
            firstCreated.id,
            {
              id: firstCreated.id,
              status: "CLOSED",
              transactions: "0",
              entitlements: "0"
            }
          ],
          [
            secondCreated.id,
            {
              id: secondCreated.id,
              status: "CREATED",
              transactions: "0",
              entitlements: "0"
            }
          ],
          [
            paid.order.id,
            {
              id: paid.order.id,
              status: "COMPLETED",
              transactions: "1",
              entitlements: "1"
            }
          ]
        ])
      );
    } finally {
      if (userId) await cleanupEntitlementTestUsers([userId]);
    }
  });

  it("closes expired attempts while preserving a completed paid order", async () => {
    await seedPolicyFoundation();
    let userId: string | undefined;
    try {
      userId = await createEntitlementTestUser(true);
      const makeOrderWithAttempt = async (
        marker: string,
        origin: "attempt_v1" | "legacy_order_no" = "attempt_v1"
      ) => {
        const order = await createOrder({
          userId: userId!,
          sku: "POLICY_CALC",
          channel: "main",
          idempotencyKey: `${marker}-${randomUUID()}`,
          businessDraftId: await insertPolicyDraft(userId!)
        });
        const attempt = await insertIdentityAwarePaymentAttempt({
          orderId: order.id,
          channel: "wechat_h5",
          status: "REDIRECT_READY",
          origin,
          launchUrl: "/pending",
          launchExpiresAt: new Date(Date.now() + 5 * 60_000)
        });
        return {
          order,
          attemptId: attempt.id,
          providerOrderNo: attempt.providerOrderNo
        };
      };
      const paid = await makeOrderWithAttempt("paid-expiry");
      const pending = await makeOrderWithAttempt("pending-expiry");
      const failed = await makeOrderWithAttempt(
        "failed-expiry",
        "legacy_order_no"
      );
      await markOrderPaid({
        orderId: paid.order.id,
        paymentAttemptId: paid.attemptId,
        verified: {
          providerOrderNo: paid.providerOrderNo,
          channel: "wechat_h5",
          channelTransactionId: `paid-expiry-${randomUUID()}`,
          amountFen: paid.order.amountFen,
          currency: "CNY",
          paidAt: new Date().toISOString(),
          raw: { source: "paid-expiry" }
        }
      });
      await query(
        `UPDATE orders
            SET created_at = now() - interval '2 seconds',
                expires_at = now() - interval '1 second',
                status = CASE
                  WHEN id = $2 THEN 'PAYING'
                  WHEN id = $3 THEN 'PAYMENT_FAILED'
                  ELSE status
                END
          WHERE id = ANY($1::uuid[])`,
        [
          [paid.order.id, pending.order.id, failed.order.id],
          pending.order.id,
          failed.order.id
        ]
      );
      await paymentWriteQuery(
        "UPDATE payment_attempts SET status = 'FAILED' WHERE id = $1",
        [failed.attemptId]
      );

      await expect(closeExpiredOrders(0)).rejects.toMatchObject({
        code: "INVALID_COMMERCE_INPUT"
      });
      await expect(closeExpiredOrders(501)).rejects.toMatchObject({
        code: "INVALID_COMMERCE_INPUT"
      });
      const cleanupProvider = {
        channel: "wechat_h5" as const,
        async createPayment() {
          throw new Error("cleanup must not create");
        },
        async queryPayment() {
          return null;
        },
        async refund() {
          return { channelRefundId: "unused", raw: {} };
        }
      };
      const closeBatch = () =>
        reconcileAndCloseExpiredOrders({
          provider: cleanupProvider,
          limit: 1,
          providerTimeoutMs: 100
        });
      const firstBatch = await closeBatch();
      const secondBatch = await closeBatch();
      expect(
        [
          ...firstBatch.closedOrderIds,
          ...secondBatch.closedOrderIds
        ].sort()
      ).toEqual(
        [pending.order.id, failed.order.id].sort()
      );
      const states = await query<{
        id: string;
        order_status: string;
        attempt_status: string;
      }>(
        `SELECT
           o.id,
           o.status AS order_status,
           pa.status AS attempt_status
         FROM orders o
         JOIN payment_attempts pa ON pa.order_id = o.id
         WHERE o.id = ANY($1::uuid[])
         ORDER BY o.id`,
        [[paid.order.id, pending.order.id, failed.order.id]]
      );
      expect(
        new Map(states.rows.map((row) => [row.id, row]))
      ).toEqual(
        new Map([
          [
            paid.order.id,
            {
              id: paid.order.id,
              order_status: "COMPLETED",
              attempt_status: "SUCCEEDED"
            }
          ],
          [
            pending.order.id,
            {
              id: pending.order.id,
              order_status: "CLOSED",
              attempt_status: "CLOSED"
            }
          ],
          [
            failed.order.id,
            {
              id: failed.order.id,
              order_status: "CLOSED",
              attempt_status: "CLOSED"
            }
          ]
        ])
      );
    } finally {
      if (userId) await cleanupEntitlementTestUsers([userId]);
    }
  });

  it("refuses to boot production with the fake payment mode", () => {
    const previousEnvironment = process.env.NODE_ENV;
    const previousPaymentMode = process.env.PAYMENT_MODE;
    try {
      process.env.NODE_ENV = "production";
      process.env.PAYMENT_MODE = "fake";
      resetConfigForTests();
      expect(() => createApp()).toThrow(/PAYMENT_MODE=fake/);
    } finally {
      process.env.NODE_ENV = previousEnvironment;
      if (previousPaymentMode === undefined) {
        delete process.env.PAYMENT_MODE;
      } else {
        process.env.PAYMENT_MODE = previousPaymentMode;
      }
      resetConfigForTests();
    }
  });

  it("uses the matching main and AI site origins for payment returns", async () => {
    await seedPolicyFoundation();
    const previousOrigin = process.env.APP_ORIGIN;
    const previousMainOrigin = process.env.MAIN_APP_ORIGIN;
    const previousAiOrigin = process.env.AI_APP_ORIGIN;
    const userIds: string[] = [];
    try {
      process.env.APP_ORIGIN =
        "https://peileme.art,https://ai.peileme.art";
      process.env.MAIN_APP_ORIGIN = "https://peileme.art";
      process.env.AI_APP_ORIGIN = "https://ai.peileme.art";
      resetConfigForTests();
      const userId = await createEntitlementTestUser(true);
      userIds.push(userId);
      const user = await query<{ email: string }>(
        "SELECT email FROM users WHERE id = $1",
        [userId]
      );
      const token = await signAccessToken({
        id: userId,
        role: "user",
        email: user.rows[0].email,
        phone: null,
        displayName: null,
        status: "active"
      });
      const orders = await Promise.all([
        createOrder({
          userId,
          sku: "POLICY_CALC",
          channel: "main",
          idempotencyKey: `return-main-${randomUUID()}`,
          businessDraftId: await insertPolicyDraft(userId, "main")
        }),
        createOrder({
          userId,
          sku: "AI_DOCUMENT_REVIEW",
          channel: "ai",
          idempotencyKey: `return-ai-${randomUUID()}`,
          businessDraftId: await insertPolicyDraft(userId, "ai")
        })
      ]);
      const seen = new Map<string, string>();
      const provider = {
        channel: "wechat_h5" as const,
        async createPayment(input: {
          attemptId: string;
          orderNo: string;
          returnUrl: string;
        }) {
          seen.set(input.orderNo, input.returnUrl);
          return {
            prepayId: input.attemptId,
            launchUrl: `/return/${input.orderNo}`,
            response: {}
          };
        },
        async queryPayment() {
          return null;
        },
        async refund() {
          return { channelRefundId: "unused", raw: {} };
        }
      };
      const app = createApp({ paymentProvider: provider });
      for (const order of orders) {
        await request(app)
          .post(`/api/commerce/orders/${order.id}/pay`)
          .set(
            "host",
            order.channel === "main"
              ? "peileme.art"
              : "ai.peileme.art"
          )
          .set("authorization", `Bearer ${token}`)
          .send({ channel: "wechat_h5" })
          .expect(200);
      }
      expect(seen.get(orders[0].orderNo)).toBe(
        `https://peileme.art/orders/${orders[0].id}`
      );
      expect(seen.get(orders[1].orderNo)).toBe(
        `https://ai.peileme.art/orders/${orders[1].id}`
      );
      expect(seen.size).toBe(2);
    } finally {
      await cleanupEntitlementTestUsers(userIds);
      if (previousOrigin === undefined) {
        delete process.env.APP_ORIGIN;
      } else {
        process.env.APP_ORIGIN = previousOrigin;
      }
      if (previousMainOrigin === undefined) {
        delete process.env.MAIN_APP_ORIGIN;
      } else {
        process.env.MAIN_APP_ORIGIN = previousMainOrigin;
      }
      if (previousAiOrigin === undefined) {
        delete process.env.AI_APP_ORIGIN;
      } else {
        process.env.AI_APP_ORIGIN = previousAiOrigin;
      }
      resetConfigForTests();
    }
  });

  it("runs an owned real-channel checkout through HTTP and persisted fulfillment", async () => {
    await seedPolicyFoundation();
    const userIds: string[] = [];
    try {
      const userId = await createEntitlementTestUser(true);
      userIds.push(userId);
      const otherUserId = await createEntitlementTestUser(true);
      userIds.push(otherUserId);
      const tokenFor = async (id: string) => {
        const user = await query<{
          email: string;
          status: "active" | "disabled";
        }>("SELECT email, status FROM users WHERE id = $1", [id]);
        return signAccessToken({
          id,
          role: "user",
          email: user.rows[0].email,
          phone: null,
          displayName: null,
          status: user.rows[0].status
        });
      };
      const token = await tokenFor(userId);
      const otherToken = await tokenFor(otherUserId);
      const businessDraftId = await insertPolicyDraft(userId);
      const provider = new ScriptedRealPaymentProvider("wechat_h5");
      const app = createApp({ paymentProvider: provider });

      const mainCatalog = await request(app)
        .get("/api/commerce/catalog?channel=main")
        .expect(200);
      expect(mainCatalog.body.items.map((item: { sku: string }) => item.sku))
        .toEqual(["POLICY_CALC"]);
      expect(
        mainCatalog.body.items.some(
          (item: { sku: string }) => item.sku === "AI_DOCUMENT_REVIEW"
        )
      ).toBe(false);

      await request(app)
        .post("/api/commerce/orders")
        .send({
          sku: "POLICY_CALC",
          channel: "main",
          idempotencyKey: "anonymous"
        })
        .expect(401);
      const order = await request(app)
        .post("/api/commerce/orders")
        .set("authorization", `Bearer ${token}`)
        .send({
          sku: "POLICY_CALC",
          channel: "main",
          idempotencyKey: `http-${randomUUID()}`,
          businessDraftId
        })
        .expect(201);
      expect(order.body).toMatchObject({
        amountFen: "990",
        channel: "main",
        sku: "POLICY_CALC",
        status: "CREATED"
      });
      await request(app)
        .get(`/api/commerce/orders/${order.body.id}`)
        .set("authorization", `Bearer ${otherToken}`)
        .expect(404);
      await request(app)
        .post(`/api/commerce/orders/${order.body.id}/invoice`)
        .set("authorization", `Bearer ${token}`)
        .send({
          title: "测试个人",
          email: "invoice@peileme.test"
        })
        .expect(409);
      await request(app)
        .post(`/api/commerce/orders/${order.body.id}/invoice`)
        .set("authorization", `Bearer ${otherToken}`)
        .send({
          title: "越权申请",
          email: "other-invoice@peileme.test"
        })
        .expect(404);

      const firstPay = await request(app)
        .post(`/api/commerce/orders/${order.body.id}/pay`)
        .set("authorization", `Bearer ${token}`)
        .send({ channel: "wechat_h5" })
        .expect(200);
      const repeatedPay = await request(app)
        .post(`/api/commerce/orders/${order.body.id}/pay`)
        .set("authorization", `Bearer ${token}`)
        .send({ channel: "wechat_h5" })
        .expect(200);
      expect(repeatedPay.body.launchUrl).toBe(firstPay.body.launchUrl);
      expect(new URL(firstPay.body.launchUrl).hostname).toBe("payments.test");
      expect(provider.createInputs).toHaveLength(1);
      const attempt = await query<{
        id: string;
        provider_order_no: string;
      }>(
        `SELECT pa.id, identity.provider_order_no
         FROM payment_attempts pa
         JOIN provider_payment_orders identity
           ON identity.id = pa.provider_payment_order_id
         WHERE pa.order_id = $1
           AND pa.provider_identity_role = 'canonical_owner'`,
        [order.body.id]
      );
      expect(attempt.rows).toHaveLength(1);
      await request(app)
        .post(`/api/test-payments/${attempt.rows[0].id}/complete`)
        .send({})
        .expect(404);
      await query(
        `UPDATE order_items
         SET entitlement_policy = '{"grantCount":"invalid"}'::jsonb
         WHERE order_id = $1`,
        [order.body.id]
      );
      const verified = {
        providerOrderNo: attempt.rows[0].provider_order_no,
        channel: "wechat_h5" as const,
        channelTransactionId: `http-real-${randomUUID()}`,
        amountFen: order.body.amountFen,
        currency: "CNY" as const,
        paidAt: new Date().toISOString(),
        raw: { source: "scripted-real-provider" }
      };
      await expect(
        markOrderPaid({
          orderId: order.body.id,
          paymentAttemptId: attempt.rows[0].id,
          verified
        })
      ).rejects.toMatchObject({ code: "INVALID_ENTITLEMENT_POLICY" });
      const afterFailedSettlement = await query<{
        transactions: string;
        entitlements: string;
      }>(
        `SELECT
           (SELECT count(*)::text FROM payment_transactions WHERE order_id = $1)
             AS transactions,
           (SELECT count(*)::text FROM entitlements WHERE source_id = $1)
             AS entitlements`,
        [order.body.id]
      );
      expect(afterFailedSettlement.rows[0]).toEqual({
        transactions: "0",
        entitlements: "0"
      });
      await query(
        `UPDATE order_items
         SET entitlement_policy = '{"grantCount":1}'::jsonb
         WHERE order_id = $1`,
        [order.body.id]
      );
      const concurrentCompletions = await Promise.allSettled([
        markOrderPaid({
          orderId: order.body.id,
          paymentAttemptId: attempt.rows[0].id,
          verified
        }),
        markOrderPaid({
          orderId: order.body.id,
          paymentAttemptId: attempt.rows[0].id,
          verified
        })
      ]);
      expect(
        concurrentCompletions.every(
          (item) =>
            item.status === "fulfilled" && item.value.status === "COMPLETED"
        )
      ).toBe(true);

      const invoice = await request(app)
        .post(`/api/commerce/orders/${order.body.id}/invoice`)
        .set("authorization", `Bearer ${token}`)
        .send({
          title: "测试个人",
          email: "invoice@peileme.test"
        })
        .expect(201);
      const repeatedInvoice = await request(app)
        .post(`/api/commerce/orders/${order.body.id}/invoice`)
        .set("authorization", `Bearer ${token}`)
        .send({
          title: "测试个人",
          email: "invoice@peileme.test"
        })
        .expect(201);
      expect(repeatedInvoice.body.id).toBe(invoice.body.id);
      await request(app)
        .post(`/api/commerce/orders/${order.body.id}/invoice`)
        .set("authorization", `Bearer ${token}`)
        .send({
          title: "变更后的抬头",
          email: "invoice@peileme.test"
        })
        .expect(409);

      const persisted = await query<{
        attempts: string;
        transactions: string;
        entitlements: string;
        invoices: string;
      }>(
        `SELECT
           (SELECT count(*)::text FROM payment_attempts WHERE order_id = $1)
             AS attempts,
           (SELECT count(*)::text FROM payment_transactions WHERE order_id = $1)
             AS transactions,
           (SELECT count(*)::text FROM entitlements WHERE source_id = $1)
             AS entitlements,
           (SELECT count(*)::text FROM invoice_requests WHERE order_id = $1)
             AS invoices`,
        [order.body.id]
      );
      expect(persisted.rows[0]).toEqual({
        attempts: "1",
        transactions: "1",
        entitlements: "1",
        invoices: "1"
      });
    } finally {
      await cleanupEntitlementTestUsers(userIds);
    }
  });

  it("mounts a minimal authenticated admin commerce status endpoint", async () => {
    await seedPolicyFoundation();
    const userIds: string[] = [];
    let auditFailureInstalled = false;
    try {
      const userId = await createEntitlementTestUser(true);
      userIds.push(userId);
      const analystId = await createEntitlementTestUser(true);
      userIds.push(analystId);
      await query("UPDATE users SET role = 'analyst' WHERE id = $1", [
        analystId
      ]);
      const adminId = await createEntitlementTestUser(true);
      userIds.push(adminId);
      await query("UPDATE users SET role = 'admin' WHERE id = $1", [adminId]);
      const tokenFor = async (
        id: string,
        role: "user" | "admin" | "analyst"
      ) => {
        const user = await query<{ email: string }>(
          "SELECT email FROM users WHERE id = $1",
          [id]
        );
        return signAccessToken({
          id,
          role,
          email: user.rows[0].email,
          phone: null,
          displayName: null,
          status: "active"
        });
      };
      const app = createApp();
      await request(app)
        .get("/api/admin/commerce/status")
        .set("authorization", `Bearer ${await tokenFor(userId, "user")}`)
        .expect(403);
      const admin = await request(app)
        .get("/api/admin/commerce/status")
        .set("authorization", `Bearer ${await tokenFor(adminId, "admin")}`)
        .expect(200);
      expect(admin.body).toMatchObject({ paymentMode: "disabled" });
      expect(admin.body.counts).toEqual({
        openOrders: expect.stringMatching(/^\d+$/),
        pendingAttempts: expect.stringMatching(/^\d+$/),
        pendingPaymentAnomalies: expect.stringMatching(/^\d+$/)
      });

      const expiredOrder = await createOrder({
        userId,
        sku: "POLICY_CALC",
        channel: "main",
        idempotencyKey: `admin-close-expired-${randomUUID()}`,
        businessDraftId: await insertPolicyDraft(userId)
      });
      await query(
        `UPDATE orders
         SET created_at = now() - interval '2 seconds',
             expires_at = now() - interval '1 second'
         WHERE id = $1`,
        [expiredOrder.id]
      );
      await request(app)
        .post("/api/admin/commerce/close-expired")
        .set("authorization", `Bearer ${await tokenFor(userId, "user")}`)
        .send({ limit: 1 })
        .expect(403);
      await request(app)
        .post("/api/admin/commerce/close-expired")
        .set(
          "authorization",
          `Bearer ${await tokenFor(analystId, "analyst")}`
        )
        .send({ limit: 1 })
        .expect(403);
      const closed = await request(app)
        .post("/api/admin/commerce/close-expired")
        .set("authorization", `Bearer ${await tokenFor(adminId, "admin")}`)
        .send({ limit: 1 })
        .expect(200);
      expect(closed.body).toEqual({
        closedCount: 1,
        closedOrderIds: [expiredOrder.id],
        reconciliation: {
          scannedCount: 1,
          closedCount: 1,
          providerConfirmedPaidCount: 0,
          deferredCount: 0,
          terminalCount: 0,
          hasMore: false,
          scheduledRecoveryCount: 0,
          deferredByReason: {
            providerQueryError: 0,
            paymentVerificationFailed: 0,
            closeCapacityExceeded: 0,
            unsafeOrChangedState: 0
          },
          closedRecovery: emptyClosedRecoverySummary()
        }
      });
      const audit = await query<{
        action: string;
        detail: {
          limit: number;
          closedCount: number;
          closedOrderIds: string[];
          reconciliation: Record<string, unknown>;
        };
      }>(
        `SELECT action, detail
         FROM admin_audit_logs
         WHERE admin_user_id = $1
           AND action = 'commerce.orders.close_expired'`,
        [adminId]
      );
      expect(audit.rows).toEqual([
        {
          action: "commerce.orders.close_expired",
          detail: {
            limit: 1,
            closedCount: 1,
            closedOrderIds: [expiredOrder.id],
            reconciliation: {
              scannedCount: 1,
              closedCount: 1,
              providerConfirmedPaidCount: 0,
              deferredCount: 0,
              terminalCount: 0,
              hasMore: false,
              scheduledRecoveryCount: 0,
              deferredByReason: {
                providerQueryError: 0,
                paymentVerificationFailed: 0,
                closeCapacityExceeded: 0,
                unsafeOrChangedState: 0
              },
              closedRecovery: emptyClosedRecoverySummary()
            }
          }
        }
      ]);

      const rollbackOrder = await createOrder({
        userId,
        sku: "POLICY_CALC",
        channel: "main",
        idempotencyKey: `admin-close-audit-rollback-${randomUUID()}`,
        businessDraftId: await insertPolicyDraft(userId)
      });
      await query(
        `UPDATE orders
         SET created_at = now() - interval '2 seconds',
             expires_at = now() - interval '1 second'
         WHERE id = $1`,
        [rollbackOrder.id]
      );
      await query(`
        CREATE OR REPLACE FUNCTION fail_commerce_close_audit_for_test()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        BEGIN
          IF NEW.action = 'commerce.orders.close_expired' THEN
            RAISE EXCEPTION 'forced commerce close audit failure';
          END IF;
          RETURN NEW;
        END
        $$
      `);
      await query(`
        CREATE TRIGGER fail_commerce_close_audit_for_test_trigger
        BEFORE INSERT ON admin_audit_logs
        FOR EACH ROW
        EXECUTE FUNCTION fail_commerce_close_audit_for_test()
      `);
      auditFailureInstalled = true;
      await request(app)
        .post("/api/admin/commerce/close-expired")
        .set("authorization", `Bearer ${await tokenFor(adminId, "admin")}`)
        .send({ limit: 1 })
        .expect(500);
      const rolledBack = await query<{
        status: string;
        closed_at: Date | null;
        audits: string;
      }>(
        `SELECT
           status,
           closed_at,
           (
             SELECT count(*)::text
             FROM admin_audit_logs
             WHERE admin_user_id = $2
               AND action = 'commerce.orders.close_expired'
           ) AS audits
         FROM orders
         WHERE id = $1`,
        [rollbackOrder.id, adminId]
      );
      expect(rolledBack.rows[0]).toEqual({
        status: "CREATED",
        closed_at: null,
        audits: "1"
      });
    } finally {
      if (auditFailureInstalled) {
        await query(
          "DROP TRIGGER IF EXISTS fail_commerce_close_audit_for_test_trigger ON admin_audit_logs"
        );
      }
      await query(
        "DROP FUNCTION IF EXISTS fail_commerce_close_audit_for_test()"
      );
      await cleanupEntitlementTestUsers(userIds);
    }
  });
});
