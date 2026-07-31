import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { createApp } from "../app.js";
import { resetConfigForTests } from "../config.js";
import { closePool, getPool, query } from "../db.js";
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
  createOrder,
  fulfillOrder,
  listOwnedOrders,
  markOrderPaid,
  reconcileAndCloseExpiredOrders,
  startPayment
} from "../modules/commerce/orders.js";
import { seedPolicyFoundation } from "../modules/policy/seed.js";
import { signAccessToken } from "../security.js";

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
  marker: string
) => {
  const order = await createOrder({
    userId,
    sku: "POLICY_CALC",
    channel: "main",
    idempotencyKey: `${marker}-${randomUUID()}`,
    businessDraftId: await insertPolicyDraft(userId)
  });
  const attempt = await query<{ id: string }>(
    `INSERT INTO payment_attempts(order_id, channel, status)
     VALUES ($1, 'fake', 'FAILED')
     RETURNING id`,
    [order.id]
  );
  await query(
    "UPDATE orders SET status = 'PAYMENT_FAILED' WHERE id = $1",
    [order.id]
  );
  return { order, attemptId: attempt.rows[0].id };
};

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
      const attempt = await query<{ id: string }>(
        `INSERT INTO payment_attempts(order_id, channel, status)
         VALUES ($1, 'fake', 'CREATED')
         RETURNING id`,
        [orderA]
      );
      attemptId = attempt.rows[0].id;
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
           VALUES ($1, $2, 'fake', $3, 990, 'CNY', 'SUCCESS', '{}')`,
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
      if (attemptId) {
        await query("DELETE FROM payment_attempts WHERE id = $1", [attemptId]);
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
      const attempt = await query<{ id: string }>(
        `INSERT INTO payment_attempts(order_id, channel, status)
         VALUES ($1, 'alipay_wap', 'CREATED')
         RETURNING id`,
        [orderId]
      );
      attemptId = attempt.rows[0].id;

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
      if (attemptId) {
        await query("DELETE FROM payment_attempts WHERE id = $1", [attemptId]);
      }
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
        "SELECT id FROM orders WHERE user_id = $1 ORDER BY created_at DESC, id DESC",
        [userId]
      );
      const [pageOne, pageTwo] = await Promise.all([
        listOwnedOrders(userId, 1, 2),
        listOwnedOrders(userId, 2, 2)
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

  it("fulfills a verified payment once and rolls back a mismatch", async () => {
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
      const attempt = await query<{ id: string }>(
        `INSERT INTO payment_attempts(order_id, channel, status)
         VALUES ($1, 'fake', 'PENDING')
         RETURNING id`,
        [order.id]
      );
      const verified = {
        orderNo: order.orderNo,
        channel: "fake" as const,
        channelTransactionId: `fake-${randomUUID()}`,
        amountFen: order.amountFen,
        currency: "CNY" as const,
        paidAt: new Date().toISOString(),
        raw: { source: "task3-red" }
      };

      await expect(
        markOrderPaid({
          orderId: order.id,
          paymentAttemptId: attempt.rows[0].id,
          verified: { ...verified, amountFen: "991" }
        })
      ).rejects.toMatchObject({
        code: "PAYMENT_VERIFICATION_FAILED"
      });
      const afterMismatch = await query<{
        transactions: string;
        entitlements: string;
        status: string;
      }>(
        `SELECT
           (SELECT count(*)::text FROM payment_transactions WHERE order_id = $1)
             AS transactions,
           (SELECT count(*)::text FROM entitlements WHERE source_id = $1)
             AS entitlements,
           (SELECT status FROM orders WHERE id = $1) AS status`,
        [order.id]
      );
      expect(afterMismatch.rows[0]).toEqual({
        transactions: "0",
        entitlements: "0",
        status: "CREATED"
      });

      const completed = await markOrderPaid({
        orderId: order.id,
        paymentAttemptId: attempt.rows[0].id,
        verified
      });
      await expect(
        markOrderPaid({
          orderId: order.id,
          paymentAttemptId: attempt.rows[0].id,
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
        [order.id, attempt.rows[0].id]
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

  it("rejects provider payments made after expiry without persisting settlement", async () => {
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
      const attempt = await query<{ id: string }>(
        `INSERT INTO payment_attempts(order_id, channel, status)
         VALUES ($1, 'fake', 'PENDING')
         RETURNING id`,
        [order.id]
      );
      await query(
        `UPDATE orders
         SET status = 'PAYING',
             created_at = now() - interval '2 minutes',
             expires_at = now() - interval '1 minute'
         WHERE id = $1`,
        [order.id]
      );
      const baseVerified = {
        orderNo: order.orderNo,
        channel: "fake" as const,
        channelTransactionId: `late-${randomUUID()}`,
        amountFen: order.amountFen,
        currency: "CNY" as const,
        raw: { source: "late-provider-payment" }
      };
      await expect(
        markOrderPaid({
          orderId: order.id,
          paymentAttemptId: attempt.rows[0].id,
          verified: {
            ...baseVerified,
            paidAt: new Date().toISOString()
          }
        })
      ).rejects.toMatchObject({
        code: "PAYMENT_VERIFICATION_FAILED"
      });
      const rejected = await query<{
        transactions: string;
        entitlements: string;
      }>(
        `SELECT
           (SELECT count(*)::text FROM payment_transactions WHERE order_id = $1)
             AS transactions,
           (SELECT count(*)::text FROM entitlements WHERE source_id = $1)
             AS entitlements`,
        [order.id]
      );
      expect(rejected.rows[0]).toEqual({
        transactions: "0",
        entitlements: "0"
      });

      await expect(
        markOrderPaid({
          orderId: order.id,
          paymentAttemptId: attempt.rows[0].id,
          verified: {
            ...baseVerified,
            paidAt: new Date(Date.now() - 120_000).toISOString()
          }
        })
      ).resolves.toMatchObject({ status: "COMPLETED" });
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
      const attempt = await query<{ id: string }>(
        `INSERT INTO payment_attempts(order_id, channel, status)
         VALUES ($1, 'fake', 'SUCCEEDED')
         RETURNING id`,
        [order.id]
      );
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
         VALUES ($1, $2, 'fake', $3, $4, 'CNY', 'SUCCESS', '{}', now())`,
        [
          order.id,
          attempt.rows[0].id,
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
        clientIp: "127.0.0.1",
        returnUrl: "http://peileme.test/return",
        notifyUrl: "http://peileme.test/notify",
        provider: {
          channel: "fake",
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

  it("retries a provider failure with the same recoverable attempt", async () => {
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
      let calls = 0;
      const provider = {
        channel: "fake" as const,
        async createPayment(input: { attemptId: string; orderNo: string }) {
          seenAttempts.push(input.attemptId);
          calls += 1;
          if (calls === 1) throw new Error("provider sentinel secret");
          return {
            prepayId: `retry-${input.attemptId}`,
            launchUrl: `/retry/${input.orderNo}`,
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
      const start = () =>
        startPayment({
          userId: userId!,
          orderId: order.id,
          provider,
          clientIp: "127.0.0.1",
          returnUrl: "http://peileme.test/return",
          notifyUrl: "http://peileme.test/notify"
        });

      await expect(start()).rejects.toMatchObject({
        code: "PAYMENT_PROVIDER_FAILED",
        message: "PAYMENT_PROVIDER_FAILED"
      });
      const retried = await start();
      expect(seenAttempts).toEqual([
        retried.paymentAttemptId,
        retried.paymentAttemptId
      ]);
      const attempts = await query<{
        count: string;
        error_message: string | null;
        status: string;
      }>(
        `SELECT
           count(*)::text AS count,
           max(error_message) AS error_message,
           max(status) AS status
         FROM payment_attempts
         WHERE order_id = $1`,
        [order.id]
      );
      expect(attempts.rows[0]).toEqual({
        count: "1",
        error_message: null,
        status: "REDIRECT_READY"
      });
    } finally {
      if (userId) await cleanupEntitlementTestUsers([userId]);
    }
  });

  it("commits expiry closure before returning ORDER_EXPIRED", async () => {
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
      const attempt = await query<{ id: string }>(
        `INSERT INTO payment_attempts(order_id, channel, status)
         VALUES ($1, 'fake', 'PENDING')
         RETURNING id`,
        [order.id]
      );
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
        channel: "fake" as const,
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
          provider,
          clientIp: "127.0.0.1",
          returnUrl: "http://peileme.test/return",
          notifyUrl: "http://peileme.test/notify",
          providerTimeoutMs: 100
        });

      await expect(start()).rejects.toMatchObject({ code: "ORDER_EXPIRED" });
      const first = await query<{
        status: string;
        closed_at: Date | null;
        attempt_status: string;
      }>(
        `SELECT o.status, o.closed_at, pa.status AS attempt_status
         FROM orders o
         JOIN payment_attempts pa ON pa.order_id = o.id
         WHERE o.id = $1`,
        [order.id]
      );
      expect(first.rows[0]).toMatchObject({
        status: "CLOSED",
        closed_at: expect.any(Date),
        attempt_status: "CLOSED"
      });
      await expect(start()).rejects.toMatchObject({
        code: "ORDER_STATE_CONFLICT"
      });
      expect(createCalls).toBe(0);
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
      let timedOutSignal: AbortSignal | undefined;
      let queryCalls = 0;
      let calls = 0;
      const provider = {
        channel: "fake" as const,
        async createPayment(input: {
          attemptId: string;
          orderNo: string;
          signal: AbortSignal;
        }) {
          seenAttempts.push(input.attemptId);
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
        async queryPayment(_orderNo: string, signal: AbortSignal) {
          expect(signal.aborted).toBe(false);
          queryCalls += 1;
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
        status: "FAILED"
      });
      await expect(start()).rejects.toMatchObject({
        code: "PAYMENT_INITIALIZING"
      });
      expect({ calls, queryCalls }).toEqual({ calls: 1, queryCalls: 1 });
      await query(
        `UPDATE payment_attempts
         SET updated_at = now() - interval '121 seconds'
         WHERE order_id = $1`,
        [order.id]
      );
      const retried = await start();
      expect(seenAttempts).toEqual([
        retried.paymentAttemptId,
        retried.paymentAttemptId
      ]);
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
        channel: "fake" as const,
        async createPayment() {
          createCalls += 1;
          throw new Error("must not create");
        },
        async queryPayment(orderNo: string) {
          queryCalls += 1;
          return {
            orderNo,
            channel: "fake" as const,
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

  it("reuses the failed attempt when provider query reports no payment", async () => {
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
        channel: "fake" as const,
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
      const retried = await startPayment({
        userId,
        orderId: failed.order.id,
        provider,
        clientIp: "127.0.0.1",
        returnUrl: "http://peileme.test/return",
        notifyUrl: "http://peileme.test/notify",
        providerTimeoutMs: 100
      });
      expect(retried).toMatchObject({
        status: "PAYING",
        paymentAttemptId: failed.attemptId
      });
      expect({ createCalls, queryCalls }).toEqual({
        createCalls: 1,
        queryCalls: 1
      });
      const attempts = await query<{ count: string }>(
        "SELECT count(*)::text AS count FROM payment_attempts WHERE order_id = $1",
        [failed.order.id]
      );
      expect(attempts.rows[0].count).toBe("1");
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
        channel: "fake" as const,
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
        status: "PAYMENT_FAILED",
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
      await query(
        `UPDATE payment_attempts
         SET status = 'CLOSED'
         WHERE order_id = ANY($1::uuid[])`,
        [[paid.order.id, unpaid.order.id, errored.order.id]]
      );
      let mode: "paid" | "null" | "error" = "paid";
      let createCalls = 0;
      const provider = {
        channel: "fake" as const,
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
            orderNo,
            channel: "fake" as const,
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
        code: "ORDER_STATE_CONFLICT"
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
        const attempt = await query<{ id: string }>(
          `INSERT INTO payment_attempts(order_id, channel, status)
           VALUES ($1, 'fake', 'PENDING')
           RETURNING id`,
          [order.id]
        );
        return { order, attemptId: attempt.rows[0].id };
      };
      const [first, second] = await Promise.all([
        makePayableOrder(),
        makePayableOrder()
      ]);
      const channelTransactionId = `shared-${randomUUID()}`;
      const settle = ({ order, attemptId }: typeof first) =>
        markOrderPaid({
          orderId: order.id,
          paymentAttemptId: attemptId,
          verified: {
            orderNo: order.orderNo,
            channel: "fake",
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
               AND status = 'COMPLETED') AS completed`,
        [channelTransactionId, [first.order.id, second.order.id]]
      );
      expect(persisted.rows[0]).toEqual({
        transactions: "1",
        entitlements: "1",
        completed: "1"
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
      const attempt = await query<{ id: string }>(
        `INSERT INTO payment_attempts(order_id, channel, status)
         VALUES ($1, 'fake', 'PENDING')
         RETURNING id`,
        [order.id]
      );
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
        paymentAttemptId: attempt.rows[0].id,
        verified: {
          orderNo: order.orderNo,
          channel: "fake",
          channelTransactionId: `expiry-${randomUUID()}`,
          amountFen: order.amountFen,
          currency: "CNY",
          paidAt: new Date().toISOString(),
          raw: { source: "expiry-race" }
        }
      });
      const cleanupProvider = {
        channel: "fake" as const,
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
            summary.deferredCount
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
              transactions: "0",
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
        "cleanup-no-provider"
      );
      await query(
        "UPDATE payment_attempts SET channel = 'wechat_h5' WHERE id = $1",
        [noProvider.attemptId]
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
        channel: "fake" as const,
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
            if (orderNo === errored.order.orderNo) {
              throw new Error("cleanup query secret");
            }
            if (orderNo === unpaid.order.orderNo) return null;
            return {
              orderNo,
              channel: "fake" as const,
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
          paid.order.orderNo,
          unpaid.order.orderNo,
          errored.order.orderNo
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
          [errored.order.id, "PAYMENT_FAILED"],
          [noProvider.order.id, "PAYMENT_FAILED"],
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
      await query(
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
        channel: "fake" as const,
        async createPayment() {
          throw new Error("cleanup must not create");
        },
        async queryPayment(orderNo: string, signal: AbortSignal) {
          expect(signal.aborted).toBe(false);
          queryCallsByRun[currentRun].push(orderNo);
          if (
            orderNo === firstQueryError.order.orderNo ||
            orderNo === secondQueryError.order.orderNo
          ) {
            throw new Error("persistent provider query failure");
          }
          if (orderNo === invalidVerified.order.orderNo) {
            return {
              orderNo,
              channel: "fake" as const,
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
        hasMore: true,
        deferredByReason: {
          providerQueryError: 2,
          paymentVerificationFailed: 0,
          closeCapacityExceeded: 0,
          unsafeOrChangedState: 0
        }
      });
      expect(secondReconciliation.closedOrderIds).toEqual([
        unpaid.order.id
      ]);
      expect(secondReconciliation.summary).toEqual({
        scannedCount: 2,
        closedCount: 1,
        providerConfirmedPaidCount: 0,
        deferredCount: 1,
        hasMore: true,
        deferredByReason: {
          providerQueryError: 0,
          paymentVerificationFailed: 1,
          closeCapacityExceeded: 0,
          unsafeOrChangedState: 0
        }
      });
      expect(queryCallsByRun).toEqual([
        [
          firstQueryError.order.orderNo,
          secondQueryError.order.orderNo
        ],
        [
          invalidVerified.order.orderNo,
          unpaid.order.orderNo
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
              status: "PAYMENT_FAILED",
              error_code: "RECONCILIATION_QUERY_FAILED",
              transactions: "0",
              entitlements: "0"
            }
          ],
          [
            secondQueryError.order.id,
            {
              id: secondQueryError.order.id,
              status: "PAYMENT_FAILED",
              error_code: "RECONCILIATION_QUERY_FAILED",
              transactions: "0",
              entitlements: "0"
            }
          ],
          [
            invalidVerified.order.id,
            {
              id: invalidVerified.order.id,
              status: "PAYMENT_FAILED",
              error_code: "RECONCILIATION_VERIFICATION_FAILED",
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
      await query(
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
        channel: "fake" as const,
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
          hasMore: true,
          deferredByReason: {
            providerQueryError: 0,
            paymentVerificationFailed: 0,
            closeCapacityExceeded: 2,
            unsafeOrChangedState: 0
          }
        },
        {
          scannedCount: 2,
          closedCount: 1,
          providerConfirmedPaidCount: 0,
          deferredCount: 1,
          hasMore: true,
          deferredByReason: {
            providerQueryError: 0,
            paymentVerificationFailed: 0,
            closeCapacityExceeded: 1,
            unsafeOrChangedState: 0
          }
        },
        {
          scannedCount: 1,
          closedCount: 1,
          providerConfirmedPaidCount: 0,
          deferredCount: 0,
          hasMore: false,
          deferredByReason: {
            providerQueryError: 0,
            paymentVerificationFailed: 0,
            closeCapacityExceeded: 0,
            unsafeOrChangedState: 0
          }
        }
      ]);
      for (const reconciliation of reconciliations) {
        const summary = reconciliation.summary;
        expect(summary.scannedCount).toBe(
          summary.closedCount +
            summary.providerConfirmedPaidCount +
            summary.deferredCount
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
        channel: "fake" as const,
        async createPayment() {
          throw new Error("cleanup must not create");
        },
        async queryPayment(orderNo: string, signal: AbortSignal) {
          expect(signal.aborted).toBe(false);
          queryCalls.push(orderNo);
          return {
            orderNo,
            channel: "fake" as const,
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

      expect(queryCalls).toEqual([paid.order.orderNo]);
      expect(reconciliation.closedOrderIds).toEqual([firstCreated.id]);
      expect(reconciliation.summary).toEqual({
        scannedCount: 2,
        closedCount: 1,
        providerConfirmedPaidCount: 1,
        deferredCount: 0,
        hasMore: true,
        deferredByReason: {
          providerQueryError: 0,
          paymentVerificationFailed: 0,
          closeCapacityExceeded: 0,
          unsafeOrChangedState: 0
        }
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
      const makeOrderWithAttempt = async (marker: string) => {
        const order = await createOrder({
          userId: userId!,
          sku: "POLICY_CALC",
          channel: "main",
          idempotencyKey: `${marker}-${randomUUID()}`,
          businessDraftId: await insertPolicyDraft(userId!)
        });
        const attempt = await query<{ id: string }>(
          `INSERT INTO payment_attempts(
             order_id, channel, status, launch_url
           )
           VALUES ($1, 'fake', 'REDIRECT_READY', '/pending')
           RETURNING id`,
          [order.id]
        );
        return { order, attemptId: attempt.rows[0].id };
      };
      const paid = await makeOrderWithAttempt("paid-expiry");
      const pending = await makeOrderWithAttempt("pending-expiry");
      const failed = await makeOrderWithAttempt("failed-expiry");
      await markOrderPaid({
        orderId: paid.order.id,
        paymentAttemptId: paid.attemptId,
        verified: {
          orderNo: paid.order.orderNo,
          channel: "fake",
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
      await query(
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
        channel: "fake" as const,
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
    const userIds: string[] = [];
    try {
      process.env.APP_ORIGIN =
        "https://peileme.art,https://ai.peileme.art";
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
        channel: "fake" as const,
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
          .set("authorization", `Bearer ${token}`)
          .send({ channel: "fake" })
          .expect(200);
      }
      expect(seen.get(orders[0].orderNo)).toBe(
        `https://peileme.art/orders/${orders[0].id}`
      );
      expect(seen.get(orders[1].orderNo)).toBe(
        `https://ai.peileme.art/orders/${orders[1].id}`
      );

      process.env.APP_ORIGIN = "https://peileme.art";
      resetConfigForTests();
      const misconfiguredApp = createApp({ paymentProvider: provider });
      await request(misconfiguredApp)
        .post(`/api/commerce/orders/${orders[1].id}/pay`)
        .set("authorization", `Bearer ${token}`)
        .send({ channel: "fake" })
        .expect(503);
      expect(seen.size).toBe(2);
    } finally {
      await cleanupEntitlementTestUsers(userIds);
      if (previousOrigin === undefined) {
        delete process.env.APP_ORIGIN;
      } else {
        process.env.APP_ORIGIN = previousOrigin;
      }
      resetConfigForTests();
    }
  });

  it("runs the owned fake checkout through real HTTP and persisted fulfillment", async () => {
    await seedPolicyFoundation();
    const previousPaymentMode = process.env.PAYMENT_MODE;
    const userIds: string[] = [];
    try {
      process.env.PAYMENT_MODE = "fake";
      resetConfigForTests();
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
      const app = createApp();

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
        .send({ channel: "fake" })
        .expect(200);
      const repeatedPay = await request(app)
        .post(`/api/commerce/orders/${order.body.id}/pay`)
        .set("authorization", `Bearer ${token}`)
        .send({ channel: "fake" })
        .expect(200);
      expect(repeatedPay.body.launchUrl).toBe(firstPay.body.launchUrl);

      const launch = new URL(firstPay.body.launchUrl, "http://peileme.test");
      await request(app)
        .post(`${launch.pathname}${launch.search}`)
        .send({ amountFen: "1" })
        .expect(400);
      await query(
        `UPDATE order_items
         SET entitlement_policy = '{"grantCount":"invalid"}'::jsonb
         WHERE order_id = $1`,
        [order.body.id]
      );
      await request(app)
        .post(`${launch.pathname}${launch.search}`)
        .send({})
        .expect(500);
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
      const concurrentCompletions = await Promise.all([
        request(app).post(`${launch.pathname}${launch.search}`).send({}),
        request(app).post(`${launch.pathname}${launch.search}`).send({})
      ]);
      expect(concurrentCompletions.map((item) => item.status).sort()).toEqual([
        200,
        409
      ]);
      expect(
        concurrentCompletions.find((item) => item.status === 200)?.body.status
      ).toBe("COMPLETED");
      await request(app)
        .post(`${launch.pathname}${launch.search}`)
        .send({})
        .expect(409);

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
      if (previousPaymentMode === undefined) {
        delete process.env.PAYMENT_MODE;
      } else {
        process.env.PAYMENT_MODE = previousPaymentMode;
      }
      resetConfigForTests();
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
        pendingAttempts: expect.stringMatching(/^\d+$/)
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
          hasMore: false,
          deferredByReason: {
            providerQueryError: 0,
            paymentVerificationFailed: 0,
            closeCapacityExceeded: 0,
            unsafeOrChangedState: 0
          }
        }
      });
      const audit = await query<{
        action: string;
        detail: {
          limit: number;
          closedCount: number;
          closedOrderIds: string[];
          reconciliation: {
            scannedCount: number;
            closedCount: number;
            providerConfirmedPaidCount: number;
            deferredCount: number;
            hasMore: boolean;
            deferredByReason: {
              providerQueryError: number;
              paymentVerificationFailed: number;
              closeCapacityExceeded: number;
              unsafeOrChangedState: number;
            };
          };
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
              hasMore: false,
              deferredByReason: {
                providerQueryError: 0,
                paymentVerificationFailed: 0,
                closeCapacityExceeded: 0,
                unsafeOrChangedState: 0
              }
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
