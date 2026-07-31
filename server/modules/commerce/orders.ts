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

const assertOwnedPolicyDraft = async (
  client: pg.PoolClient,
  userId: string,
  sku: ProductSku,
  businessDraftId?: string
) => {
  if (sku !== "POLICY_CALC") return;
  if (!businessDraftId) {
    throw new CommerceError("BUSINESS_DRAFT_NOT_FOUND");
  }
  const draft = await client.query<{
    user_id: string | null;
    product_channel: string;
  }>(
    `SELECT user_id, product_channel
     FROM assessments
     WHERE id = $1
     FOR SHARE`,
    [businessDraftId]
  );
  if (
    draft.rows[0]?.user_id !== userId ||
    draft.rows[0]?.product_channel !== "main"
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

    await assertOwnedPolicyDraft(
      client,
      userId,
      sku,
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
      !["CREATED", "PAYING", "PAYMENT_FAILED"].includes(order.status)
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
           updated_at = now()
       WHERE id = $1`,
      [selectedAttempt.id]
    );
    await client.query(
      `UPDATE orders
       SET status = 'PAID',
           paid_at = $2,
           updated_at = now()
       WHERE id = $1`,
      [order.id, paidAt.toISOString()]
    );

    const grantCount = parseGrantCount(order.entitlement_policy);
    await client.query(
      `UPDATE orders
       SET status = 'FULFILLING',
           updated_at = now()
       WHERE id = $1`,
      [order.id]
    );
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
    const completed = await client.query<OrderRow>(
      `${orderSelect}
       WHERE o.id = $1
       FOR UPDATE OF o`,
      [order.id]
    );
    const finalState = await client.query<{ updated_at: Date }>(
      `UPDATE orders
       SET status = 'COMPLETED',
           completed_at = now(),
           updated_at = now()
       WHERE id = $1
       RETURNING updated_at`,
      [order.id]
    );
    return {
      ...mapOrder(completed.rows[0]),
      status: "COMPLETED",
      updatedAt: finalState.rows[0].updated_at
    };
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

export const closeExpiredOrders = async () => {
  return withTransaction(async (client) => {
    const expired = await client.query<{ id: string }>(
      `SELECT id
       FROM orders
       WHERE expires_at <= now()
         AND status IN ('CREATED', 'PAYING')
       ORDER BY expires_at, id
       FOR UPDATE SKIP LOCKED`
    );
    const orderIds = expired.rows.map((row) => row.id);
    if (!orderIds.length) return [];
    await client.query(
      `UPDATE payment_attempts
       SET status = 'CLOSED',
           updated_at = now()
       WHERE order_id = ANY($1::uuid[])
         AND status IN ('CREATED', 'REDIRECT_READY', 'PENDING')`,
      [orderIds]
    );
    const result = await client.query<{ id: string }>(
      `UPDATE orders
       SET status = 'CLOSED',
           closed_at = now(),
           updated_at = now()
       WHERE id = ANY($1::uuid[])
         AND status IN ('CREATED', 'PAYING')
       RETURNING id`,
      [orderIds]
    );
    return result.rows.map((row) => row.id);
  });
};

export type PaymentStartResult = {
  orderId: string;
  orderNo: string;
  status: OrderStatus;
  paymentAttemptId: string;
  launchUrl: string;
  expiresAt: Date;
};

type PreparedPayment = {
  existing?: PaymentStartResult;
  attemptId: string;
  generation: string;
  order: CommerceOrder;
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
          `UPDATE orders
           SET status = 'CLOSED',
               closed_at = now(),
               updated_at = now()
           WHERE id = $1`,
          [row.id]
        );
      }
      throw new CommerceError("ORDER_EXPIRED");
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
  }
): Promise<PaymentStartResult> => {
  const userId = requireUuid(input.userId);
  const orderId = requireUuid(input.orderId);
  const prepared = await preparePayment(
    userId,
    orderId,
    input.provider
  );
  if (prepared.existing) return prepared.existing;

  try {
    const created = await input.provider.createPayment({
      attemptId: prepared.attemptId,
      orderNo: prepared.order.orderNo,
      description: prepared.order.productName,
      amountFen: prepared.order.amountFen,
      clientIp: input.clientIp,
      returnUrl: input.returnUrl,
      notifyUrl: input.notifyUrl
    });
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
    await withTransaction(async (client) => {
      await client.query(
        `WITH failed_attempt AS (
           UPDATE payment_attempts
           SET status = 'FAILED',
               error_code = 'PAYMENT_PROVIDER_FAILED',
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
        [prepared.attemptId, prepared.generation]
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
       ON CONFLICT (user_id, order_id)
       DO UPDATE SET user_id = EXCLUDED.user_id
       RETURNING id, status, created_at`,
      [
        userId,
        orderId,
        input.title,
        input.taxNumber ?? null,
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
