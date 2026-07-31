import type pg from "pg";
import { query, withTransaction } from "../../db.js";
import { parseProductSku } from "./catalog.js";
import {
  CommerceError,
  type EntitlementStatus,
  type EntitlementSourceType,
  type EntitlementUsageStatus,
  type ProductSku
} from "./types.js";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const usageBusinessType = "commerce";

type ProductRow = {
  id: string;
  sku: ProductSku;
  status: "active" | "inactive";
};

type EntitlementRow = {
  id: string;
  source_type: EntitlementSourceType;
  remaining_uses: number;
};

type UsageRow = {
  id: string;
  entitlement_id: string;
  user_id: string;
  sku: string;
  source_type: EntitlementSourceType;
  status: EntitlementUsageStatus;
};

type TransitionUsageRow = Pick<
  UsageRow,
  "id" | "entitlement_id" | "status"
>;

type AvailableEntitlementRow = {
  id: string;
  source_type: EntitlementSourceType;
  total_uses: number;
  remaining_uses: number;
  status: EntitlementStatus;
  expires_at: Date | null;
};

export type EntitlementReservation = {
  usageId: string;
  entitlementId: string;
  sourceType: EntitlementSourceType;
  status: EntitlementUsageStatus;
};

export type AvailableEntitlement = {
  id: string;
  sourceType: EntitlementSourceType;
  totalUses: number;
  remainingUses: number;
  status: EntitlementStatus;
  expiresAt: Date | null;
};

export type EntitlementUsageTransition = {
  usageId: string;
  entitlementId: string;
  status: EntitlementUsageStatus;
};

const requireUuid = (value: string) => {
  if (!uuidPattern.test(value)) {
    throw new CommerceError("INVALID_COMMERCE_INPUT");
  }
  return value;
};

const mapUsage = (row: UsageRow): EntitlementReservation => ({
  usageId: row.id,
  entitlementId: row.entitlement_id,
  sourceType: row.source_type,
  status: row.status
});

const findExistingUsage = async (
  client: pg.PoolClient,
  userId: string,
  sku: ProductSku,
  businessId: string
) => {
  const result = await client.query<UsageRow>(
    `SELECT
       eu.id,
       eu.entitlement_id,
       eu.user_id,
       p.sku,
       e.source_type,
       eu.status
     FROM entitlement_usages eu
     JOIN entitlements e ON e.id = eu.entitlement_id
     JOIN products p ON p.id = e.product_id
     WHERE eu.business_type = $1
       AND eu.business_id = $2
     FOR UPDATE OF eu`,
    [usageBusinessType, businessId]
  );
  const existing = result.rows[0];
  if (!existing) return null;
  if (existing.user_id !== userId || existing.sku !== sku) {
    throw new CommerceError("BUSINESS_ID_CONFLICT");
  }
  return mapUsage(existing);
};

const findAvailableEntitlement = async (
  client: pg.PoolClient,
  userId: string,
  productId: string
): Promise<EntitlementRow | null> => {
  const result = await client.query<EntitlementRow>(
    `SELECT id, source_type, remaining_uses
     FROM entitlements
     WHERE user_id = $1
       AND product_id = $2
       AND status = 'active'
       AND remaining_uses > 0
       AND (expires_at IS NULL OR expires_at > now())
     ORDER BY expires_at ASC NULLS LAST, created_at ASC, id ASC
     LIMIT 1
     FOR UPDATE`,
    [userId, productId]
  );
  return result.rows[0] ?? null;
};

const grantFirstUseEntitlement = async (
  client: pg.PoolClient,
  userId: string,
  productId: string
): Promise<EntitlementRow | null> => {
  const user = await client.query<{
    status: "active" | "disabled";
    verified: boolean;
  }>(
    `SELECT
       status,
       (email_verified_at IS NOT NULL OR phone_verified_at IS NOT NULL) AS verified
     FROM users
     WHERE id = $1
     FOR SHARE`,
    [userId]
  );
  if (!user.rows[0]?.verified || user.rows[0].status !== "active") {
    throw new CommerceError("IDENTITY_VERIFICATION_REQUIRED");
  }

  const priorGrant = await client.query(
    `SELECT 1
     FROM entitlements
     WHERE user_id = $1
       AND product_id = $2
       AND source_type = 'first_free'
     LIMIT 1
     FOR SHARE`,
    [userId, productId]
  );
  if (priorGrant.rowCount) return null;

  const promotion = await client.query<{
    id: string;
    grant_count: number;
  }>(
    `SELECT id, grant_count
     FROM promotion_rules
     WHERE product_id = $1
       AND status = 'active'
       AND trigger_type = 'first_verified_user'
       AND (starts_at IS NULL OR starts_at <= now())
       AND (ends_at IS NULL OR ends_at > now())
     LIMIT 1
     FOR SHARE`,
    [productId]
  );
  const activePromotion = promotion.rows[0];
  if (!activePromotion) return null;

  const inserted = await client.query<EntitlementRow>(
    `INSERT INTO entitlements(
       user_id,
       product_id,
       source_type,
       source_id,
       total_uses,
       remaining_uses,
       status
     )
     VALUES ($1, $2, 'first_free', $3, $4, $4, 'active')
     RETURNING id, source_type, remaining_uses`,
    [userId, productId, activePromotion.id, activePromotion.grant_count]
  );
  return inserted.rows[0];
};

const reserveInTransaction = async (
  client: pg.PoolClient,
  userId: string,
  sku: ProductSku,
  businessId: string
) => {
  const productResult = await client.query<ProductRow>(
    `SELECT id, sku, status
     FROM products
     WHERE sku = $1
     FOR SHARE`,
    [sku]
  );
  const product = productResult.rows[0];
  if (!product) throw new CommerceError("PRODUCT_NOT_FOUND");

  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    [`${userId}:${product.id}`]
  );

  const existing = await findExistingUsage(client, userId, sku, businessId);
  if (existing && existing.status !== "released") return existing;
  if (product.status !== "active") {
    throw new CommerceError("PRODUCT_INACTIVE");
  }

  let entitlement = await findAvailableEntitlement(client, userId, product.id);
  if (!entitlement) {
    entitlement = await grantFirstUseEntitlement(
      client,
      userId,
      product.id
    );
  }
  if (!entitlement) {
    throw new CommerceError("ENTITLEMENT_NOT_AVAILABLE");
  }

  const usage = existing
    ? await client.query<{ id: string }>(
        `UPDATE entitlement_usages
         SET entitlement_id = $2,
             status = 'reserved',
             consumed_at = NULL
         WHERE id = $1
           AND status = 'released'
         RETURNING id`,
        [existing.usageId, entitlement.id]
      )
    : await client.query<{ id: string }>(
        `INSERT INTO entitlement_usages(
           entitlement_id,
           user_id,
           business_type,
           business_id,
           status
         )
         VALUES ($1, $2, $3, $4, 'reserved')
         RETURNING id`,
        [entitlement.id, userId, usageBusinessType, businessId]
      );
  await client.query(
    `UPDATE entitlements
     SET remaining_uses = remaining_uses - 1,
         status = CASE
           WHEN remaining_uses - 1 > 0 THEN 'active'
           ELSE 'reserved'
         END,
         reserved_for = CASE
           WHEN total_uses = 1 THEN $2::uuid
           ELSE NULL::uuid
         END,
         reserved_at = CASE WHEN total_uses = 1 THEN now() ELSE NULL END,
         updated_at = now()
     WHERE id = $1
       AND remaining_uses > 0`,
    [entitlement.id, businessId]
  );

  return {
    usageId: usage.rows[0].id,
    entitlementId: entitlement.id,
    sourceType: entitlement.source_type,
    status: "reserved" as const
  };
};

export const reserveEntitlement = async (
  userIdInput: string,
  skuInput: string,
  businessIdInput: string
): Promise<EntitlementReservation> => {
  const userId = requireUuid(userIdInput);
  const businessId = requireUuid(businessIdInput);
  const sku = parseProductSku(skuInput);
  try {
    return await withTransaction((client) =>
      reserveInTransaction(client, userId, sku, businessId)
    );
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "23505" &&
      "constraint" in error &&
      error.constraint ===
        "entitlement_usages_business_type_business_id_key"
    ) {
      throw new CommerceError("BUSINESS_ID_CONFLICT");
    }
    throw error;
  }
};

const getLockedUsage = async (
  client: pg.PoolClient,
  usageId: string
) => {
  const result = await client.query<TransitionUsageRow>(
    `SELECT
       eu.id,
       eu.entitlement_id,
       eu.status
     FROM entitlement_usages eu
     WHERE eu.id = $1
     FOR UPDATE`,
    [usageId]
  );
  const usage = result.rows[0];
  if (!usage) {
    throw new CommerceError("ENTITLEMENT_USAGE_NOT_FOUND");
  }
  await client.query(
    `SELECT id
     FROM entitlements
     WHERE id = $1
     FOR UPDATE`,
    [usage.entitlement_id]
  );
  return usage;
};

export const getAvailableEntitlements = async (
  userIdInput: string,
  skuInput: string
): Promise<AvailableEntitlement[]> => {
  const userId = requireUuid(userIdInput);
  const sku = parseProductSku(skuInput);
  const result = await query<AvailableEntitlementRow>(
    `SELECT
       e.id,
       e.source_type,
       e.total_uses,
       e.remaining_uses,
       e.status,
       e.expires_at
     FROM entitlements e
     JOIN products p ON p.id = e.product_id
     WHERE e.user_id = $1
       AND p.sku = $2
       AND p.status = 'active'
       AND e.status = 'active'
       AND e.remaining_uses > 0
       AND (e.expires_at IS NULL OR e.expires_at > now())
     ORDER BY e.expires_at ASC NULLS LAST, e.created_at ASC, e.id ASC`,
    [userId, sku]
  );
  return result.rows.map((row) => ({
    id: row.id,
    sourceType: row.source_type,
    totalUses: row.total_uses,
    remainingUses: row.remaining_uses,
    status: row.status,
    expiresAt: row.expires_at
  }));
};

export const consumeEntitlementInTransaction = async (
  client: pg.PoolClient,
  usageIdInput: string
): Promise<EntitlementUsageTransition> => {
  const usageId = requireUuid(usageIdInput);
  const usage = await getLockedUsage(client, usageId);
  if (usage.status === "consumed") {
    return {
      usageId: usage.id,
      entitlementId: usage.entitlement_id,
      status: usage.status
    };
  }
  if (usage.status === "released") {
    throw new CommerceError("ENTITLEMENT_USAGE_CLOSED");
  }

  await client.query(
    `UPDATE entitlement_usages
     SET status = 'consumed',
         consumed_at = now()
     WHERE id = $1`,
    [usage.id]
  );
  await client.query(
    `WITH reserved_marker AS (
       SELECT business_id, created_at
       FROM entitlement_usages
       WHERE entitlement_id = $1
         AND status = 'reserved'
       ORDER BY created_at DESC, id DESC
       LIMIT 1
     )
     UPDATE entitlements e
     SET status = CASE
           WHEN e.status = 'revoked' THEN 'revoked'
           WHEN e.remaining_uses > 0 THEN 'active'
           WHEN EXISTS (SELECT 1 FROM reserved_marker) THEN 'reserved'
           ELSE 'consumed'
         END,
         reserved_for = CASE
           WHEN e.total_uses = 1
             THEN (SELECT business_id FROM reserved_marker)
           ELSE NULL
         END,
         reserved_at = CASE
           WHEN e.total_uses = 1
             THEN (SELECT created_at FROM reserved_marker)
           ELSE NULL
         END,
         updated_at = now()
     WHERE e.id = $1`,
    [usage.entitlement_id]
  );
  return {
    usageId: usage.id,
    entitlementId: usage.entitlement_id,
    status: "consumed"
  };
};

export const consumeEntitlement = async (
  usageIdInput: string
): Promise<EntitlementUsageTransition> =>
  withTransaction((client) =>
    consumeEntitlementInTransaction(client, usageIdInput)
  );

export const releaseEntitlementInTransaction = async (
  client: pg.PoolClient,
  usageIdInput: string
): Promise<EntitlementUsageTransition> => {
  const usageId = requireUuid(usageIdInput);
  const usage = await getLockedUsage(client, usageId);
  if (usage.status === "released") {
    return {
      usageId: usage.id,
      entitlementId: usage.entitlement_id,
      status: usage.status
    };
  }
  if (usage.status === "consumed") {
    throw new CommerceError("ENTITLEMENT_USAGE_CLOSED");
  }

  await client.query(
    `UPDATE entitlement_usages
     SET status = 'released',
         consumed_at = NULL
     WHERE id = $1`,
    [usage.id]
  );
  await client.query(
    `UPDATE entitlements
     SET remaining_uses = LEAST(total_uses, remaining_uses + 1),
         status = CASE
           WHEN status = 'revoked' THEN 'revoked'
           ELSE 'active'
         END,
         reserved_for = NULL,
         reserved_at = NULL,
         updated_at = now()
     WHERE id = $1`,
    [usage.entitlement_id]
  );
  return {
    usageId: usage.id,
    entitlementId: usage.entitlement_id,
    status: "released"
  };
};

export const releaseEntitlement = async (
  usageIdInput: string
): Promise<EntitlementUsageTransition> =>
  withTransaction(async (client) => {
    return releaseEntitlementInTransaction(client, usageIdInput);
  });
