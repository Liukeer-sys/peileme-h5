import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { closePool, query } from "../db.js";
import { runMigrations } from "../migrate.js";
import { seedPolicyFoundation } from "../modules/policy/seed.js";

type CatalogRow = {
  sku: string;
  product_channel: string;
  fulfillment_type: string;
  status: string;
  entitlement_policy: unknown;
  amount_fen: string;
  currency: string;
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
