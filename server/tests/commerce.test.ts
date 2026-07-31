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
  listOwnedOrders,
  markOrderPaid,
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

const insertPolicyDraft = async (userId: string) => {
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
       'payment',
       '{"facts":{}}'::jsonb,
       'main',
       '{}'::jsonb
     )
     RETURNING id`,
    [userId]
  );
  return draft.rows[0].id;
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
          idempotencyKey: `wrong-site-${randomUUID()}`
        })
      ).rejects.toMatchObject({
        code: "ORDER_CHANNEL_MISMATCH"
      });
      await expect(
        createOrder({
          userId,
          sku: "AI_DOCUMENT_REVIEW",
          channel: "ai",
          idempotencyKey: `ai-document-${randomUUID()}`
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
      const outcomes = await Promise.allSettled([
        payment,
        closeExpiredOrders()
      ]);
      expect(outcomes[1].status).toBe("fulfilled");

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
        expect(outcomes[0].reason).toMatchObject({
          code: "ORDER_STATE_CONFLICT"
        });
      }
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
                  ELSE status
                END
          WHERE id = ANY($1::uuid[])`,
        [[paid.order.id, pending.order.id], pending.order.id]
      );

      await expect(closeExpiredOrders()).resolves.toEqual([
        pending.order.id
      ]);
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
        [[paid.order.id, pending.order.id]]
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
      const completed = await request(app)
        .post(`${launch.pathname}${launch.search}`)
        .send({})
        .expect(200);
      expect(completed.body.status).toBe("COMPLETED");
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
});
