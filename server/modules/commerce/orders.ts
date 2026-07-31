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

type PaymentAnomalyKind =
  | "PAYMENT_AFTER_EXPIRY"
  | "PAYMENT_VERIFICATION_FAILED"
  | "DUPLICATE_PAYMENT";

const tryNormalizeAmount = (value: string) => {
  try {
    return normalizeAmount(value);
  } catch {
    return null;
  }
};

const sanitizePaymentEvidenceText = (
  value: unknown,
  maxLength: number
) => {
  const sanitized = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
  return sanitized || "[missing]";
};

const paymentEvidenceFingerprint = (input: {
  kind: PaymentAnomalyKind;
  attemptChannel: PaymentChannel;
  providerChannel: string;
  channelTransactionId: string;
  providerOrderNo: string;
  amountFen: string;
  currency: string;
  paidAt: Date | null;
}) =>
  crypto
    .createHash("sha256")
    .update(
      JSON.stringify([
        input.kind,
        input.attemptChannel,
        input.providerChannel,
        input.channelTransactionId,
        input.providerOrderNo,
        input.amountFen,
        input.currency,
        input.paidAt?.toISOString() ?? null
      ])
    )
    .digest("hex");

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

const makeProviderOrderNo = (channel: PaymentChannel) => {
  if (channel !== "wechat_h5" && channel !== "alipay_wap") {
    throw new CommerceError("PAYMENT_PROVIDER_FAILED");
  }
  const prefix = channel === "wechat_h5" ? "WX" : "AL";
  return `${prefix}${Date.now().toString(36).toUpperCase()}${crypto
    .randomUUID()
    .replaceAll("-", "")
    .slice(0, 20)
    .toUpperCase()}`;
};

const enableIdentityPaymentWrites = (client: pg.PoolClient) =>
  client.query("SET LOCAL peileme.payment_write_contract = 'identity_v1'");

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

const recordPaymentAnomalyInTransaction = async (
  client: pg.PoolClient,
  input: {
    order: OrderFulfillmentRow;
    paymentAttemptId: string;
    attemptChannel: PaymentChannel;
    verified: VerifiedPayment;
    paidAt: Date | null;
    kind: PaymentAnomalyKind;
  }
) => {
  const providerChannel = sanitizePaymentEvidenceText(
    input.verified.channel,
    32
  );
  const channelTransactionId = sanitizePaymentEvidenceText(
    input.verified.channelTransactionId,
    160
  );
  const providerOrderNo = sanitizePaymentEvidenceText(
    input.verified.providerOrderNo,
    160
  );
  const amountFen = sanitizePaymentEvidenceText(
    input.verified.amountFen,
    80
  );
  const currency = sanitizePaymentEvidenceText(
    input.verified.currency,
    16
  );
  const evidenceFingerprint = paymentEvidenceFingerprint({
    kind: input.kind,
    attemptChannel: input.attemptChannel,
    providerChannel,
    channelTransactionId,
    providerOrderNo,
    amountFen,
    currency,
    paidAt: input.paidAt
  });
  await client.query(
    `INSERT INTO payment_anomalies(
       order_id,
       payment_attempt_id,
       attempt_channel,
       provider_channel,
       kind,
       status,
       channel_transaction_id,
       provider_order_no,
       amount_fen,
       currency,
       paid_at,
       evidence_fingerprint
     )
     VALUES (
       $1,
       $2,
       $3,
       $4,
       $5,
       'PENDING_REVIEW',
       $6,
       $7,
       $8,
       $9,
       $10,
       $11
     )
     ON CONFLICT DO NOTHING`,
    [
      input.order.id,
      input.paymentAttemptId,
      input.attemptChannel,
      providerChannel,
      input.kind,
      channelTransactionId,
      providerOrderNo,
      amountFen,
      currency,
      input.paidAt?.toISOString() ?? null,
      evidenceFingerprint
    ]
  );
  const anomalyOwner = await client.query<{
    order_id: string;
    payment_attempt_id: string;
    kind: PaymentAnomalyKind;
    evidence_fingerprint: string;
  }>(
    `SELECT
       order_id,
       payment_attempt_id,
       kind,
       evidence_fingerprint
     FROM payment_anomalies
     WHERE provider_channel = $1
       AND channel_transaction_id = $2
     FOR UPDATE`,
    [providerChannel, channelTransactionId]
  );
  const owner = anomalyOwner.rows[0];
  if (
    !owner ||
    owner.order_id !== input.order.id ||
    owner.payment_attempt_id !== input.paymentAttemptId ||
    owner.kind !== input.kind ||
    owner.evidence_fingerprint !== evidenceFingerprint
  ) {
    throw new CommerceError("PAYMENT_VERIFICATION_FAILED");
  }
  await client.query(
    `UPDATE payment_attempts
     SET status = 'CLOSED',
         reconciliation_state = 'TERMINAL',
         reconciliation_next_at = NULL,
         reconciliation_deadline_at = NULL,
         reconciliation_last_result = $2,
         error_code = 'PAYMENT_REVIEW_REQUIRED',
         error_message = CASE
           WHEN $2 = 'PAYMENT_AFTER_EXPIRY'
             THEN '渠道付款时间晚于订单有效期，等待人工处理'
           WHEN $2 = 'DUPLICATE_PAYMENT'
             THEN '订单完成后收到第二笔付款，等待退款处理'
           ELSE '支付金额、币种或时间核验不一致，等待人工处理'
         END,
         updated_at = now()
     WHERE id = $1
       AND status <> 'SUCCEEDED'`,
    [input.paymentAttemptId, input.kind]
  );
  if (input.kind === "DUPLICATE_PAYMENT") {
    await client.query(
      `UPDATE payment_attempts
       SET status = 'CLOSED',
           reconciliation_state = 'TERMINAL',
           reconciliation_next_at = NULL,
           reconciliation_deadline_at = NULL,
           reconciliation_last_result =
             'ORDER_COMPLETED_BY_OTHER_ATTEMPT',
           updated_at = now()
       WHERE order_id = $1
         AND id <> $2
         AND (
           status IN (
             'CREATED', 'REDIRECT_READY', 'PENDING', 'FAILED', 'CREATE_UNKNOWN',
             'RECONCILING', 'CLOSE_UNKNOWN'
           )
           OR reconciliation_state IN ('REQUIRED', 'RETRY_SCHEDULED')
         )`,
      [input.order.id, input.paymentAttemptId]
    );
    return;
  }
  await client.query(
    `WITH latest_schedulable_other_channel AS MATERIALIZED (
       SELECT DISTINCT ON (candidate.channel) candidate.id
       FROM payment_attempts candidate
       WHERE candidate.order_id = $1
         AND candidate.id <> $2
         AND candidate.channel <> $3
         AND candidate.status IN (
           'CREATED',
           'REDIRECT_READY',
           'PENDING',
           'CREATE_UNKNOWN',
           'RECONCILING',
           'CLOSE_UNKNOWN'
         )
         AND NOT EXISTS (
           SELECT 1
           FROM payment_attempts scheduled
           WHERE scheduled.order_id = candidate.order_id
             AND scheduled.channel = candidate.channel
             AND scheduled.reconciliation_state IN (
               'REQUIRED',
               'RETRY_SCHEDULED'
             )
         )
       ORDER BY candidate.channel, candidate.created_at DESC, candidate.id DESC
     ),
     closed_active AS (
       UPDATE payment_attempts
       SET status = 'CLOSED',
           reconciliation_state = CASE
             WHEN id IN (
               SELECT id
               FROM latest_schedulable_other_channel
             )
               THEN 'REQUIRED'
             ELSE 'NONE'
           END,
           reconciliation_attempt_count = 0,
           reconciliation_no_payment_count = 0,
           reconciliation_query_error_count = 0,
           reconciliation_next_at = CASE
             WHEN id IN (
               SELECT id
               FROM latest_schedulable_other_channel
             )
               THEN now() + ($4::integer * interval '1 second')
             ELSE NULL
           END,
           reconciliation_deadline_at = CASE
             WHEN id IN (
               SELECT id
               FROM latest_schedulable_other_channel
             )
               THEN now() + ($5::integer * interval '1 second')
             ELSE NULL
           END,
           reconciliation_last_result = CASE
             WHEN id IN (
               SELECT id
               FROM latest_schedulable_other_channel
             )
               THEN 'LOCAL_CLOSE_PENDING_FINAL_QUERY'
             ELSE NULL
           END,
           updated_at = now()
       WHERE order_id = $1
         AND id <> $2
         AND status IN (
           'CREATED',
           'REDIRECT_READY',
           'PENDING',
           'FAILED',
           'CREATE_UNKNOWN',
           'RECONCILING',
           'CLOSE_UNKNOWN'
         )
       RETURNING id
     )
     UPDATE payment_attempts
     SET status = 'CLOSED',
         reconciliation_state = 'TERMINAL',
         reconciliation_next_at = NULL,
         reconciliation_deadline_at = NULL,
         reconciliation_last_result = $6,
         error_code = 'PAYMENT_REVIEW_REQUIRED',
         error_message = '同渠道支付核验异常，已停止自动恢复',
         updated_at = now()
     WHERE order_id = $1
       AND id <> $2
       AND channel = $3
       AND reconciliation_state IN ('REQUIRED', 'RETRY_SCHEDULED')`,
    [
      input.order.id,
      input.paymentAttemptId,
      input.attemptChannel,
      closedPaymentReconciliationInitialDelaySeconds,
      closedPaymentReconciliationDeadlineSeconds,
      input.kind
    ]
  );
  await client.query(
    `UPDATE orders
     SET status = 'CLOSED',
         closed_at = COALESCE(closed_at, now()),
         updated_at = now()
     WHERE id = $1
       AND status IN ('CREATED', 'PAYING', 'PAYMENT_FAILED', 'CLOSED')`,
    [input.order.id]
  );
};

type ReconciliationClaimToken = {
  attemptCount: number;
  nextAt: Date;
};

type MarkOrderPaidInTransactionOutcome =
  | { order: CommerceOrder }
  | { anomaly: PaymentAnomalyKind }
  | { changedState: true };

const markOrderPaidInTransaction = async (
  client: pg.PoolClient,
  {
    orderId: orderIdInput,
    paymentAttemptId: paymentAttemptIdInput,
    verified
  }: MarkOrderPaidInput,
  claimToken?: ReconciliationClaimToken
): Promise<MarkOrderPaidInTransactionOutcome> => {
    const orderId = requireUuid(orderIdInput);
    const paymentAttemptId = requireUuid(paymentAttemptIdInput);
    const order = await loadFulfillmentOrder(client, orderId);
    const attempt = await client.query<{
      id: string;
      channel: PaymentChannel;
      error_code: string | null;
      provider_order_no: string;
    }>(
      `SELECT attempt.id,
              attempt.channel,
              attempt.error_code,
              identity.provider_order_no
       FROM payment_attempts attempt
       JOIN provider_payment_orders identity
         ON identity.id = attempt.provider_payment_order_id
       WHERE attempt.id = $1
         AND attempt.order_id = $2
         AND attempt.provider_identity_role = 'canonical_owner'
         AND attempt.provider_operation_eligible
         AND identity.canonical_attempt_id = attempt.id
         AND (
           $3::integer IS NULL
           OR (
             status = 'CLOSED'
             AND reconciliation_state = 'RETRY_SCHEDULED'
             AND reconciliation_attempt_count = $3
             AND reconciliation_next_at = $4
             AND reconciliation_last_result = 'QUERY_IN_PROGRESS'
           )
         )
       FOR UPDATE`,
      [
        paymentAttemptId,
        order.id,
        claimToken?.attemptCount ?? null,
        claimToken?.nextAt.toISOString() ?? null
      ]
    );
    const selectedAttempt = attempt.rows[0];
    if (!selectedAttempt && claimToken) {
      return { changedState: true as const };
    }
    if (
      !selectedAttempt ||
      !paymentChannels.includes(verified.channel) ||
      selectedAttempt.channel !== verified.channel ||
      selectedAttempt.provider_order_no !== verified.providerOrderNo ||
      !verified.channelTransactionId.trim()
    ) {
      throw new CommerceError("PAYMENT_VERIFICATION_FAILED");
    }
    if (selectedAttempt.error_code === "PAYMENT_REVIEW_REQUIRED") {
      return {
        anomaly: "PAYMENT_VERIFICATION_FAILED" as const
      };
    }
    const verifiedAmount = tryNormalizeAmount(verified.amountFen);
    const parsedPaidAt = new Date(verified.paidAt);
    const paidAt = Number.isNaN(parsedPaidAt.getTime())
      ? null
      : parsedPaidAt;

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
    const matchesExistingTransaction =
      transaction &&
      verifiedAmount !== null &&
      transaction.order_id === order.id &&
      transaction.payment_attempt_id === selectedAttempt.id &&
      transaction.channel === verified.channel &&
      normalizeAmount(transaction.amount_fen) === verifiedAmount &&
      transaction.currency === verified.currency &&
      transaction.status === "SUCCESS";
    if (matchesExistingTransaction) {
      return { order: mapOrder(order) };
    }
    let anomalyKind: PaymentAnomalyKind | undefined;
    if (
      verifiedAmount === null ||
      normalizeAmount(order.total_fen) !== verifiedAmount ||
      order.currency !== verified.currency ||
      paidAt === null
    ) {
      anomalyKind = "PAYMENT_VERIFICATION_FAILED";
    } else if (transaction) {
      anomalyKind = "PAYMENT_VERIFICATION_FAILED";
    } else if (order.status === "COMPLETED") {
      anomalyKind = "DUPLICATE_PAYMENT";
    } else if (paidAt.getTime() > order.expires_at.getTime()) {
      anomalyKind = "PAYMENT_AFTER_EXPIRY";
    }
    if (anomalyKind) {
      await recordPaymentAnomalyInTransaction(client, {
        order,
        paymentAttemptId: selectedAttempt.id,
        attemptChannel: selectedAttempt.channel,
        verified,
        paidAt,
        kind: anomalyKind
      });
      return { anomaly: anomalyKind };
    }
    if (
      !["CREATED", "PAYING", "PAYMENT_FAILED", "CLOSED"].includes(
        order.status
      )
    ) {
      throw new CommerceError("ORDER_STATE_CONFLICT");
    }
    if (verifiedAmount === null || paidAt === null) {
      throw new CommerceError("PAYMENT_VERIFICATION_FAILED");
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
        await recordPaymentAnomalyInTransaction(client, {
          order,
          paymentAttemptId: selectedAttempt.id,
          attemptChannel: selectedAttempt.channel,
          verified,
          paidAt,
          kind: "PAYMENT_VERIFICATION_FAILED"
        });
        return { anomaly: "PAYMENT_VERIFICATION_FAILED" as const };
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
               'FAILED',
               'CREATE_UNKNOWN',
               'RECONCILING',
               'CLOSE_UNKNOWN'
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
         AND (
           status IN (
             'CREATED', 'REDIRECT_READY', 'PENDING', 'FAILED', 'CREATE_UNKNOWN',
             'RECONCILING', 'CLOSE_UNKNOWN'
           )
           OR reconciliation_state IN ('REQUIRED', 'RETRY_SCHEDULED')
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

    return {
      order: await fulfillOrderInTransaction(client, {
        ...order,
        status: "PAID"
      })
    };
};

export const markOrderPaid = async (
  input: MarkOrderPaidInput
): Promise<CommerceOrder> => {
  const outcome = await withTransaction(async (client) => {
    await enableIdentityPaymentWrites(client);
    return markOrderPaidInTransaction(client, input);
  });
  if ("anomaly" in outcome) {
    throw new CommerceError("PAYMENT_VERIFICATION_FAILED");
  }
  if ("changedState" in outcome) {
    throw new CommerceError("ORDER_STATE_CONFLICT");
  }
  return outcome.order;
};

export const getOwnedOrder = async (
  userIdInput: string,
  orderIdInput: string,
  channelInput: OrderProductChannel
) => {
  const userId = requireUuid(userIdInput);
  const orderId = requireUuid(orderIdInput);
  const channel = requireChannel(channelInput);
  const result = await query<OrderRow>(
    `${orderSelect}
     WHERE o.id = $1
       AND o.user_id = $2
       AND o.product_channel = $3`,
    [orderId, userId, channel]
  );
  if (!result.rows[0]) throw new CommerceError("ORDER_NOT_FOUND");
  return mapOrder(result.rows[0]);
};

export const listOwnedOrders = async (
  userIdInput: string,
  page: number,
  pageSize: number,
  channelInput: OrderProductChannel
) => {
  const userId = requireUuid(userIdInput);
  const channel = requireChannel(channelInput);
  const offset = (page - 1) * pageSize;
  const [items, total] = await Promise.all([
    query<OrderRow>(
      `${orderSelect}
       WHERE o.user_id = $1
         AND o.product_channel = $2
       ORDER BY o.created_at DESC, o.id DESC
       LIMIT $3 OFFSET $4`,
      [userId, channel, pageSize, offset]
    ),
    query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM orders
        WHERE user_id = $1
          AND product_channel = $2`,
      [userId, channel]
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
       AND status IN (
         'CREATED', 'REDIRECT_READY', 'PENDING', 'CREATE_UNKNOWN',
         'RECONCILING', 'CLOSE_UNKNOWN'
       )`,
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
  return withTransaction(async (client) => {
    await enableIdentityPaymentWrites(client);
    return closeExpiredOrdersInTransaction(client, limit);
  });
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
         'CREATE_UNKNOWN',
         'RECONCILING',
         'CLOSE_UNKNOWN'
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
         AND status IN (
           'CREATED', 'REDIRECT_READY', 'PENDING', 'FAILED', 'CREATE_UNKNOWN',
           'RECONCILING', 'CLOSE_UNKNOWN'
         )
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
      recovery?: {
        providerOrderNo: string;
        status: string;
      };
      attemptId: string;
      generation: string;
      providerOrderNo: string;
      order: CommerceOrder;
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
  const locallyClosableCandidates = await query<{
    id: string;
    status: OrderStatus;
    attempt_id: string | null;
    attempt_channel: PaymentChannel | null;
  }>(
    `WITH locally_closable AS (
       SELECT
         o.id,
         o.status,
         NULL::uuid AS attempt_id,
         NULL::text AS attempt_channel,
         o.expires_at
       FROM orders o
       WHERE o.expires_at <= now()
         AND o.status = 'CREATED'
         AND NOT EXISTS (
           SELECT 1
           FROM payment_attempts
           WHERE payment_attempts.order_id = o.id
         )
       UNION ALL
       SELECT
         o.id,
         o.status,
         latest.id AS attempt_id,
         latest.channel AS attempt_channel,
         o.expires_at
       FROM orders o
       JOIN LATERAL (
         SELECT attempt.id, attempt.channel, attempt.status
         FROM payment_attempts attempt
         WHERE attempt.order_id = o.id
         ORDER BY attempt.created_at DESC, attempt.id DESC
         LIMIT 1
       ) latest ON true
       WHERE o.expires_at <= now()
         AND o.status IN ('CREATED', 'PAYING', 'PAYMENT_FAILED')
         AND latest.status = 'FAILED'
         AND NOT EXISTS (
           SELECT 1
           FROM payment_attempts unresolved
           WHERE unresolved.order_id = o.id
             AND (
               unresolved.status IN (
                 'CREATED',
                 'REDIRECT_READY',
                 'PENDING',
                 'CREATE_UNKNOWN',
                 'RECONCILING',
                 'CLOSE_UNKNOWN'
               )
               OR unresolved.reconciliation_state IN (
                 'REQUIRED',
                 'RETRY_SCHEDULED'
               )
             )
         )
     )
     SELECT id, status, attempt_id, attempt_channel
     FROM locally_closable
     ORDER BY expires_at, id
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
    provider_order_no: string | null;
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
    reconciliation_last_result: string | null;
  };
  const safeToClose: ExpiredCloseCandidate[] =
    locallyClosableCandidates.rows.map((candidate) => ({
      id: candidate.id,
      status: candidate.status,
      attemptId: candidate.attempt_id,
      attemptChannel: candidate.attempt_channel
    }));
  let scannedCount = locallyClosableCandidates.rows.length;
  let providerConfirmedPaidCount = 0;
  let terminalCount = 0;
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

  type ClosedRecoveryTerminalReason =
    | "deadlineExceeded"
    | "noPaymentLimitExceeded"
    | "paymentAfterExpiry"
    | "paymentVerificationFailed";
  type DeferredReason =
    | "providerQueryError"
    | "paymentVerificationFailed"
    | "closeCapacityExceeded"
    | "unsafeOrChangedState";
  type ProviderNetworkOutcome =
    | {
        kind: "deferred";
        reason: DeferredReason;
        closedRecovery: boolean;
      }
    | {
        kind: "closedTerminalPrecheck";
        candidate: ReconciliationCandidate;
        reason: ClosedRecoveryTerminalReason;
      }
    | {
        kind: "providerQuery";
        candidate: ReconciliationCandidate;
        claimToken?: ReconciliationClaimToken;
        result:
          | { queryError: true }
          | { verified: VerifiedPayment | null };
      };
  const providerOutcomes: ProviderNetworkOutcome[] = [];

  if (provider) {
    const candidates = await query<ReconciliationCandidate>(
      `WITH closed_due AS MATERIALIZED (
         SELECT
           o.id,
           o.order_no,
           o.status,
           o.expires_at,
           attempt.id AS attempt_id,
           attempt.channel AS attempt_channel,
           identity.provider_order_no,
           attempt.reconciliation_state,
           attempt.reconciliation_attempt_count,
           attempt.reconciliation_no_payment_count,
           attempt.reconciliation_query_error_count,
           attempt.reconciliation_next_at,
           attempt.reconciliation_deadline_at,
           attempt.reconciliation_last_result,
           LEAST(
             attempt.reconciliation_next_at,
             attempt.reconciliation_deadline_at
           ) AS candidate_at
         FROM payment_attempts attempt
         JOIN orders o ON o.id = attempt.order_id
         JOIN provider_payment_orders identity
           ON identity.id = attempt.provider_payment_order_id
         WHERE attempt.channel = $2
           AND attempt.provider_identity_role = 'canonical_owner'
           AND attempt.provider_operation_eligible
           AND identity.canonical_attempt_id = attempt.id
           AND attempt.reconciliation_state IN (
             'REQUIRED',
             'RETRY_SCHEDULED'
           )
           AND (
             attempt.reconciliation_next_at <= now()
             OR attempt.reconciliation_deadline_at <= now()
           )
           AND o.status = 'CLOSED'
         ORDER BY
           LEAST(
             attempt.reconciliation_next_at,
             attempt.reconciliation_deadline_at
           ),
           attempt.updated_at,
           attempt.id
         LIMIT $1
       ),
       open_due AS MATERIALIZED (
         SELECT
           o.id,
           o.order_no,
           o.status,
           o.expires_at,
           attempt.id AS attempt_id,
           attempt.channel AS attempt_channel,
           attempt.provider_order_no,
           attempt.reconciliation_state,
           attempt.reconciliation_attempt_count,
           attempt.reconciliation_no_payment_count,
           attempt.reconciliation_query_error_count,
           attempt.reconciliation_next_at,
           attempt.reconciliation_deadline_at,
           attempt.reconciliation_last_result,
           attempt.updated_at AS candidate_at
         FROM orders o
         JOIN LATERAL (
           SELECT
             payment_attempts.id,
             payment_attempts.channel,
             identity.provider_order_no,
             payment_attempts.updated_at,
             payment_attempts.reconciliation_state,
             payment_attempts.reconciliation_attempt_count,
             payment_attempts.reconciliation_no_payment_count,
             payment_attempts.reconciliation_query_error_count,
             payment_attempts.reconciliation_next_at,
             payment_attempts.reconciliation_deadline_at,
             payment_attempts.reconciliation_last_result
           FROM payment_attempts
           JOIN provider_payment_orders identity
             ON identity.id = payment_attempts.provider_payment_order_id
           WHERE payment_attempts.order_id = o.id
             AND payment_attempts.channel = $2
             AND payment_attempts.provider_identity_role = 'canonical_owner'
             AND payment_attempts.provider_operation_eligible
             AND identity.canonical_attempt_id = payment_attempts.id
             AND payment_attempts.status IN (
               'CREATED',
               'REDIRECT_READY',
               'PENDING',
               'CREATE_UNKNOWN',
               'RECONCILING',
               'CLOSE_UNKNOWN'
             )
           ORDER BY payment_attempts.created_at DESC, payment_attempts.id DESC
           LIMIT 1
         ) attempt ON true
         WHERE o.expires_at <= now()
           AND o.status IN ('CREATED', 'PAYING', 'PAYMENT_FAILED')
         ORDER BY attempt.updated_at, o.expires_at, o.id
         LIMIT $1
       ),
       provider_candidates AS (
         SELECT * FROM closed_due
         UNION ALL
         SELECT * FROM open_due
       )
       SELECT
         id,
         order_no,
         status,
         expires_at,
         attempt_id,
         attempt_channel,
         provider_order_no,
         reconciliation_state,
         reconciliation_attempt_count,
         reconciliation_no_payment_count,
         reconciliation_query_error_count,
         reconciliation_next_at,
         reconciliation_deadline_at,
         reconciliation_last_result
       FROM provider_candidates
       ORDER BY candidate_at, expires_at, id
       LIMIT $1`,
      [providerQueryBudget, providerChannel]
    );
    scannedCount += candidates.rows.length;
    closedRecovery.scannedCount += candidates.rows.filter(
      (candidate) => candidate.status === "CLOSED"
    ).length;
    const outcomes = new Array<ProviderNetworkOutcome | undefined>(
      candidates.rows.length
    );
    let nextCandidateIndex = 0;
    const reconcileCandidate = async (candidateIndex: number) => {
      const candidate = candidates.rows[candidateIndex];
      const isClosedRecovery = candidate.status === "CLOSED";
      if (
        !candidate.attempt_id ||
        candidate.attempt_channel !== provider.channel ||
        !candidate.provider_order_no
      ) {
        outcomes[candidateIndex] = {
          kind: "deferred",
          reason: "unsafeOrChangedState",
          closedRecovery: isClosedRecovery
        };
        return;
      }
      let claimToken: ReconciliationClaimToken | undefined;
      if (isClosedRecovery) {
        const deadline = candidate.reconciliation_deadline_at;
        if (!deadline) {
          outcomes[candidateIndex] = {
            kind: "deferred",
            reason: "unsafeOrChangedState",
            closedRecovery: true
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
          outcomes[candidateIndex] = {
            kind: "closedTerminalPrecheck",
            candidate,
            reason: terminalReason
          };
          return;
        }
        const nextAttemptCount =
          candidate.reconciliation_attempt_count + 1;
        const nextRetryAt = new Date(
          Date.now() +
            closedPaymentReconciliationBackoffMs(nextAttemptCount)
        );
        const claimed = await withTransaction(async (client) => {
          await enableIdentityPaymentWrites(client);
          return client.query<{
            reconciliation_attempt_count: number;
            reconciliation_next_at: Date;
          }>(
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
           RETURNING
             reconciliation_attempt_count,
             reconciliation_next_at`,
          [candidate.attempt_id, nextRetryAt.toISOString()]
          );
        });
        if (!claimed.rowCount) {
          outcomes[candidateIndex] = {
            kind: "deferred",
            reason: "unsafeOrChangedState",
            closedRecovery: true
          };
          return;
        }
        claimToken = {
          attemptCount:
            claimed.rows[0].reconciliation_attempt_count,
          nextAt: claimed.rows[0].reconciliation_next_at
        };
      }
      try {
        const verified = await withPaymentProviderTimeout(
          (signal) => provider.queryPayment(candidate.provider_order_no!, signal),
          providerTimeoutMs
        );
        outcomes[candidateIndex] = {
          kind: "providerQuery",
          candidate,
          claimToken,
          result: { verified }
        };
      } catch {
        outcomes[candidateIndex] = {
          kind: "providerQuery",
          candidate,
          claimToken,
          result: { queryError: true }
        };
      }
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
      if (outcome) providerOutcomes.push(outcome);
    }
  }

  return withTransaction(async (client) => {
    await enableIdentityPaymentWrites(client);
    const recordChangedState = (isClosedRecovery: boolean) => {
      deferredByReason.unsafeOrChangedState += 1;
      if (isClosedRecovery) {
        closedRecovery.changedStateCount += 1;
      }
    };
    const recordTerminal = (
      reason: ClosedRecoveryTerminalReason,
      isClosedRecovery: boolean
    ) => {
      terminalCount += 1;
      if (isClosedRecovery) {
        closedRecovery.terminalCount += 1;
        closedRecovery.terminalByReason[reason] += 1;
      }
    };
    const applyClosedTerminal = async (
      candidate: ReconciliationCandidate,
      reason: ClosedRecoveryTerminalReason
    ) => {
      const terminalResult = {
        deadlineExceeded: "DEADLINE_EXCEEDED",
        noPaymentLimitExceeded: "NO_PAYMENT_LIMIT_EXCEEDED",
        paymentAfterExpiry: "PAYMENT_AFTER_EXPIRY",
        paymentVerificationFailed: "PAYMENT_VERIFICATION_FAILED"
      }[reason];
      const terminal = await client.query(
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
           AND pa.reconciliation_state = $3
           AND pa.reconciliation_attempt_count = $4
           AND pa.reconciliation_no_payment_count = $5
           AND pa.reconciliation_query_error_count = $6
           AND pa.reconciliation_last_result
                 IS NOT DISTINCT FROM $7
           AND EXISTS (
             SELECT 1
             FROM orders o
             WHERE o.id = pa.order_id
               AND o.status = 'CLOSED'
           )`,
        [
          candidate.attempt_id,
          terminalResult,
          candidate.reconciliation_state,
          candidate.reconciliation_attempt_count,
          candidate.reconciliation_no_payment_count,
          candidate.reconciliation_query_error_count,
          candidate.reconciliation_last_result
        ]
      );
      if (terminal.rowCount) {
        recordTerminal(reason, true);
      } else {
        recordChangedState(true);
      }
    };

    for (const outcome of providerOutcomes) {
      if (outcome.kind === "deferred") {
        if (outcome.reason === "unsafeOrChangedState") {
          recordChangedState(outcome.closedRecovery);
        } else {
          deferredByReason[outcome.reason] += 1;
        }
        continue;
      }
      if (outcome.kind === "closedTerminalPrecheck") {
        await applyClosedTerminal(outcome.candidate, outcome.reason);
        continue;
      }

      const candidate = outcome.candidate;
      const isClosedRecovery = candidate.status === "CLOSED";
      const claimToken = outcome.claimToken;
      if ("queryError" in outcome.result) {
        if (isClosedRecovery && claimToken) {
          const updated = await client.query(
            `UPDATE payment_attempts pa
             SET error_code = 'RECONCILIATION_QUERY_FAILED',
                 error_message = '支付渠道查单失败，等待下次重试',
                 reconciliation_no_payment_count = 0,
                 reconciliation_query_error_count =
                   reconciliation_query_error_count + 1,
                 reconciliation_last_result = 'QUERY_ERROR',
                 updated_at = now()
             WHERE pa.id = $1
               AND pa.status = 'CLOSED'
               AND pa.reconciliation_state = 'RETRY_SCHEDULED'
               AND pa.reconciliation_attempt_count = $2
               AND pa.reconciliation_next_at = $3
               AND pa.reconciliation_last_result = 'QUERY_IN_PROGRESS'
               AND EXISTS (
                 SELECT 1
                 FROM orders o
                 WHERE o.id = pa.order_id
                   AND o.status = 'CLOSED'
               )`,
            [
              candidate.attempt_id,
              claimToken.attemptCount,
              claimToken.nextAt.toISOString()
            ]
          );
          if (updated.rowCount) {
            closedRecovery.retryScheduledCount += 1;
            closedRecovery.retryByReason.queryError += 1;
          } else {
            recordChangedState(true);
          }
        } else {
          const updated = await client.query(
            `UPDATE payment_attempts pa
             SET error_code = 'RECONCILIATION_QUERY_FAILED',
                 error_message = '支付渠道查单失败，等待下次重试',
                 updated_at = now()
             WHERE pa.id = $1
               AND pa.status IN (
                 'CREATED',
                 'REDIRECT_READY',
                 'PENDING',
                 'CREATE_UNKNOWN',
                 'RECONCILING',
                 'CLOSE_UNKNOWN'
               )
               AND EXISTS (
                 SELECT 1
                 FROM orders o
                 WHERE o.id = pa.order_id
                   AND o.status IN (
                     'CREATED',
                     'PAYING',
                     'PAYMENT_FAILED'
                   )
               )`,
            [candidate.attempt_id]
          );
          if (updated.rowCount) {
            deferredByReason.providerQueryError += 1;
          } else {
            recordChangedState(false);
          }
        }
        continue;
      }

      const verified = outcome.result.verified;
      if (verified) {
        await client.query(
          "SAVEPOINT reconciliation_paid_apply"
        );
        try {
          const paid = await markOrderPaidInTransaction(
            client,
            {
              orderId: candidate.id,
              paymentAttemptId: candidate.attempt_id!,
              verified
            },
            claimToken
          );
          await client.query(
            "RELEASE SAVEPOINT reconciliation_paid_apply"
          );
          if ("changedState" in paid) {
            recordChangedState(isClosedRecovery);
          } else if ("anomaly" in paid) {
            recordTerminal(
              paid.anomaly === "PAYMENT_AFTER_EXPIRY"
                ? "paymentAfterExpiry"
                : "paymentVerificationFailed",
              isClosedRecovery
            );
          } else {
            providerConfirmedPaidCount += 1;
            if (isClosedRecovery) {
              closedRecovery.recoveredCount += 1;
            }
          }
        } catch (error) {
          const verificationFailed =
            error instanceof CommerceError &&
            error.code === "PAYMENT_VERIFICATION_FAILED";
          await client.query(
            "ROLLBACK TO SAVEPOINT reconciliation_paid_apply"
          );
          await client.query(
            "RELEASE SAVEPOINT reconciliation_paid_apply"
          );
          let updatedOpenAttempt = true;
          if (!isClosedRecovery) {
            const updated = await client.query(
              `UPDATE payment_attempts pa
               SET error_code = $2,
                   error_message = $3,
                   updated_at = now()
               WHERE pa.id = $1
                 AND pa.status IN (
                   'CREATED',
                   'REDIRECT_READY',
                   'PENDING',
                   'CREATE_UNKNOWN',
                   'RECONCILING',
                   'CLOSE_UNKNOWN'
                 )
                 AND EXISTS (
                   SELECT 1
                   FROM orders o
                   WHERE o.id = pa.order_id
                     AND o.status IN (
                       'CREATED',
                       'PAYING',
                       'PAYMENT_FAILED'
                     )
                 )`,
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
            updatedOpenAttempt = Boolean(updated.rowCount);
          }
          if (!updatedOpenAttempt) {
            recordChangedState(false);
            continue;
          }
          deferredByReason[
            verificationFailed
              ? "paymentVerificationFailed"
              : "unsafeOrChangedState"
          ] += 1;
        }
        continue;
      }

      if (isClosedRecovery && claimToken) {
        const updated = await client.query<{
          reconciliation_no_payment_count: number;
          reconciliation_state: "RETRY_SCHEDULED" | "TERMINAL";
        }>(
          `UPDATE payment_attempts pa
           SET reconciliation_no_payment_count =
                 reconciliation_no_payment_count + 1,
               reconciliation_state = CASE
                 WHEN reconciliation_no_payment_count + 1 >= $4
                   THEN 'TERMINAL'
                 ELSE reconciliation_state
               END,
               reconciliation_next_at = CASE
                 WHEN reconciliation_no_payment_count + 1 >= $4
                   THEN NULL
                 ELSE reconciliation_next_at
               END,
               reconciliation_deadline_at = CASE
                 WHEN reconciliation_no_payment_count + 1 >= $4
                   THEN NULL
                 ELSE reconciliation_deadline_at
               END,
               reconciliation_last_result = CASE
                 WHEN reconciliation_no_payment_count + 1 >= $4
                   THEN 'NO_PAYMENT_LIMIT_EXCEEDED'
                 ELSE 'NO_PAYMENT'
               END,
               error_code = NULL,
               error_message = NULL,
               updated_at = now()
           WHERE pa.id = $1
             AND pa.status = 'CLOSED'
             AND pa.reconciliation_state = 'RETRY_SCHEDULED'
             AND pa.reconciliation_attempt_count = $2
             AND pa.reconciliation_next_at = $3
             AND pa.reconciliation_last_result = 'QUERY_IN_PROGRESS'
             AND EXISTS (
               SELECT 1
               FROM orders o
               WHERE o.id = pa.order_id
                 AND o.status = 'CLOSED'
             )
           RETURNING
             reconciliation_no_payment_count,
             reconciliation_state`,
          [
            candidate.attempt_id,
            claimToken.attemptCount,
            claimToken.nextAt.toISOString(),
            closedPaymentReconciliationMaxNoPaymentConfirmations
          ]
        );
        if (!updated.rowCount) {
          recordChangedState(true);
        } else if (
          updated.rows[0].reconciliation_state === "TERMINAL"
        ) {
          recordTerminal("noPaymentLimitExceeded", true);
        } else {
          closedRecovery.retryScheduledCount += 1;
          closedRecovery.retryByReason.noPayment += 1;
        }
        continue;
      }

      const closeCandidate: ExpiredCloseCandidate = {
        id: candidate.id,
        status: candidate.status,
        attemptId: candidate.attempt_id,
        attemptChannel: candidate.attempt_channel
      };
      if (safeToClose.length < limit) {
        safeToClose.push(closeCandidate);
      } else {
        const updated = await client.query(
          `UPDATE payment_attempts
           SET error_code = 'RECONCILIATION_CLOSE_CAPACITY_EXCEEDED',
               error_message = '本轮安全关单容量已满，等待下次处理',
               updated_at = now()
           WHERE id = $1
             AND status IN (
               'CREATED',
               'REDIRECT_READY',
               'PENDING',
               'CREATE_UNKNOWN',
               'RECONCILING',
               'CLOSE_UNKNOWN'
             )`,
          [candidate.attempt_id]
        );
        if (updated.rowCount) {
          deferredByReason.closeCapacityExceeded += 1;
        } else {
          recordChangedState(false);
        }
      }
    }

    const closedOrderIds =
      await closeExpiredCandidatesInTransaction(client, safeToClose);
    deferredByReason.unsafeOrChangedState +=
      safeToClose.length - closedOrderIds.length;
    const moreCandidates = await client.query<{ has_more: boolean }>(
      `SELECT EXISTS (
         SELECT 1
         FROM (
           (
             SELECT o.id
             FROM orders o
             WHERE o.expires_at <= now()
               AND o.status = 'CREATED'
               AND NOT EXISTS (
                 SELECT 1
                 FROM payment_attempts
                 WHERE payment_attempts.order_id = o.id
               )
             LIMIT 1
           )
           UNION ALL
           (
             SELECT o.id
             FROM orders o
             JOIN LATERAL (
               SELECT attempt.status
               FROM payment_attempts attempt
               WHERE attempt.order_id = o.id
               ORDER BY attempt.created_at DESC, attempt.id DESC
               LIMIT 1
             ) latest ON true
             WHERE o.expires_at <= now()
               AND o.status IN ('CREATED', 'PAYING', 'PAYMENT_FAILED')
               AND latest.status = 'FAILED'
               AND NOT EXISTS (
                 SELECT 1
                 FROM payment_attempts unresolved
                 WHERE unresolved.order_id = o.id
                   AND (
                     unresolved.status IN (
                       'CREATED',
                       'REDIRECT_READY',
                       'PENDING',
                       'CREATE_UNKNOWN',
                       'RECONCILING',
                       'CLOSE_UNKNOWN'
                     )
                     OR unresolved.reconciliation_state IN (
                       'REQUIRED',
                       'RETRY_SCHEDULED'
                     )
                   )
               )
             LIMIT 1
           )
           UNION ALL
           (
             SELECT o.id
             FROM orders o
             JOIN LATERAL (
               SELECT attempt.id
               FROM payment_attempts attempt
               JOIN provider_payment_orders identity
                 ON identity.id = attempt.provider_payment_order_id
               WHERE attempt.order_id = o.id
                 AND attempt.channel = $1
                 AND attempt.provider_identity_role = 'canonical_owner'
                 AND attempt.provider_operation_eligible
                 AND identity.canonical_attempt_id = attempt.id
                 AND attempt.status IN (
                   'CREATED',
                   'REDIRECT_READY',
                   'PENDING',
                   'CREATE_UNKNOWN',
                   'RECONCILING',
                   'CLOSE_UNKNOWN'
                 )
               ORDER BY attempt.created_at DESC, attempt.id DESC
               LIMIT 1
             ) channel_attempt ON true
             WHERE $1::text IS NOT NULL
               AND o.expires_at <= now()
               AND o.status IN ('CREATED', 'PAYING', 'PAYMENT_FAILED')
             LIMIT 1
           )
           UNION ALL
           (
             SELECT attempt.order_id
             FROM payment_attempts attempt
             JOIN orders o ON o.id = attempt.order_id
             JOIN provider_payment_orders identity
               ON identity.id = attempt.provider_payment_order_id
             WHERE $1::text IS NOT NULL
               AND attempt.channel = $1
               AND attempt.provider_identity_role = 'canonical_owner'
               AND attempt.provider_operation_eligible
               AND identity.canonical_attempt_id = attempt.id
               AND attempt.reconciliation_state IN (
                 'REQUIRED',
                 'RETRY_SCHEDULED'
               )
               AND (
                 attempt.reconciliation_next_at <= now()
                 OR attempt.reconciliation_deadline_at <= now()
               )
               AND o.status = 'CLOSED'
             LIMIT 1
           )
         ) due_candidates
       ) AS has_more`,
      [providerChannel]
    );
    const scheduledRecovery = await client.query<{ count: number }>(
      `SELECT count(*)::integer AS count
       FROM payment_attempts attempt
       JOIN orders o ON o.id = attempt.order_id
       JOIN provider_payment_orders identity
         ON identity.id = attempt.provider_payment_order_id
       WHERE $1::text IS NOT NULL
         AND attempt.channel = $1
         AND attempt.provider_identity_role = 'canonical_owner'
         AND attempt.provider_operation_eligible
         AND identity.canonical_attempt_id = attempt.id
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
      terminalCount,
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

const preparePayment = async (
  userId: string,
  orderId: string,
  productChannel: OrderProductChannel,
  provider: PaymentProvider
): Promise<PreparedPayment> =>
  withTransaction(async (client) => {
    if (provider.channel !== "wechat_h5" && provider.channel !== "alipay_wap") {
      throw new CommerceError("PAYMENT_PROVIDER_FAILED");
    }
    await enableIdentityPaymentWrites(client);
    await client.query("SET CONSTRAINTS ALL DEFERRED");
    const generation = crypto.randomUUID();
    const selected = await client.query<OrderRow>(
      `${orderSelect}
       WHERE o.id = $1
         AND o.user_id = $2
         AND o.product_channel = $3
       FOR UPDATE OF o`,
      [orderId, userId, productChannel]
    );
    const row = selected.rows[0];
    if (!row) throw new CommerceError("ORDER_NOT_FOUND");
    const attempts = await client.query<{
      id: string;
      status: string;
      launch_url: string | null;
      launch_expires_at: Date | null;
      updated_at: Date;
      channel: PaymentChannel;
      provider_order_no: string;
    }>(
      `SELECT attempt.id,
              attempt.status,
              attempt.launch_url,
              attempt.launch_expires_at,
              attempt.updated_at,
              attempt.channel,
              identity.provider_order_no
         FROM payment_attempts attempt
         JOIN provider_payment_orders identity
           ON identity.id = attempt.provider_payment_order_id
        WHERE attempt.order_id = $1
          AND attempt.provider_identity_role = 'canonical_owner'
          AND attempt.provider_operation_eligible
          AND identity.canonical_attempt_id = attempt.id
          AND (
            attempt.status IN (
              'CREATED', 'REDIRECT_READY', 'PENDING', 'CREATE_UNKNOWN',
              'RECONCILING', 'CLOSE_UNKNOWN'
            )
            OR attempt.reconciliation_state IN ('REQUIRED', 'RETRY_SCHEDULED')
          )
        ORDER BY attempt.created_at DESC, attempt.id DESC
        FOR UPDATE OF attempt, identity`,
      [row.id]
    );
    const active = attempts.rows[0];
    if (active && active.channel !== provider.channel) {
      throw new CommerceError("PAYMENT_CHANNEL_LOCKED");
    }
    if (active?.status === "CREATED") {
      if (active.updated_at.getTime() > Date.now() - 120_000) {
        throw new CommerceError("PAYMENT_INITIALIZING");
      }
      await client.query(
        `UPDATE payment_attempts
         SET status = 'CREATE_UNKNOWN',
             error_code = 'PAYMENT_ATTEMPT_STALE',
             error_message = '支付初始化状态不明，等待同号查单',
             updated_at = now()
         WHERE id = $1`,
        [active.id]
      );
    }
    if (row.expires_at.getTime() <= Date.now()) {
      if (active) {
        return {
          attemptId: active.id,
          generation: "",
          providerOrderNo: active.provider_order_no,
          recovery: {
            providerOrderNo: active.provider_order_no,
            status:
              active.status === "CREATED" ? "CREATE_UNKNOWN" : active.status
          },
          order: mapOrder(row)
        };
      }
      if (!["CREATED", "PAYING", "PAYMENT_FAILED"].includes(row.status)) {
        throw new CommerceError("ORDER_STATE_CONFLICT");
      }
      await client.query(
        `UPDATE orders
         SET status = 'CLOSED',
             closed_at = now(),
             updated_at = now()
         WHERE id = $1`,
        [row.id]
      );
      return { expired: true };
    }
    if (
      active &&
      ["CREATED", "PAYING", "PAYMENT_FAILED"].includes(row.status) &&
      ["REDIRECT_READY", "PENDING"].includes(active.status) &&
      active.launch_url &&
      active.launch_expires_at &&
      active.launch_expires_at.getTime() > Date.now()
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
        },
        providerOrderNo: active.provider_order_no
      };
    }

    if (active) {
      return {
        attemptId: active.id,
        generation: "",
        providerOrderNo: active.provider_order_no,
        recovery: {
          providerOrderNo: active.provider_order_no,
          status: active.status === "CREATED" ? "CREATE_UNKNOWN" : active.status
        },
        order: mapOrder(row)
      };
    }

    if (!["CREATED", "PAYING", "PAYMENT_FAILED"].includes(row.status)) {
      throw new CommerceError("ORDER_STATE_CONFLICT");
    }

    const attemptId = crypto.randomUUID();
    const providerPaymentOrderId = crypto.randomUUID();
    const providerOrderNo = makeProviderOrderNo(provider.channel);
    await client.query(
      `INSERT INTO provider_payment_orders(
         id, order_id, channel, provider_order_no, origin, allocated_at,
         canonical_attempt_id, manual_review_required
       ) VALUES ($1, $2, $3, $4, 'attempt_v1', now(), $5, false)`,
      [providerPaymentOrderId, row.id, provider.channel, providerOrderNo, attemptId]
    );
    const attempt = await client.query<{ id: string }>(
      `INSERT INTO payment_attempts(
         id, order_id, channel, status, provider_payment_order_id,
         provider_identity_role, provider_operation_eligible, request_snapshot
       ) VALUES (
         $1, $2, $3, 'CREATED', $4, 'canonical_owner', true,
         jsonb_build_object(
           'orderNo', $5::text,
           'providerOrderNo', $6::text,
           'amountFen', $7::text,
           'currency', $8::text,
           'generation', $9::text
         )
       )
       RETURNING id`,
      [
        attemptId,
        row.id,
        provider.channel,
        providerPaymentOrderId,
        row.order_no,
        providerOrderNo,
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
      providerOrderNo,
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
    productChannel: OrderProductChannel;
    provider: PaymentProvider;
    clientIp: string;
    returnUrl: string;
    notifyUrl: string;
    providerTimeoutMs?: number;
  }
): Promise<PaymentStartResult> => {
  const userId = requireUuid(input.userId);
  const orderId = requireUuid(input.orderId);
  const productChannel = requireChannel(input.productChannel);
  const providerTimeoutMs = input.providerTimeoutMs ?? 15_000;
  if (
    !Number.isInteger(providerTimeoutMs) ||
    providerTimeoutMs < 1 ||
    providerTimeoutMs > 60_000
  ) {
    throw new CommerceError("INVALID_COMMERCE_INPUT");
  }
  const prepared = await preparePayment(
    userId,
    orderId,
    productChannel,
    input.provider
  );
  if (prepared.expired) {
    throw new CommerceError("ORDER_EXPIRED");
  }
  if (prepared.existing) return prepared.existing;
  if (prepared.recovery) {
    let verified: VerifiedPayment | null;
    try {
      verified = await withPaymentProviderTimeout(
        (signal) =>
          input.provider.queryPayment(
            prepared.recovery!.providerOrderNo,
            signal
          ),
        providerTimeoutMs
      );
    } catch {
      throw new CommerceError("PAYMENT_PROVIDER_FAILED");
    }
    if (verified) {
      const completed = await markOrderPaid({
        orderId: prepared.order.id,
        paymentAttemptId: prepared.attemptId,
        verified
      });
      return {
        orderId: completed.id,
        orderNo: completed.orderNo,
        status: completed.status,
        paymentAttemptId: prepared.attemptId,
        launchUrl: input.returnUrl,
        expiresAt: completed.expiresAt
      };
    }
    throw new CommerceError(
      prepared.recovery.status === "CREATE_UNKNOWN"
        ? "PAYMENT_INITIALIZING"
        : "PAYMENT_CHANNEL_LOCKED"
    );
  }

  try {
    const created = await withPaymentProviderTimeout(
      (signal) =>
        input.provider.createPayment({
          attemptId: prepared.attemptId,
          orderNo: prepared.order.orderNo,
          providerOrderNo: prepared.providerOrderNo,
          description: prepared.order.productName,
          amountFen: prepared.order.amountFen,
          clientIp: input.clientIp,
          returnUrl: input.returnUrl,
          notifyUrl: input.notifyUrl,
          expiresAt: prepared.order.expiresAt.toISOString(),
          signal
        }),
      providerTimeoutMs
    );
    if (!created.launchUrl.trim()) {
      throw new Error("Provider returned an empty launch URL");
    }
    const providerLaunchExpiry = created.launchExpiresAt
      ? new Date(created.launchExpiresAt)
      : undefined;
    const channelLaunchDeadline = new Date(
      Math.min(
        prepared.order.expiresAt.getTime(),
        input.provider.channel === "wechat_h5"
          ? Date.now() + 5 * 60_000
          : prepared.order.expiresAt.getTime()
      )
    );
    const launchExpiresAt =
      providerLaunchExpiry &&
      !Number.isNaN(providerLaunchExpiry.getTime())
        ? new Date(
            Math.min(
              providerLaunchExpiry.getTime(),
              channelLaunchDeadline.getTime()
            )
          )
        : channelLaunchDeadline;
    if (launchExpiresAt.getTime() <= Date.now()) {
      throw new Error("Provider returned an expired launch URL");
    }
    return withTransaction(async (client) => {
      await enableIdentityPaymentWrites(client);
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
             launch_expires_at = $4,
             response_snapshot = $5::jsonb,
             updated_at = now()
         WHERE id = $1
           AND status = 'CREATED'
           AND request_snapshot->>'generation' = $6`,
        [
          prepared.attemptId,
          created.prepayId ?? null,
          created.launchUrl,
          launchExpiresAt.toISOString(),
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
      await enableIdentityPaymentWrites(client);
      await client.query(
        `UPDATE payment_attempts
            SET status = 'CREATE_UNKNOWN',
                error_code = $3,
                error_message = '支付创建结果不明，等待使用原商户单号查单',
                updated_at = now()
          WHERE id = $1
            AND status = 'CREATED'
            AND request_snapshot->>'generation' = $2`,
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
  productChannel: OrderProductChannel;
  title: string;
  taxNumber?: string;
  email: string;
}) => {
  const userId = requireUuid(input.userId);
  const orderId = requireUuid(input.orderId);
  const productChannel = requireChannel(input.productChannel);
  return withTransaction(async (client) => {
    const order = await client.query<{ status: OrderStatus }>(
      `SELECT status
       FROM orders
       WHERE id = $1
         AND user_id = $2
         AND product_channel = $3
       FOR UPDATE`,
      [orderId, userId, productChannel]
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
