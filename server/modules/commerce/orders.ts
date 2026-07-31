import crypto from "node:crypto";
import type pg from "pg";
import { query, withTransaction } from "../../db.js";
import type {
  PaymentProvider,
  VerifiedPayment
} from "../payments/provider.js";
import { parseProductSku } from "./catalog.js";
import {
  CommerceError,
  paymentChannels,
  type Currency,
  type OrderProductChannel,
  type OrderStatus,
  type PaymentChannel,
  type ProductSku
} from "./types.js";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const amountPattern = /^(0|[1-9]\d*)$/;
const closedPaymentReconciliationInitialDelaySeconds = 30;
const closedPaymentReconciliationDeadlineSeconds = 24 * 60 * 60;
const closedPaymentReconciliationMaxNoPaymentConfirmations = 5;
const closedPaymentReconciliationMaxBackoffMs = 30 * 60_000;

const closedPaymentReconciliationBackoffMs = (attemptCount: number) =>
  Math.min(
    closedPaymentReconciliationMaxBackoffMs,
    closedPaymentReconciliationInitialDelaySeconds *
      1_000 *
      2 ** Math.max(0, attemptCount - 1)
  );

type OrderRow = {
  id: string;
  order_no: string;
  user_id: string;
  product_channel: OrderProductChannel;
  status: OrderStatus;
  total_fen: string;
  currency: Currency;
  idempotency_key: string;
  business_draft_id: string | null;
  expires_at: Date;
  created_at: Date;
  updated_at: Date;
  sku: ProductSku;
  product_name: string;
};

type OrderFulfillmentRow = OrderRow & {
  product_id: string;
  entitlement_policy: Record<string, unknown>;
};

export type CommerceOrder = {
  id: string;
  orderNo: string;
  userId: string;
  channel: OrderProductChannel;
  status: OrderStatus;
  sku: ProductSku;
  productName: string;
  amountFen: string;
  currency: Currency;
  businessDraftId: string | null;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

export type CreateOrderInput = {
  userId: string;
  sku: string;
  channel: OrderProductChannel;
  idempotencyKey: string;
  businessDraftId?: string;
};

export type CreateOrderDependencies = {
  orderNoFactory?: () => string;
};

export type MarkOrderPaidInput = {
  orderId: string;
  paymentAttemptId: string;
  verified: VerifiedPayment;
};

const requireUuid = (value: string) => {
  if (!uuidPattern.test(value)) {
    throw new CommerceError("INVALID_COMMERCE_INPUT");
  }
  return value;
};

const requireChannel = (channel: string): OrderProductChannel => {
  if (channel !== "main" && channel !== "ai") {
    throw new CommerceError("INVALID_COMMERCE_CHANNEL");
  }
  return channel;
};

const normalizeIdempotencyKey = (value: string) => {
  const key = value.trim();
  if (!key || key.length > 120) {
    throw new CommerceError("INVALID_COMMERCE_INPUT");
  }
  return key;
};

const normalizeAmount = (value: string) => {
  if (!amountPattern.test(value)) {
    throw new CommerceError("PAYMENT_VERIFICATION_FAILED");
  }
  return BigInt(value).toString();
};

const mapOrder = (row: OrderRow): CommerceOrder => ({
  id: row.id,
  orderNo: row.order_no,
  userId: row.user_id,
  channel: row.product_channel,
  status: row.status,
  sku: row.sku,
  productName: row.product_name,
  amountFen: row.total_fen,
  currency: row.currency,
  businessDraftId: row.business_draft_id,
  expiresAt: row.expires_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at
});

const orderSelect = `
  SELECT
    o.id,
    o.order_no,
    o.user_id,
    o.product_channel,
    o.status,
    o.total_fen,
    o.currency,
    o.idempotency_key,
    o.business_draft_id,
    o.expires_at,
    o.created_at,
    o.updated_at,
    oi.sku,
    oi.product_name
  FROM orders o
  JOIN order_items oi ON oi.order_id = o.id
`;

const makeOrderNo = () =>
  `PLM${Date.now().toString(36).toUpperCase()}${crypto
    .randomUUID()
    .replaceAll("-", "")
    .slice(0, 14)
    .toUpperCase()}`;

const assertOwnedBusinessDraft = async (
  client: pg.PoolClient,
  userId: string,
  channel: OrderProductChannel,
  businessDraftId?: string
) => {
  if (!businessDraftId) {
    throw new CommerceError("BUSINESS_DRAFT_NOT_FOUND");
  }
  const draft = await client.query<{
    user_id: string | null;
    product_channel: string;
    status: string;
    current_step: string;
  }>(
    `SELECT user_id, product_channel, status, current_step
     FROM assessments
     WHERE id = $1
     FOR SHARE`,
    [businessDraftId]
  );
  if (
    draft.rows[0]?.user_id !== userId ||
    draft.rows[0]?.product_channel !== channel ||
    draft.rows[0]?.status !== "in_progress" ||
    draft.rows[0]?.current_step !== "awaiting_entitlement"
  ) {
    throw new CommerceError("BUSINESS_DRAFT_NOT_FOUND");
  }
};

export const createOrder = async (
  input: CreateOrderInput,
  dependencies: CreateOrderDependencies = {}
): Promise<CommerceOrder> => {
  const userId = requireUuid(input.userId);
  const sku = parseProductSku(input.sku);
  const channel = requireChannel(input.channel);
  const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
  const businessDraftId = input.businessDraftId
    ? requireUuid(input.businessDraftId)
    : undefined;

  const orderNoFactory = dependencies.orderNoFactory ?? makeOrderNo;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await withTransaction(async (client) => {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`order:${userId}:${idempotencyKey}`]
    );
    const existing = await client.query<OrderRow>(
      `${orderSelect}
       WHERE o.user_id = $1
         AND o.idempotency_key = $2
       FOR UPDATE OF o`,
      [userId, idempotencyKey]
    );
    const current = existing.rows[0];
    if (current) {
      if (
        current.sku !== sku ||
        current.product_channel !== channel ||
        current.business_draft_id !== (businessDraftId ?? null)
      ) {
        throw new CommerceError("IDEMPOTENCY_CONFLICT");
      }
      return mapOrder(current);
    }

    await assertOwnedBusinessDraft(
      client,
      userId,
      channel,
      businessDraftId
    );
    const product = await client.query<{
      id: string;
      name: string;
      product_channel: "main" | "ai" | "all";
      entitlement_policy: Record<string, unknown>;
      amount_fen: string;
      currency: Currency;
    }>(
      `SELECT
         p.id,
         p.name,
         p.product_channel,
         p.entitlement_policy,
         price.amount_fen,
         price.currency
       FROM products p
       JOIN LATERAL (
         SELECT amount_fen, currency
         FROM product_prices
         WHERE product_id = p.id
           AND effective_from <= now()
           AND (effective_to IS NULL OR effective_to > now())
         ORDER BY effective_from DESC
         LIMIT 1
       ) price ON true
       WHERE p.sku = $1
         AND p.status = 'active'
       FOR SHARE OF p`,
      [sku]
    );
    const selected = product.rows[0];
    if (!selected) throw new CommerceError("PRODUCT_NOT_FOUND");
    if (
      selected.product_channel !== channel &&
      selected.product_channel !== "all"
    ) {
      throw new CommerceError("ORDER_CHANNEL_MISMATCH");
    }

    const inserted = await client.query<OrderRow>(
      `WITH new_order AS (
         INSERT INTO orders(
           order_no,
           user_id,
           product_channel,
           status,
           total_fen,
           currency,
           idempotency_key,
           business_draft_id,
           expires_at
         )
         VALUES (
           $1, $2, $3, 'CREATED', $4, $5, $6, $7,
           now() + interval '30 minutes'
         )
         RETURNING *
       ),
       new_item AS (
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
           id, $8, $9, $10, total_fen, 1, $11::jsonb
         FROM new_order
       )
       SELECT
         o.id,
         o.order_no,
         o.user_id,
         o.product_channel,
         o.status,
         o.total_fen,
         o.currency,
         o.idempotency_key,
         o.business_draft_id,
         o.expires_at,
         o.created_at,
         o.updated_at,
         $9::text AS sku,
         $10::text AS product_name
       FROM new_order o`,
      [
        orderNoFactory(),
        userId,
        channel,
        selected.amount_fen,
        selected.currency,
        idempotencyKey,
        businessDraftId ?? null,
        selected.id,
        sku,
        selected.name,
        JSON.stringify(selected.entitlement_policy)
      ]
    );
        return mapOrder(inserted.rows[0]);
      });
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "23505" &&
        "constraint" in error &&
        error.constraint === "orders_order_no_key" &&
        attempt < 2
      ) {
        continue;
      }
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "23505" &&
        "constraint" in error &&
        error.constraint === "orders_order_no_key"
      ) {
        throw new CommerceError("ORDER_NUMBER_GENERATION_FAILED");
      }
      throw error;
    }
  }
  throw new CommerceError("ORDER_NUMBER_GENERATION_FAILED");
};

const parseGrantCount = (policy: Record<string, unknown>) => {
  const grantCount = policy.grantCount;
  if (
    typeof grantCount !== "number" ||
    !Number.isSafeInteger(grantCount) ||
    grantCount < 1 ||
    grantCount > 10_000
  ) {
    throw new CommerceError("INVALID_ENTITLEMENT_POLICY");
  }
  return grantCount;
};

const loadFulfillmentOrder = async (
  client: pg.PoolClient,
  orderId: string
) => {
  const result = await client.query<OrderFulfillmentRow>(
    `SELECT
       o.id,
       o.order_no,
       o.user_id,
       o.product_channel,
       o.status,
       o.total_fen,
       o.currency,
       o.idempotency_key,
       o.business_draft_id,
       o.expires_at,
       o.created_at,
       o.updated_at,
       oi.product_id,
       oi.sku,
       oi.product_name,
       oi.entitlement_policy
     FROM orders o
     JOIN order_items oi ON oi.order_id = o.id
     WHERE o.id = $1
     FOR UPDATE OF o`,
    [orderId]
  );
  const order = result.rows[0];
  if (!order) throw new CommerceError("ORDER_NOT_FOUND");
  return order;
};

const fulfillOrderInTransaction = async (
  client: pg.PoolClient,
  order: OrderFulfillmentRow
): Promise<CommerceOrder> => {
  const successfulTransaction = await client.query<{ id: string }>(
    `SELECT id
     FROM payment_transactions
     WHERE order_id = $1
       AND status = 'SUCCESS'
     ORDER BY paid_at, id
     LIMIT 1
     FOR SHARE`,
    [order.id]
  );
  if (!successfulTransaction.rows[0]) {
    throw new CommerceError("ORDER_STATE_CONFLICT");
  }
  if (order.status === "COMPLETED") {
    return mapOrder(order);
  }
  if (!["PAID", "FULFILLING"].includes(order.status)) {
    throw new CommerceError("ORDER_STATE_CONFLICT");
  }

  const grantCount = parseGrantCount(order.entitlement_policy);
  if (order.status === "PAID") {
    await client.query(
      `UPDATE orders
       SET status = 'FULFILLING',
           updated_at = now()
       WHERE id = $1`,
      [order.id]
    );
  }
  await client.query(
    `INSERT INTO entitlements(
       user_id,
       product_id,
       source_type,
       source_id,
       total_uses,
       remaining_uses,
       status
     )
     VALUES ($1, $2, 'order', $3, $4, $4, 'active')
     ON CONFLICT (user_id, product_id, source_type, source_id)
       WHERE source_id IS NOT NULL
     DO NOTHING`,
    [order.user_id, order.product_id, order.id, grantCount]
  );
  await client.query(
    `UPDATE orders
     SET status = 'COMPLETED',
         completed_at = COALESCE(completed_at, now()),
         updated_at = now()
     WHERE id = $1`,
    [order.id]
  );
  const completed = await client.query<OrderRow>(
    `${orderSelect}
     WHERE o.id = $1`,
    [order.id]
  );
  return mapOrder(completed.rows[0]);
};

export const fulfillOrder = async (
  orderIdInput: string
): Promise<CommerceOrder> => {
  const orderId = requireUuid(orderIdInput);
  return withTransaction(async (client) => {
    const order = await loadFulfillmentOrder(client, orderId);
    return fulfillOrderInTransaction(client, order);
  });
};

export const markOrderPaid = async ({
  orderId: orderIdInput,
  paymentAttemptId: paymentAttemptIdInput,
  verified
}: MarkOrderPaidInput): Promise<CommerceOrder> => {
  const orderId = requireUuid(orderIdInput);
  const paymentAttemptId = requireUuid(paymentAttemptIdInput);
  const verifiedAmount = normalizeAmount(verified.amountFen);
  if (
    !verified.channelTransactionId.trim() ||
    verified.currency !== "CNY" ||
    !paymentChannels.includes(verified.channel)
  ) {
    throw new CommerceError("PAYMENT_VERIFICATION_FAILED");
  }
  const paidAt = new Date(verified.paidAt);
  if (Number.isNaN(paidAt.getTime())) {
    throw new CommerceError("PAYMENT_VERIFICATION_FAILED");
  }

  return withTransaction(async (client) => {
    const order = await loadFulfillmentOrder(client, orderId);
    if (paidAt.getTime() > order.expires_at.getTime()) {
      throw new CommerceError("PAYMENT_VERIFICATION_FAILED");
    }
    const attempt = await client.query<{
      id: string;
      channel: PaymentChannel;
    }>(
      `SELECT id, channel
       FROM payment_attempts
       WHERE id = $1
         AND order_id = $2
       FOR UPDATE`,
      [paymentAttemptId, order.id]
    );
    const selectedAttempt = attempt.rows[0];
    if (
      !selectedAttempt ||
      selectedAttempt.channel !== verified.channel ||
      order.order_no !== verified.orderNo ||
      normalizeAmount(order.total_fen) !== verifiedAmount ||
      order.currency !== verified.currency
    ) {
      throw new CommerceError("PAYMENT_VERIFICATION_FAILED");
    }

    const existing = await client.query<{
      order_id: string;
      payment_attempt_id: string | null;
      channel: PaymentChannel;
      amount_fen: string;
      currency: Currency;
      status: string;
    }>(
      `SELECT
         order_id,
         payment_attempt_id,
         channel,
         amount_fen,
         currency,
         status
       FROM payment_transactions
       WHERE channel = $1
         AND channel_transaction_id = $2
       FOR UPDATE`,
      [verified.channel, verified.channelTransactionId]
    );
    const transaction = existing.rows[0];
    if (transaction) {
      if (
        transaction.order_id !== order.id ||
        transaction.payment_attempt_id !== selectedAttempt.id ||
        transaction.channel !== verified.channel ||
        normalizeAmount(transaction.amount_fen) !== verifiedAmount ||
        transaction.currency !== verified.currency ||
        transaction.status !== "SUCCESS"
      ) {
        throw new CommerceError("PAYMENT_VERIFICATION_FAILED");
      }
      return mapOrder(order);
    }
    if (order.status === "COMPLETED") {
      throw new CommerceError("ORDER_STATE_CONFLICT");
    }
    if (
      !["CREATED", "PAYING", "PAYMENT_FAILED", "CLOSED"].includes(
        order.status
      )
    ) {
      throw new CommerceError("ORDER_STATE_CONFLICT");
    }

    const insertedTransaction = await client.query<{ id: string }>(
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
       VALUES ($1, $2, $3, $4, $5, $6, 'SUCCESS', $7::jsonb, $8)
       ON CONFLICT (channel, channel_transaction_id) DO NOTHING
       RETURNING id`,
      [
        order.id,
        selectedAttempt.id,
        verified.channel,
        verified.channelTransactionId,
        verifiedAmount,
        verified.currency,
        JSON.stringify(verified.raw),
        paidAt.toISOString()
      ]
    );
    if (!insertedTransaction.rowCount) {
      const conflict = await client.query<{
        order_id: string;
        payment_attempt_id: string | null;
        channel: PaymentChannel;
        amount_fen: string;
        currency: Currency;
        status: string;
      }>(
        `SELECT
           order_id,
           payment_attempt_id,
           channel,
           amount_fen,
           currency,
           status
         FROM payment_transactions
         WHERE channel = $1
           AND channel_transaction_id = $2
         FOR UPDATE`,
        [verified.channel, verified.channelTransactionId]
      );
      const owner = conflict.rows[0];
      if (
        !owner ||
        owner.order_id !== order.id ||
        owner.payment_attempt_id !== selectedAttempt.id ||
        owner.channel !== verified.channel ||
        normalizeAmount(owner.amount_fen) !== verifiedAmount ||
        owner.currency !== verified.currency ||
        owner.status !== "SUCCESS"
      ) {
        throw new CommerceError("PAYMENT_VERIFICATION_FAILED");
      }
    }
    await client.query(
      `UPDATE payment_attempts
       SET status = 'SUCCEEDED',
           reconciliation_state = 'RECOVERED',
           reconciliation_next_at = NULL,
           reconciliation_deadline_at = NULL,
           reconciliation_last_result = 'PAID',
           updated_at = now()
       WHERE id = $1`,
      [selectedAttempt.id]
    );
    await client.query(
      `UPDATE payment_attempts
       SET status = CASE
             WHEN status IN (
               'CREATED',
               'REDIRECT_READY',
               'PENDING',
               'FAILED'
             )
               THEN 'CLOSED'
             ELSE status
           END,
           reconciliation_state = 'TERMINAL',
           reconciliation_next_at = NULL,
           reconciliation_deadline_at = NULL,
           reconciliation_last_result =
             'ORDER_COMPLETED_BY_OTHER_ATTEMPT',
           updated_at = now()
       WHERE order_id = $1
         AND id <> $2
         AND reconciliation_state IN (
           'REQUIRED',
           'RETRY_SCHEDULED'
         )`,
      [order.id, selectedAttempt.id]
    );
    await client.query(
      `UPDATE orders
       SET status = 'PAID',
           paid_at = $2,
           closed_at = NULL,
           updated_at = now()
       WHERE id = $1`,
      [order.id, paidAt.toISOString()]
    );

    return fulfillOrderInTransaction(client, {
      ...order,
      status: "PAID"
    });
  });
};

export const getOwnedOrder = async (
  userIdInput: string,
  orderIdInput: string
) => {
  const userId = requireUuid(userIdInput);
  const orderId = requireUuid(orderIdInput);
  const result = await query<OrderRow>(
    `${orderSelect}
     WHERE o.id = $1
       AND o.user_id = $2`,
    [orderId, userId]
  );
  if (!result.rows[0]) throw new CommerceError("ORDER_NOT_FOUND");
  return mapOrder(result.rows[0]);
};

export const listOwnedOrders = async (
  userIdInput: string,
  page: number,
  pageSize: number
) => {
  const userId = requireUuid(userIdInput);
  const offset = (page - 1) * pageSize;
  const [items, total] = await Promise.all([
    query<OrderRow>(
      `${orderSelect}
       WHERE o.user_id = $1
       ORDER BY o.created_at DESC, o.id DESC
       LIMIT $2 OFFSET $3`,
      [userId, pageSize, offset]
    ),
    query<{ count: string }>(
      "SELECT count(*)::text AS count FROM orders WHERE user_id = $1",
      [userId]
    )
  ]);
  return {
    items: items.rows.map(mapOrder),
    page,
    pageSize,
    total: total.rows[0]?.count ?? "0"
  };
};

export const closeExpiredOrdersInTransaction = async (
  client: pg.PoolClient,
  limit = 200
) => {
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new CommerceError("INVALID_COMMERCE_INPUT");
  }
  const expired = await client.query<{ id: string }>(
    `SELECT id
     FROM orders
     WHERE expires_at <= now()
       AND status = 'CREATED'
       AND NOT EXISTS (
         SELECT 1
         FROM payment_attempts
         WHERE payment_attempts.order_id = orders.id
       )
     ORDER BY expires_at, id
     LIMIT $1
     FOR UPDATE SKIP LOCKED`,
    [limit]
  );
  const orderIds = expired.rows.map((row) => row.id);
  if (!orderIds.length) return [];
  await client.query(
    `UPDATE payment_attempts
     SET status = 'CLOSED',
         updated_at = now()
     WHERE order_id = ANY($1::uuid[])
       AND status IN ('CREATED', 'REDIRECT_READY', 'PENDING', 'FAILED')`,
    [orderIds]
  );
  const result = await client.query<{ id: string }>(
    `UPDATE orders
     SET status = 'CLOSED',
         closed_at = now(),
         updated_at = now()
     WHERE id = ANY($1::uuid[])
       AND status IN ('CREATED', 'PAYING', 'PAYMENT_FAILED')
     RETURNING id`,
    [orderIds]
  );
  return result.rows.map((row) => row.id);
};

export const closeExpiredOrders = async (limit = 200) => {
  return withTransaction((client) =>
    closeExpiredOrdersInTransaction(client, limit)
  );
};

type ExpiredCloseCandidate = {
  id: string;
  status: OrderStatus;
  attemptId: string | null;
  attemptChannel: PaymentChannel | null;
};

const closeExpiredCandidatesInTransaction = async (
  client: pg.PoolClient,
  candidates: ExpiredCloseCandidate[]
) => {
  if (!candidates.length) return [];
  const result = await client.query<{ id: string }>(
    `WITH expected(id, status, attempt_id, attempt_channel) AS (
       SELECT *
       FROM unnest($1::uuid[], $2::text[], $3::uuid[], $4::text[])
     ),
     locked AS (
       SELECT o.id
       FROM orders o
       JOIN expected e
         ON e.id = o.id
        AND e.status = o.status
       LEFT JOIN LATERAL (
         SELECT id, channel
         FROM payment_attempts
         WHERE order_id = o.id
         ORDER BY created_at DESC, id DESC
         LIMIT 1
       ) attempt ON true
       WHERE o.expires_at <= now()
         AND (
           (e.attempt_id IS NULL AND attempt.id IS NULL)
           OR (
             e.attempt_id IS NOT NULL
             AND attempt.id = e.attempt_id
             AND attempt.channel = e.attempt_channel
           )
         )
       FOR UPDATE OF o SKIP LOCKED
     ),
     latest_active_attempts AS MATERIALIZED (
       SELECT DISTINCT ON (pa.order_id, pa.channel) pa.id
       FROM payment_attempts pa
       JOIN locked ON locked.id = pa.order_id
       WHERE pa.status IN (
         'CREATED',
         'REDIRECT_READY',
         'PENDING',
         'FAILED'
       )
       ORDER BY pa.order_id, pa.channel, pa.created_at DESC, pa.id DESC
     ),
     closed_attempts AS (
       UPDATE payment_attempts
       SET status = 'CLOSED',
           reconciliation_state = CASE
             WHEN id IN (SELECT id FROM latest_active_attempts)
               THEN 'REQUIRED'
             ELSE 'NONE'
           END,
           reconciliation_attempt_count = 0,
           reconciliation_no_payment_count = 0,
           reconciliation_query_error_count = 0,
           reconciliation_next_at = CASE
             WHEN id IN (SELECT id FROM latest_active_attempts)
               THEN now() + ($5::integer * interval '1 second')
             ELSE NULL
           END,
           reconciliation_deadline_at = CASE
             WHEN id IN (SELECT id FROM latest_active_attempts)
               THEN now() + ($6::integer * interval '1 second')
             ELSE NULL
           END,
           reconciliation_last_result = CASE
             WHEN id IN (SELECT id FROM latest_active_attempts)
               THEN 'LOCAL_CLOSE_PENDING_FINAL_QUERY'
             ELSE NULL
           END,
           updated_at = now()
       WHERE order_id IN (SELECT id FROM locked)
         AND status IN ('CREATED', 'REDIRECT_READY', 'PENDING', 'FAILED')
     )
     UPDATE orders
     SET status = 'CLOSED',
         closed_at = now(),
         updated_at = now()
     WHERE id IN (SELECT id FROM locked)
     RETURNING id`,
    [
      candidates.map((candidate) => candidate.id),
      candidates.map((candidate) => candidate.status),
      candidates.map((candidate) => candidate.attemptId),
      candidates.map((candidate) => candidate.attemptChannel),
      closedPaymentReconciliationInitialDelaySeconds,
      closedPaymentReconciliationDeadlineSeconds
    ]
  );
  const closedOrderIds = new Set(result.rows.map((row) => row.id));
  return candidates
    .filter((candidate) => closedOrderIds.has(candidate.id))
    .map((candidate) => candidate.id);
};

export type PaymentStartResult = {
  orderId: string;
  orderNo: string;
  status: OrderStatus;
  paymentAttemptId: string;
  launchUrl: string;
  expiresAt: Date;
};

type PreparedPayment =
  | { expired: true }
  | {
      expired?: false;
      existing?: PaymentStartResult;
      attemptId: string;
      generation: string;
      order: CommerceOrder;
    };

type FailedPaymentRecovery = {
  orderId: string;
  orderNo: string;
  attemptId: string;
  orderStatus: OrderStatus;
  attemptErrorCode: string | null;
  attemptUpdatedAt: Date;
};

class PaymentProviderTimeoutError extends Error {
  constructor() {
    super("Payment provider timeout");
    this.name = "PaymentProviderTimeoutError";
  }
}

const withPaymentProviderTimeout = async <T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number
) => {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new PaymentProviderTimeoutError());
          controller.abort();
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

export type ExpiredOrderReconciliationSummary = {
  scannedCount: number;
  closedCount: number;
  providerConfirmedPaidCount: number;
  deferredCount: number;
  terminalCount: number;
  hasMore: boolean;
  scheduledRecoveryCount: number;
  deferredByReason: {
    providerQueryError: number;
    paymentVerificationFailed: number;
    closeCapacityExceeded: number;
    unsafeOrChangedState: number;
  };
  closedRecovery: {
    scannedCount: number;
    recoveredCount: number;
    retryScheduledCount: number;
    terminalCount: number;
    changedStateCount: number;
    retryByReason: {
      noPayment: number;
      queryError: number;
    };
    terminalByReason: {
      deadlineExceeded: number;
      noPaymentLimitExceeded: number;
      paymentAfterExpiry: number;
      paymentVerificationFailed: number;
    };
  };
};

export const reconcileAndCloseExpiredOrders = async (input: {
  provider?: PaymentProvider;
  limit?: number;
  providerTimeoutMs?: number;
  providerQueryBudget?: number;
  onClosed?: (
    client: pg.PoolClient,
    closedOrderIds: string[],
    summary: ExpiredOrderReconciliationSummary
  ) => Promise<void>;
}) => {
  const limit = input.limit ?? 200;
  const providerTimeoutMs = input.providerTimeoutMs ?? 15_000;
  const providerQueryBudget = input.providerQueryBudget ?? 10;
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 500 ||
    !Number.isInteger(providerTimeoutMs) ||
    providerTimeoutMs < 1 ||
    providerTimeoutMs > 60_000 ||
    !Number.isInteger(providerQueryBudget) ||
    providerQueryBudget < 1 ||
    providerQueryBudget > 10
  ) {
    throw new CommerceError("INVALID_COMMERCE_INPUT");
  }
  const provider = input.provider;
  const providerChannel = provider?.channel ?? null;
  const noAttemptCandidates = await query<{
    id: string;
    status: OrderStatus;
  }>(
    `SELECT o.id, o.status
     FROM orders o
     WHERE o.expires_at <= now()
       AND o.status = 'CREATED'
       AND NOT EXISTS (
         SELECT 1
         FROM payment_attempts
         WHERE payment_attempts.order_id = o.id
       )
     ORDER BY o.expires_at, o.id
     LIMIT $1`,
    [limit]
  );
  type ReconciliationCandidate = {
    id: string;
    order_no: string;
    status: OrderStatus;
    expires_at: Date;
    attempt_id: string | null;
    attempt_channel: PaymentChannel | null;
    reconciliation_state:
      | "NONE"
      | "REQUIRED"
      | "RETRY_SCHEDULED"
      | "RECOVERED"
      | "TERMINAL";
    reconciliation_attempt_count: number;
    reconciliation_no_payment_count: number;
    reconciliation_query_error_count: number;
    reconciliation_next_at: Date | null;
    reconciliation_deadline_at: Date | null;
  };
  const safeToClose: ExpiredCloseCandidate[] =
    noAttemptCandidates.rows.map((candidate) => ({
      id: candidate.id,
      status: candidate.status,
      attemptId: null,
      attemptChannel: null
    }));
  let scannedCount = noAttemptCandidates.rows.length;
  let providerConfirmedPaidCount = 0;
  const deferredByReason = {
    providerQueryError: 0,
    paymentVerificationFailed: 0,
    closeCapacityExceeded: 0,
    unsafeOrChangedState: 0
  };
  const closedRecovery = {
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
  };

  if (provider) {
    const candidates = await query<ReconciliationCandidate>(
      `SELECT
         o.id,
         o.order_no,
         o.status,
         o.expires_at,
         attempt.id AS attempt_id,
         attempt.channel AS attempt_channel,
         attempt.reconciliation_state,
         attempt.reconciliation_attempt_count,
         attempt.reconciliation_no_payment_count,
         attempt.reconciliation_query_error_count,
         attempt.reconciliation_next_at,
         attempt.reconciliation_deadline_at
       FROM orders o
       JOIN LATERAL (
         SELECT
           id,
           channel,
           updated_at,
           reconciliation_state,
           reconciliation_attempt_count,
           reconciliation_no_payment_count,
           reconciliation_query_error_count,
           reconciliation_next_at,
           reconciliation_deadline_at
         FROM payment_attempts
         WHERE order_id = o.id
           AND channel = $2
         ORDER BY created_at DESC, id DESC
         LIMIT 1
       ) attempt ON true
       WHERE o.expires_at <= now()
         AND attempt.channel = $2
         AND (
           o.status IN ('CREATED', 'PAYING', 'PAYMENT_FAILED')
           OR (
             o.status = 'CLOSED'
             AND attempt.reconciliation_state IN (
               'REQUIRED',
               'RETRY_SCHEDULED'
             )
             AND (
               attempt.reconciliation_next_at <= now()
               OR attempt.reconciliation_deadline_at <= now()
             )
           )
         )
       ORDER BY
         CASE
           WHEN o.status = 'CLOSED'
             THEN LEAST(
               attempt.reconciliation_next_at,
               attempt.reconciliation_deadline_at
             )
           ELSE attempt.updated_at
         END,
         o.expires_at,
         o.id
       LIMIT $1`,
      [providerQueryBudget, providerChannel]
    );
    scannedCount += candidates.rows.length;
    closedRecovery.scannedCount += candidates.rows.filter(
      (candidate) => candidate.status === "CLOSED"
    ).length;
    type ClosedRecoveryTerminalReason =
      | "deadlineExceeded"
      | "noPaymentLimitExceeded"
      | "paymentAfterExpiry"
      | "paymentVerificationFailed";
    type ReconciliationOutcome =
      | { safeToClose: ExpiredCloseCandidate }
      | {
          deferred:
            | "providerQueryError"
            | "paymentVerificationFailed"
            | "closeCapacityExceeded"
            | "unsafeOrChangedState";
        }
      | {
          providerConfirmedPaid: true;
          closedRecovery: boolean;
        }
      | {
          closedRetryScheduled: "noPayment" | "queryError";
        }
      | {
          closedTerminal: ClosedRecoveryTerminalReason;
        }
      | {
          closedChangedState: true;
        };
    const outcomes = new Array<ReconciliationOutcome | undefined>(
      candidates.rows.length
    );
    const markClosedRecoveryTerminal = async (
      candidate: ReconciliationCandidate,
      reason: ClosedRecoveryTerminalReason
    ) => {
      const terminalResult = {
        deadlineExceeded: "DEADLINE_EXCEEDED",
        noPaymentLimitExceeded: "NO_PAYMENT_LIMIT_EXCEEDED",
        paymentAfterExpiry: "PAYMENT_AFTER_EXPIRY",
        paymentVerificationFailed: "PAYMENT_VERIFICATION_FAILED"
      }[reason];
      const terminal = await query(
        `UPDATE payment_attempts pa
         SET reconciliation_state = 'TERMINAL',
             reconciliation_next_at = NULL,
             reconciliation_deadline_at = NULL,
             reconciliation_last_result = $2,
             error_code = CASE
               WHEN $2 IN (
                 'PAYMENT_AFTER_EXPIRY',
                 'PAYMENT_VERIFICATION_FAILED'
               )
                 THEN 'RECONCILIATION_' || $2
               ELSE error_code
             END,
             error_message = CASE
               WHEN $2 = 'PAYMENT_AFTER_EXPIRY'
                 THEN '渠道付款时间晚于订单有效期，已停止自动恢复'
               WHEN $2 = 'PAYMENT_VERIFICATION_FAILED'
                 THEN '支付核验不一致，已停止自动恢复'
               ELSE error_message
             END,
             updated_at = now()
         WHERE pa.id = $1
           AND pa.reconciliation_state IN (
             'REQUIRED',
             'RETRY_SCHEDULED'
           )
           AND EXISTS (
             SELECT 1
             FROM orders o
             WHERE o.id = pa.order_id
               AND o.status = 'CLOSED'
           )`,
        [candidate.attempt_id, terminalResult]
      );
      return Boolean(terminal.rowCount);
    };
    let nextCandidateIndex = 0;
    const reconcileCandidate = async (candidateIndex: number) => {
      const candidate = candidates.rows[candidateIndex];
      if (
        !candidate.attempt_id ||
        candidate.attempt_channel !== provider.channel
      ) {
        outcomes[candidateIndex] = {
          deferred: "unsafeOrChangedState"
        };
        return;
      }
      const isClosedRecovery = candidate.status === "CLOSED";
      if (isClosedRecovery) {
        const deadline = candidate.reconciliation_deadline_at;
        if (!deadline) {
          outcomes[candidateIndex] = {
            closedChangedState: true
          };
          return;
        }
        const terminalReason =
          deadline.getTime() <= Date.now()
            ? "deadlineExceeded"
            : candidate.reconciliation_no_payment_count >=
                closedPaymentReconciliationMaxNoPaymentConfirmations
              ? "noPaymentLimitExceeded"
              : undefined;
        if (terminalReason) {
          outcomes[candidateIndex] =
            await markClosedRecoveryTerminal(candidate, terminalReason)
              ? { closedTerminal: terminalReason }
              : { closedChangedState: true };
          return;
        }
        const nextAttemptCount =
          candidate.reconciliation_attempt_count + 1;
        const nextRetryAt = new Date(
          Date.now() +
            closedPaymentReconciliationBackoffMs(nextAttemptCount)
        );
        const claimed = await query(
          `UPDATE payment_attempts pa
           SET reconciliation_state = 'RETRY_SCHEDULED',
               reconciliation_attempt_count =
                 reconciliation_attempt_count + 1,
               reconciliation_next_at = $2,
               reconciliation_last_result = 'QUERY_IN_PROGRESS',
               updated_at = now()
           WHERE pa.id = $1
             AND pa.reconciliation_state IN (
               'REQUIRED',
               'RETRY_SCHEDULED'
             )
             AND pa.reconciliation_deadline_at > now()
             AND (
               pa.reconciliation_next_at <= now()
               OR pa.reconciliation_deadline_at <= now()
             )
             AND EXISTS (
               SELECT 1
               FROM orders o
               WHERE o.id = pa.order_id
                 AND o.status = 'CLOSED'
             )
           RETURNING reconciliation_attempt_count`,
          [candidate.attempt_id, nextRetryAt.toISOString()]
        );
        if (!claimed.rowCount) {
          outcomes[candidateIndex] = {
            closedChangedState: true
          };
          return;
        }
      }
      let verified: VerifiedPayment | null;
      try {
        verified = await withPaymentProviderTimeout(
          (signal) => provider.queryPayment(candidate.order_no, signal),
          providerTimeoutMs
        );
      } catch {
        const updated = await query(
          `UPDATE payment_attempts
           SET error_code = 'RECONCILIATION_QUERY_FAILED',
               error_message = '支付渠道查单失败，等待下次重试',
               reconciliation_no_payment_count = CASE
                 WHEN $2::boolean THEN 0
                 ELSE reconciliation_no_payment_count
               END,
               reconciliation_query_error_count = CASE
                 WHEN $2::boolean
                   THEN reconciliation_query_error_count + 1
                 ELSE reconciliation_query_error_count
               END,
               reconciliation_last_result = CASE
                 WHEN $2::boolean THEN 'QUERY_ERROR'
                 ELSE reconciliation_last_result
               END,
               updated_at = now()
           WHERE id = $1
             AND (
               (
                 $2::boolean
                 AND status = 'CLOSED'
                 AND reconciliation_state = 'RETRY_SCHEDULED'
               )
               OR (
                 NOT $2::boolean
                 AND status IN (
                   'CREATED',
                   'REDIRECT_READY',
                   'PENDING',
                   'FAILED'
                 )
               )
             )`,
          [candidate.attempt_id, isClosedRecovery]
        );
        outcomes[candidateIndex] = isClosedRecovery
          ? updated.rowCount
            ? { closedRetryScheduled: "queryError" }
            : { closedChangedState: true }
          : { deferred: "providerQueryError" };
        return;
      }
      if (verified) {
        if (isClosedRecovery) {
          const paidAt = new Date(verified.paidAt);
          const terminalReason =
            !Number.isNaN(paidAt.getTime()) &&
            paidAt.getTime() > candidate.expires_at.getTime()
              ? "paymentAfterExpiry"
              : Number.isNaN(paidAt.getTime())
                ? "paymentVerificationFailed"
                : undefined;
          if (terminalReason) {
            outcomes[candidateIndex] =
              await markClosedRecoveryTerminal(candidate, terminalReason)
                ? { closedTerminal: terminalReason }
                : { closedChangedState: true };
            return;
          }
        }
        try {
          await markOrderPaid({
            orderId: candidate.id,
            paymentAttemptId: candidate.attempt_id,
            verified
          });
          outcomes[candidateIndex] = {
            providerConfirmedPaid: true,
            closedRecovery: isClosedRecovery
          };
        } catch (error) {
          const verificationFailed =
            error instanceof CommerceError &&
            error.code === "PAYMENT_VERIFICATION_FAILED";
          if (isClosedRecovery && verificationFailed) {
            outcomes[candidateIndex] =
              await markClosedRecoveryTerminal(
                candidate,
                "paymentVerificationFailed"
              )
                ? { closedTerminal: "paymentVerificationFailed" }
                : { closedChangedState: true };
            return;
          }
          await query(
            `UPDATE payment_attempts
             SET error_code = $2,
                 error_message = $3,
                 updated_at = now()
             WHERE id = $1
               AND status IN ('CREATED', 'REDIRECT_READY', 'PENDING', 'FAILED')`,
            [
              candidate.attempt_id,
              verificationFailed
                ? "RECONCILIATION_VERIFICATION_FAILED"
                : "RECONCILIATION_SETTLEMENT_DEFERRED",
              verificationFailed
                ? "支付核验不一致，等待人工检查"
                : "支付状态已变化，等待下次核验"
            ]
          );
          outcomes[candidateIndex] = {
            deferred: verificationFailed
              ? "paymentVerificationFailed"
              : "unsafeOrChangedState"
          };
        }
        return;
      }
      if (isClosedRecovery) {
        const updated = await query<{
          reconciliation_no_payment_count: number;
        }>(
          `UPDATE payment_attempts
           SET reconciliation_no_payment_count =
                 reconciliation_no_payment_count + 1,
               reconciliation_last_result = 'NO_PAYMENT',
               error_code = NULL,
               error_message = NULL,
               updated_at = now()
           WHERE id = $1
             AND status = 'CLOSED'
             AND reconciliation_state = 'RETRY_SCHEDULED'
           RETURNING reconciliation_no_payment_count`,
          [candidate.attempt_id]
        );
        if (!updated.rowCount) {
          outcomes[candidateIndex] = {
            closedChangedState: true
          };
          return;
        }
        if (
          updated.rows[0].reconciliation_no_payment_count >=
          closedPaymentReconciliationMaxNoPaymentConfirmations
        ) {
          outcomes[candidateIndex] =
            await markClosedRecoveryTerminal(
              candidate,
              "noPaymentLimitExceeded"
            )
              ? { closedTerminal: "noPaymentLimitExceeded" }
              : { closedChangedState: true };
          return;
        }
        outcomes[candidateIndex] = {
          closedRetryScheduled: "noPayment"
        };
        return;
      }
      outcomes[candidateIndex] = {
        safeToClose: {
          id: candidate.id,
          status: candidate.status,
          attemptId: candidate.attempt_id,
          attemptChannel: candidate.attempt_channel
        }
      };
    };
    const workers = Array.from(
      { length: Math.min(10, candidates.rows.length) },
      async () => {
        while (nextCandidateIndex < candidates.rows.length) {
          const candidateIndex = nextCandidateIndex;
          nextCandidateIndex += 1;
          await reconcileCandidate(candidateIndex);
        }
      }
    );
    await Promise.all(workers);
    for (const outcome of outcomes) {
      if (!outcome) continue;
      if ("providerConfirmedPaid" in outcome) {
        providerConfirmedPaidCount += 1;
        if (outcome.closedRecovery) {
          closedRecovery.recoveredCount += 1;
        }
      } else if ("closedRetryScheduled" in outcome) {
        closedRecovery.retryScheduledCount += 1;
        closedRecovery.retryByReason[outcome.closedRetryScheduled] += 1;
      } else if ("closedTerminal" in outcome) {
        closedRecovery.terminalCount += 1;
        closedRecovery.terminalByReason[outcome.closedTerminal] += 1;
      } else if ("closedChangedState" in outcome) {
        closedRecovery.changedStateCount += 1;
        deferredByReason.unsafeOrChangedState += 1;
      } else if ("deferred" in outcome) {
        deferredByReason[outcome.deferred] += 1;
      } else if (safeToClose.length < limit) {
        safeToClose.push(outcome.safeToClose);
      } else {
        await query(
          `UPDATE payment_attempts
           SET error_code = 'RECONCILIATION_CLOSE_CAPACITY_EXCEEDED',
               error_message = '本轮安全关单容量已满，等待下次处理',
               updated_at = now()
           WHERE id = $1
             AND status IN ('CREATED', 'REDIRECT_READY', 'PENDING', 'FAILED')`,
          [outcome.safeToClose.attemptId]
        );
        deferredByReason.closeCapacityExceeded += 1;
      }
    }
  }

  return withTransaction(async (client) => {
    const closedOrderIds =
      await closeExpiredCandidatesInTransaction(client, safeToClose);
    deferredByReason.unsafeOrChangedState +=
      safeToClose.length - closedOrderIds.length;
    const moreCandidates = await client.query<{ has_more: boolean }>(
      `SELECT EXISTS (
         SELECT 1
         FROM orders o
         LEFT JOIN LATERAL (
           SELECT id
           FROM payment_attempts
           WHERE order_id = o.id
           ORDER BY created_at DESC, id DESC
           LIMIT 1
         ) latest_attempt ON true
         LEFT JOIN LATERAL (
           SELECT
             id,
             channel,
             reconciliation_state,
             reconciliation_next_at,
             reconciliation_deadline_at
           FROM payment_attempts
           WHERE order_id = o.id
             AND channel = $1
           ORDER BY created_at DESC, id DESC
           LIMIT 1
         ) channel_attempt ON $1::text IS NOT NULL
         WHERE o.expires_at <= now()
           AND (
             (o.status = 'CREATED' AND latest_attempt.id IS NULL)
             OR (
               $1::text IS NOT NULL
               AND channel_attempt.channel = $1
               AND (
                 o.status IN ('CREATED', 'PAYING', 'PAYMENT_FAILED')
                 OR (
                   o.status = 'CLOSED'
                   AND channel_attempt.reconciliation_state IN (
                     'REQUIRED',
                     'RETRY_SCHEDULED'
                   )
                   AND (
                     channel_attempt.reconciliation_next_at <= now()
                     OR channel_attempt.reconciliation_deadline_at <= now()
                   )
                 )
               )
             )
           )
       ) AS has_more`,
      [providerChannel]
    );
    const scheduledRecovery = await client.query<{ count: number }>(
      `SELECT count(*)::integer AS count
       FROM orders o
       JOIN LATERAL (
         SELECT
           reconciliation_state,
           reconciliation_deadline_at
         FROM payment_attempts
         WHERE order_id = o.id
           AND channel = $1
         ORDER BY created_at DESC, id DESC
         LIMIT 1
       ) attempt ON $1::text IS NOT NULL
       WHERE $1::text IS NOT NULL
         AND o.status = 'CLOSED'
         AND attempt.reconciliation_state IN (
           'REQUIRED',
           'RETRY_SCHEDULED'
         )
         AND attempt.reconciliation_deadline_at > now()`,
      [providerChannel]
    );
    const deferredCount =
      deferredByReason.providerQueryError +
      deferredByReason.paymentVerificationFailed +
      deferredByReason.closeCapacityExceeded +
      deferredByReason.unsafeOrChangedState +
      closedRecovery.retryScheduledCount;
    const summary: ExpiredOrderReconciliationSummary = {
      scannedCount,
      closedCount: closedOrderIds.length,
      providerConfirmedPaidCount,
      deferredCount,
      terminalCount: closedRecovery.terminalCount,
      hasMore: moreCandidates.rows[0]?.has_more ?? false,
      scheduledRecoveryCount: scheduledRecovery.rows[0]?.count ?? 0,
      deferredByReason,
      closedRecovery
    };
    if (input.onClosed) {
      await input.onClosed(client, closedOrderIds, summary);
    }
    return { closedOrderIds, summary };
  });
};

const getFailedPaymentRecovery = async (
  userId: string,
  orderId: string,
  channel: PaymentChannel
): Promise<FailedPaymentRecovery | undefined> => {
  const result = await query<{
    id: string;
    order_no: string;
    attempt_id: string;
    status: OrderStatus;
    error_code: string | null;
    attempt_updated_at: Date;
  }>(
    `SELECT
       o.id,
       o.order_no,
       attempt.id AS attempt_id,
       o.status,
       attempt.error_code,
       attempt.updated_at AS attempt_updated_at
     FROM orders o
     JOIN LATERAL (
       SELECT id, error_code, updated_at
       FROM payment_attempts
       WHERE order_id = o.id
         AND channel = $3
       ORDER BY created_at DESC, id DESC
       LIMIT 1
     ) attempt ON true
     WHERE o.id = $1
       AND o.user_id = $2
       AND o.status IN ('PAYING', 'PAYMENT_FAILED', 'CLOSED')`,
    [orderId, userId, channel]
  );
  const row = result.rows[0];
  return row
    ? {
        orderId: row.id,
        orderNo: row.order_no,
        attemptId: row.attempt_id,
        orderStatus: row.status,
        attemptErrorCode: row.error_code,
        attemptUpdatedAt: row.attempt_updated_at
      }
    : undefined;
};

const preparePayment = async (
  userId: string,
  orderId: string,
  provider: PaymentProvider
): Promise<PreparedPayment> =>
  withTransaction(async (client) => {
    const generation = crypto.randomUUID();
    const selected = await client.query<OrderRow>(
      `${orderSelect}
       WHERE o.id = $1
         AND o.user_id = $2
       FOR UPDATE OF o`,
      [orderId, userId]
    );
    const row = selected.rows[0];
    if (!row) throw new CommerceError("ORDER_NOT_FOUND");
    if (row.expires_at.getTime() <= Date.now()) {
      if (["CREATED", "PAYING", "PAYMENT_FAILED"].includes(row.status)) {
        await client.query(
          `WITH latest_active_attempts AS MATERIALIZED (
             SELECT DISTINCT ON (channel) id
             FROM payment_attempts
             WHERE order_id = $1
               AND status IN (
                 'CREATED',
                 'REDIRECT_READY',
                 'PENDING',
                 'FAILED'
               )
             ORDER BY channel, created_at DESC, id DESC
           ),
           closed_attempts AS (
             UPDATE payment_attempts
           SET status = 'CLOSED',
               reconciliation_state = CASE
                 WHEN id IN (SELECT id FROM latest_active_attempts)
                   THEN 'REQUIRED'
                 ELSE 'NONE'
               END,
               reconciliation_attempt_count = 0,
               reconciliation_no_payment_count = 0,
               reconciliation_query_error_count = 0,
               reconciliation_next_at = CASE
                 WHEN id IN (SELECT id FROM latest_active_attempts)
                   THEN now() + ($2::integer * interval '1 second')
                 ELSE NULL
               END,
               reconciliation_deadline_at = CASE
                 WHEN id IN (SELECT id FROM latest_active_attempts)
                   THEN now() + ($3::integer * interval '1 second')
                 ELSE NULL
               END,
               reconciliation_last_result = CASE
                 WHEN id IN (SELECT id FROM latest_active_attempts)
                   THEN 'LOCAL_CLOSE_PENDING_FINAL_QUERY'
                 ELSE NULL
               END,
               updated_at = now()
           WHERE order_id = $1
             AND status IN (
               'CREATED',
               'REDIRECT_READY',
               'PENDING',
               'FAILED'
             )
           RETURNING id
           )
           SELECT count(*) FROM closed_attempts`,
          [
            row.id,
            closedPaymentReconciliationInitialDelaySeconds,
            closedPaymentReconciliationDeadlineSeconds
          ]
        );
        await client.query(
          `UPDATE orders
           SET status = 'CLOSED',
               closed_at = now(),
               updated_at = now()
           WHERE id = $1`,
          [row.id]
        );
      }
      return { expired: true };
    }
    if (!["CREATED", "PAYING", "PAYMENT_FAILED"].includes(row.status)) {
      throw new CommerceError("ORDER_STATE_CONFLICT");
    }

    const attempts = await client.query<{
      id: string;
      status: string;
      launch_url: string | null;
      updated_at: Date;
    }>(
      `SELECT id, status, launch_url, updated_at
       FROM payment_attempts
       WHERE order_id = $1
         AND channel = $2
         AND status IN ('CREATED', 'REDIRECT_READY', 'PENDING', 'FAILED')
       ORDER BY created_at DESC, id DESC
       FOR UPDATE`,
      [row.id, provider.channel]
    );
    const active = attempts.rows[0];
    if (
      active &&
      ["REDIRECT_READY", "PENDING"].includes(active.status) &&
      active.launch_url
    ) {
      return {
        attemptId: active.id,
        generation: "",
        order: mapOrder(row),
        existing: {
          orderId: row.id,
          orderNo: row.order_no,
          status: row.status,
          paymentAttemptId: active.id,
          launchUrl: active.launch_url,
          expiresAt: row.expires_at
        }
      };
    }
    if (active?.status === "CREATED") {
      if (active.updated_at.getTime() > Date.now() - 120_000) {
        throw new CommerceError("PAYMENT_INITIALIZING");
      }
      await client.query(
        `UPDATE payment_attempts
         SET status = 'FAILED',
             error_code = 'PAYMENT_ATTEMPT_STALE',
             error_message = '支付初始化超时，请重试',
             updated_at = now()
         WHERE id = $1`,
        [active.id]
      );
    }

    const attempt =
      active && ["CREATED", "FAILED"].includes(active.status)
        ? await client.query<{ id: string }>(
            `UPDATE payment_attempts
             SET status = 'CREATED',
                 channel_prepay_id = NULL,
                 launch_url = NULL,
                 request_snapshot = jsonb_build_object(
                   'orderNo', $2::text,
                   'amountFen', $3::text,
                   'currency', $4::text,
                   'generation', $5::text
                 ),
                 response_snapshot = '{}'::jsonb,
                 error_code = NULL,
                 error_message = NULL,
                 updated_at = now()
             WHERE id = $1
             RETURNING id`,
            [
              active.id,
              row.order_no,
              row.total_fen,
              row.currency,
              generation
            ]
          )
        : await client.query<{ id: string }>(
            `INSERT INTO payment_attempts(
               order_id,
               channel,
               status,
               request_snapshot
             )
             VALUES (
               $1,
               $2,
               'CREATED',
               jsonb_build_object(
                 'orderNo', $3::text,
                 'amountFen', $4::text,
                 'currency', $5::text,
                 'generation', $6::text
               )
             )
             RETURNING id`,
            [
              row.id,
              provider.channel,
              row.order_no,
              row.total_fen,
              row.currency,
              generation
            ]
          );
    await client.query(
      `UPDATE orders
       SET status = 'PAYING',
           updated_at = now()
       WHERE id = $1`,
      [row.id]
    );
    return {
      attemptId: attempt.rows[0].id,
      generation,
      order: {
        ...mapOrder(row),
        status: "PAYING"
      }
    };
  });

export const startPayment = async (
  input: {
    userId: string;
    orderId: string;
    provider: PaymentProvider;
    clientIp: string;
    returnUrl: string;
    notifyUrl: string;
    providerTimeoutMs?: number;
  }
): Promise<PaymentStartResult> => {
  const userId = requireUuid(input.userId);
  const orderId = requireUuid(input.orderId);
  const providerTimeoutMs = input.providerTimeoutMs ?? 15_000;
  if (
    !Number.isInteger(providerTimeoutMs) ||
    providerTimeoutMs < 1 ||
    providerTimeoutMs > 60_000
  ) {
    throw new CommerceError("INVALID_COMMERCE_INPUT");
  }
  const failedRecovery = await getFailedPaymentRecovery(
    userId,
    orderId,
    input.provider.channel
  );
  if (failedRecovery) {
    let verified: VerifiedPayment | null;
    try {
      verified = await withPaymentProviderTimeout(
        (signal) =>
          input.provider.queryPayment(
            failedRecovery.orderNo,
            signal
          ),
        providerTimeoutMs
      );
    } catch {
      throw new CommerceError("PAYMENT_PROVIDER_FAILED");
    }
    if (verified) {
      const completed = await markOrderPaid({
        orderId: failedRecovery.orderId,
        paymentAttemptId: failedRecovery.attemptId,
        verified
      });
      return {
        orderId: completed.id,
        orderNo: completed.orderNo,
        status: completed.status,
        paymentAttemptId: failedRecovery.attemptId,
        launchUrl: input.returnUrl,
        expiresAt: completed.expiresAt
      };
    }
    if (failedRecovery.orderStatus === "CLOSED") {
      throw new CommerceError("ORDER_STATE_CONFLICT");
    }
    if (
      failedRecovery.attemptErrorCode === "PAYMENT_PROVIDER_TIMEOUT" &&
      failedRecovery.attemptUpdatedAt.getTime() >
        Date.now() - 120_000
    ) {
      throw new CommerceError("PAYMENT_INITIALIZING");
    }
  }
  const prepared = await preparePayment(
    userId,
    orderId,
    input.provider
  );
  if (prepared.expired) {
    throw new CommerceError("ORDER_EXPIRED");
  }
  if (prepared.existing) return prepared.existing;

  try {
    const created = await withPaymentProviderTimeout(
      (signal) =>
        input.provider.createPayment({
          attemptId: prepared.attemptId,
          orderNo: prepared.order.orderNo,
          description: prepared.order.productName,
          amountFen: prepared.order.amountFen,
          clientIp: input.clientIp,
          returnUrl: input.returnUrl,
          notifyUrl: input.notifyUrl,
          signal
        }),
      providerTimeoutMs
    );
    if (!created.launchUrl.trim()) {
      throw new Error("Provider returned an empty launch URL");
    }
    return withTransaction(async (client) => {
      const attempt = await client.query<{
        status: string;
        generation: string | null;
        launch_url: string | null;
      }>(
        `SELECT
           status,
           request_snapshot->>'generation' AS generation,
           launch_url
         FROM payment_attempts
         WHERE id = $1
           AND order_id = $2
           AND channel = $3
         FOR UPDATE`,
        [
          prepared.attemptId,
          prepared.order.id,
          input.provider.channel
        ]
      );
      const current = attempt.rows[0];
      if (
        current?.status !== "CREATED" ||
        current.generation !== prepared.generation
      ) {
        if (
          current?.launch_url &&
          ["REDIRECT_READY", "PENDING"].includes(current.status)
        ) {
          return {
            orderId: prepared.order.id,
            orderNo: prepared.order.orderNo,
            status: "PAYING" as const,
            paymentAttemptId: prepared.attemptId,
            launchUrl: current.launch_url,
            expiresAt: prepared.order.expiresAt
          };
        }
        throw new CommerceError("PAYMENT_INITIALIZING");
      }
      const updated = await client.query(
        `UPDATE payment_attempts
         SET status = 'REDIRECT_READY',
             channel_prepay_id = $2,
             launch_url = $3,
             response_snapshot = $4::jsonb,
             updated_at = now()
         WHERE id = $1
           AND status = 'CREATED'
           AND request_snapshot->>'generation' = $5`,
        [
          prepared.attemptId,
          created.prepayId ?? null,
          created.launchUrl,
          JSON.stringify(created.response),
          prepared.generation
        ]
      );
      if (updated.rowCount !== 1) {
        throw new CommerceError("PAYMENT_INITIALIZING");
      }
      return {
        orderId: prepared.order.id,
        orderNo: prepared.order.orderNo,
        status: "PAYING",
        paymentAttemptId: prepared.attemptId,
        launchUrl: created.launchUrl,
        expiresAt: prepared.order.expiresAt
      };
    });
  } catch (error) {
    const providerTimedOut =
      error instanceof PaymentProviderTimeoutError;
    await withTransaction(async (client) => {
      await client.query(
        `WITH failed_attempt AS (
           UPDATE payment_attempts
           SET status = 'FAILED',
               error_code = $3,
               error_message = '支付渠道暂时不可用',
               updated_at = now()
           WHERE id = $1
             AND status = 'CREATED'
             AND request_snapshot->>'generation' = $2
           RETURNING order_id
         )
         UPDATE orders
         SET status = 'PAYMENT_FAILED',
             updated_at = now()
         WHERE id IN (SELECT order_id FROM failed_attempt)
           AND status = 'PAYING'`,
        [
          prepared.attemptId,
          prepared.generation,
          providerTimedOut
            ? "PAYMENT_PROVIDER_TIMEOUT"
            : "PAYMENT_PROVIDER_FAILED"
        ]
      );
    });
    if (error instanceof CommerceError) throw error;
    throw new CommerceError("PAYMENT_PROVIDER_FAILED");
  }
};

export const createInvoiceRequest = async (input: {
  userId: string;
  orderId: string;
  title: string;
  taxNumber?: string;
  email: string;
}) => {
  const userId = requireUuid(input.userId);
  const orderId = requireUuid(input.orderId);
  return withTransaction(async (client) => {
    const order = await client.query<{ status: OrderStatus }>(
      `SELECT status
       FROM orders
       WHERE id = $1
         AND user_id = $2
       FOR UPDATE`,
      [orderId, userId]
    );
    if (!order.rows[0]) throw new CommerceError("ORDER_NOT_FOUND");
    if (
      ![
        "COMPLETED",
        "REFUND_PENDING",
        "PARTIALLY_REFUNDED",
        "REFUNDED",
        "REFUND_FAILED"
      ].includes(order.rows[0].status)
    ) {
      throw new CommerceError("INVOICE_NOT_ALLOWED");
    }
    const requestedTaxNumber = input.taxNumber ?? null;
    const existing = await client.query<{
      id: string;
      title: string;
      tax_number: string | null;
      email: string;
      status: string;
      created_at: Date;
    }>(
      `SELECT id, title, tax_number, email, status, created_at
       FROM invoice_requests
       WHERE user_id = $1
         AND order_id = $2
       FOR UPDATE`,
      [userId, orderId]
    );
    if (existing.rows[0]) {
      const invoice = existing.rows[0];
      if (
        invoice.title !== input.title ||
        invoice.tax_number !== requestedTaxNumber ||
        invoice.email !== input.email
      ) {
        throw new CommerceError("INVOICE_CONFLICT");
      }
      return {
        id: invoice.id,
        orderId,
        status: invoice.status,
        createdAt: invoice.created_at
      };
    }
    const inserted = await client.query<{
      id: string;
      status: string;
      created_at: Date;
    }>(
      `INSERT INTO invoice_requests(
         user_id,
         order_id,
         title,
         tax_number,
         email,
         status
       )
       VALUES ($1, $2, $3, $4, $5, 'SUBMITTED')
       RETURNING id, status, created_at`,
      [
        userId,
        orderId,
        input.title,
        requestedTaxNumber,
        input.email
      ]
    );
    return {
      id: inserted.rows[0].id,
      orderId,
      status: inserted.rows[0].status,
      createdAt: inserted.rows[0].created_at
    };
  });
};
