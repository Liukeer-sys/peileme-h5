import { randomUUID } from "node:crypto";
import type pg from "pg";
import { query, withTransaction } from "../../db.js";
import { createOrder } from "../../modules/commerce/orders.js";
import { enableIdentityPaymentWrites } from "../../modules/payments/write-contract.js";
import { seedPolicyFoundation } from "../../modules/policy/seed.js";

export type RealPaymentChannel = "wechat_h5" | "alipay_wap";

export class ScriptedRealPaymentProvider {
  readonly createInputs: Array<Record<string, unknown>> = [];
  readonly queryProviderOrderNos: string[] = [];
  createError: Error | undefined;
  queryResult: Record<string, unknown> | null = null;
  launchLifetimeMs = 5 * 60_000;

  constructor(readonly channel: RealPaymentChannel) {}

  async createPayment(input: Record<string, unknown>) {
    this.createInputs.push(input);
    if (this.createError) throw this.createError;
    const providerOrderNo = String(input.providerOrderNo ?? "");
    return {
      prepayId: `scripted-${providerOrderNo}`,
      launchUrl: `https://payments.test/${this.channel}/${providerOrderNo}`,
      launchExpiresAt: new Date(
        Date.now() + this.launchLifetimeMs
      ).toISOString(),
      response: { scripted: true, providerOrderNo }
    };
  }

  async queryPayment(
    input: string | { providerOrderNo: string; signal: AbortSignal },
    _legacySignal?: AbortSignal
  ) {
    const providerOrderNo =
      typeof input === "string" ? input : input.providerOrderNo;
    this.queryProviderOrderNos.push(providerOrderNo);
    return this.queryResult;
  }

  async refund(input: Record<string, unknown>) {
    return {
      channelRefundId: `scripted-refund-${String(input.providerRefundNo ?? "")}`,
      raw: { scripted: true }
    };
  }
}

export const paymentWriteQuery = <Row extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  values?: unknown[]
) =>
  withTransaction(async (client) => {
    await enableIdentityPaymentWrites(client);
    return client.query<Row>(text, values);
  });

export const insertIdentityAwarePaymentAttempt = async (input: {
  orderId: string;
  channel?: RealPaymentChannel;
  status: string;
  providerOrderNo?: string;
  origin?: "attempt_v1" | "legacy_order_no";
  launchUrl?: string | null;
  launchExpiresAt?: Date | string | null;
  requestSnapshot?: Record<string, unknown>;
  reconciliationState?: string;
  reconciliationNextAt?: Date | string | null;
  reconciliationDeadlineAt?: Date | string | null;
  reconciliationLastResult?: string | null;
  createdAt?: Date | string;
}) =>
  withTransaction(async (client) => {
    await client.query("SET CONSTRAINTS ALL DEFERRED");
    await enableIdentityPaymentWrites(client);
    const channel = input.channel ?? "wechat_h5";
    const attemptId = randomUUID();
    const identityId = randomUUID();
    const providerOrderNo =
      input.providerOrderNo ??
      `${channel === "wechat_h5" ? "WX" : "AL"}${randomUUID()
        .replaceAll("-", "")
        .slice(0, 28)
        .toUpperCase()}`;
    await client.query(
      `INSERT INTO provider_payment_orders(
         id, order_id, channel, provider_order_no, origin, allocated_at,
         canonical_attempt_id, manual_review_required
       ) VALUES (
         $1, $2, $3, $4, $5, COALESCE($6::timestamptz, now()),
         $7, false
       )`,
      [
        identityId,
        input.orderId,
        channel,
        providerOrderNo,
        input.origin ?? "attempt_v1",
        input.createdAt ?? null,
        attemptId
      ]
    );
    const snapshot = {
      ...(input.requestSnapshot ?? {}),
      providerOrderNo
    };
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO payment_attempts(
         id, order_id, channel, status, provider_payment_order_id,
         provider_identity_role, provider_operation_eligible,
         launch_url, launch_expires_at, request_snapshot,
         reconciliation_state, reconciliation_next_at,
         reconciliation_deadline_at, reconciliation_last_result,
         created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, 'canonical_owner', true,
         $6, $7, $8::jsonb, COALESCE($9, 'NONE'), $10, $11, $12,
         COALESCE($13::timestamptz, now()), COALESCE($13::timestamptz, now())
       )
       RETURNING id`,
      [
        attemptId,
        input.orderId,
        channel,
        input.status,
        identityId,
        input.launchUrl ?? null,
        input.launchExpiresAt ?? null,
        JSON.stringify(snapshot),
        input.reconciliationState ?? null,
        input.reconciliationNextAt ?? null,
        input.reconciliationDeadlineAt ?? null,
        input.reconciliationLastResult ?? null,
        input.createdAt ?? null
      ]
    );
    return {
      id: inserted.rows[0].id,
      providerPaymentOrderId: identityId,
      providerOrderNo,
      channel
    };
  });

export const createIdentityPaymentOrder = async (
  channel: "main" | "ai" = "main"
) => {
  await seedPolicyFoundation();
  const marker = randomUUID().replaceAll("-", "");
  const user = await query<{ id: string }>(
    `INSERT INTO users(email, email_verified_at)
     VALUES ($1, now())
     RETURNING id`,
    [`identity-payment-${marker}@peileme.test`]
  );
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
       $2,
       $3,
       'in_progress',
       'awaiting_entitlement',
       '{"facts":{}}'::jsonb,
       $4,
       '{}'::jsonb
     )
     RETURNING id`,
    [user.rows[0].id, `visitor-${marker}`, `session-${marker}`, channel]
  );
  const order = await createOrder({
    userId: user.rows[0].id,
    sku: channel === "main" ? "POLICY_CALC" : "AI_SEVERANCE_ANALYSIS",
    channel,
    idempotencyKey: `identity-payment-${marker}`,
    businessDraftId: draft.rows[0].id
  });
  return {
    userId: user.rows[0].id,
    draftId: draft.rows[0].id,
    order
  };
};

export const cleanupIdentityPaymentOrders = async (
  fixtures: Array<{
    userId: string;
    draftId: string;
    order: { id: string };
  }>
) => {
  if (!fixtures.length) return;
  const orderIds = fixtures.map(({ order }) => order.id);
  const userIds = fixtures.map(({ userId }) => userId);
  await query("DELETE FROM refunds WHERE order_id = ANY($1::uuid[])", [orderIds]);
  await query(
    "DELETE FROM payment_transactions WHERE order_id = ANY($1::uuid[])",
    [orderIds]
  );
  await query("DELETE FROM payment_anomalies WHERE order_id = ANY($1::uuid[])", [
    orderIds
  ]);
  await query("DELETE FROM entitlements WHERE user_id = ANY($1::uuid[])", [
    userIds
  ]);
  await query("DELETE FROM orders WHERE id = ANY($1::uuid[])", [orderIds]);
  await query("DELETE FROM assessments WHERE id = ANY($1::uuid[])", [
    fixtures.map(({ draftId }) => draftId)
  ]);
  await query("DELETE FROM users WHERE id = ANY($1::uuid[])", [userIds]);
};
