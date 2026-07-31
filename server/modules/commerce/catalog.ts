import { query } from "../../db.js";
import {
  CommerceError,
  productSkus,
  type Currency,
  type FulfillmentType,
  type OrderProductChannel,
  type ProductChannel,
  type ProductSku,
  type ProductStatus
} from "./types.js";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type ProductRow = {
  id: string;
  sku: string;
  name: string;
  description: string;
  product_channel: ProductChannel;
  fulfillment_type: FulfillmentType;
  status: ProductStatus;
  entitlement_policy: Record<string, unknown>;
};

type PriceRow = {
  id: string;
  product_id: string;
  amount_fen: string;
  currency: Currency;
  effective_from: Date;
  effective_to: Date | null;
};

export type CommerceProduct = {
  id: string;
  sku: string;
  name: string;
  description: string;
  productChannel: ProductChannel;
  fulfillmentType: FulfillmentType;
  status: ProductStatus;
  entitlementPolicy: Record<string, unknown>;
};

export type EffectivePrice = {
  id: string;
  productId: string;
  amountFen: string;
  currency: Currency;
  effectiveFrom: Date;
  effectiveTo: Date | null;
};

export type CatalogItem = CommerceProduct &
  Omit<EffectivePrice, "id" | "productId"> & {
    priceId: string;
  };

export const parseProductSku = (value: string): ProductSku => {
  if (!productSkus.includes(value as ProductSku)) {
    throw new CommerceError("INVALID_PRODUCT_SKU");
  }
  return value as ProductSku;
};

const mapProduct = (row: ProductRow): CommerceProduct => ({
  id: row.id,
  sku: row.sku,
  name: row.name,
  description: row.description,
  productChannel: row.product_channel,
  fulfillmentType: row.fulfillment_type,
  status: row.status,
  entitlementPolicy: row.entitlement_policy
});

const mapPrice = (row: PriceRow): EffectivePrice => ({
  id: row.id,
  productId: row.product_id,
  amountFen: row.amount_fen,
  currency: row.currency,
  effectiveFrom: row.effective_from,
  effectiveTo: row.effective_to
});

export const getProductBySku = async (
  skuInput: string
): Promise<CommerceProduct | null> => {
  const sku = parseProductSku(skuInput);
  const result = await query<ProductRow>(
    `SELECT
       id,
       sku,
       name,
       description,
       product_channel,
       fulfillment_type,
       status,
       entitlement_policy
     FROM products
     WHERE sku = $1`,
    [sku]
  );
  return result.rows[0] ? mapProduct(result.rows[0]) : null;
};

export const getEffectivePrice = async (
  productId: string,
  at: Date
): Promise<EffectivePrice | null> => {
  if (
    !uuidPattern.test(productId) ||
    !(at instanceof Date) ||
    Number.isNaN(at.getTime())
  ) {
    throw new CommerceError("INVALID_COMMERCE_INPUT");
  }
  const result = await query<PriceRow>(
    `SELECT
       id,
       product_id,
       amount_fen,
       currency,
       effective_from,
       effective_to
     FROM product_prices
     WHERE product_id = $1
       AND effective_from <= $2
       AND (effective_to IS NULL OR effective_to > $2)
     ORDER BY effective_from DESC
     LIMIT 1`,
    [productId, at.toISOString()]
  );
  return result.rows[0] ? mapPrice(result.rows[0]) : null;
};

export const getActiveCatalog = async (
  channel: OrderProductChannel
): Promise<CatalogItem[]> => {
  if (channel !== "main" && channel !== "ai") {
    throw new CommerceError("INVALID_COMMERCE_CHANNEL");
  }
  const result = await query<
    ProductRow & {
      price_id: string;
      amount_fen: string;
      currency: Currency;
      effective_from: Date;
      effective_to: Date | null;
    }
  >(
    `SELECT
       p.id,
       p.sku,
       p.name,
       p.description,
       p.product_channel,
       p.fulfillment_type,
       p.status,
       p.entitlement_policy,
       price.id AS price_id,
       price.amount_fen,
       price.currency,
       price.effective_from,
       price.effective_to
     FROM products p
     JOIN LATERAL (
       SELECT
         pp.id,
         pp.amount_fen,
         pp.currency,
         pp.effective_from,
         pp.effective_to
       FROM product_prices pp
       WHERE pp.product_id = p.id
         AND pp.effective_from <= now()
         AND (pp.effective_to IS NULL OR pp.effective_to > now())
       ORDER BY pp.effective_from DESC
       LIMIT 1
     ) price ON true
     WHERE p.status = 'active'
       AND p.product_channel IN ($1, 'all')
     ORDER BY p.sku`,
    [channel]
  );
  return result.rows.map((row) => ({
    ...mapProduct(row),
    priceId: row.price_id,
    amountFen: row.amount_fen,
    currency: row.currency,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to
  }));
};
