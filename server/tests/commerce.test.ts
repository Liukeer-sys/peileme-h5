import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

  it("rejects a second open price for one product", async () => {
    await seedPolicyFoundation();
    await expect(
      query(
        `INSERT INTO product_prices(product_id, amount_fen, effective_from)
         SELECT id, 1090, now()
           FROM products
          WHERE sku = 'POLICY_CALC'`
      )
    ).rejects.toMatchObject({
      code: "23505",
      constraint: "product_prices_one_open_idx"
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
