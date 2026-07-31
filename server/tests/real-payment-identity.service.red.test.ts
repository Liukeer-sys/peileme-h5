import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, query, withTransaction } from "../db.js";
import { runMigrations } from "../migrate.js";
import {
  markOrderPaid,
  reconcileAndCloseExpiredOrders,
  startPayment
} from "../modules/commerce/orders.js";
import { enableIdentityPaymentWrites } from "../modules/payments/write-contract.js";
import {
  cleanupIdentityPaymentOrders,
  createIdentityPaymentOrder,
  ScriptedRealPaymentProvider
} from "./helpers/identity-payment.js";

beforeAll(async () => {
  await runMigrations();
});

afterAll(async () => {
  await closePool();
});

const start = (
  fixture: Awaited<ReturnType<typeof createIdentityPaymentOrder>>,
  provider: ScriptedRealPaymentProvider,
  providerTimeoutMs = 500
) =>
  startPayment({
    userId: fixture.userId,
    orderId: fixture.order.id,
    productChannel: fixture.order.channel,
    provider: provider as never,
    clientIp: "203.0.113.8",
    returnUrl: `https://peileme.art/orders/${fixture.order.id}`,
    notifyUrl: `https://peileme.art/api/payments/${provider.channel}/notify`,
    providerTimeoutMs
  });

describe("Task 4 identity-aware payment service (RED)", () => {
  it("creates attempt_v1 identity and attempt atomically with a provider number distinct from order_no", async () => {
    const fixture = await createIdentityPaymentOrder();
    const provider = new ScriptedRealPaymentProvider("wechat_h5");
    try {
      const result = await start(fixture, provider);
      const persisted = await query<{
        order_no: string;
        provider_order_no: string;
        origin: string;
        canonical_attempt_id: string;
        attempt_id: string;
        provider_identity_role: string;
        provider_operation_eligible: boolean;
        snapshot_provider_order_no: string;
      }>(
        `SELECT o.order_no,
                identity.provider_order_no,
                identity.origin,
                identity.canonical_attempt_id,
                attempt.id AS attempt_id,
                attempt.provider_identity_role,
                attempt.provider_operation_eligible,
                attempt.request_snapshot->>'providerOrderNo'
                  AS snapshot_provider_order_no
           FROM payment_attempts attempt
           JOIN provider_payment_orders identity
             ON identity.id = attempt.provider_payment_order_id
           JOIN orders o ON o.id = attempt.order_id
          WHERE attempt.id = $1`,
        [result.paymentAttemptId]
      );
      expect(persisted.rows[0]).toMatchObject({
        origin: "attempt_v1",
        canonical_attempt_id: result.paymentAttemptId,
        attempt_id: result.paymentAttemptId,
        provider_identity_role: "canonical_owner",
        provider_operation_eligible: true
      });
      expect(persisted.rows[0].provider_order_no).not.toBe(
        persisted.rows[0].order_no
      );
      expect(persisted.rows[0].snapshot_provider_order_no).toBe(
        persisted.rows[0].provider_order_no
      );
      expect(provider.createInputs[0]?.providerOrderNo).toBe(
        persisted.rows[0].provider_order_no
      );
    } finally {
      await cleanupIdentityPaymentOrders([fixture]);
    }
  });

  it("keeps CREATE_UNKNOWN locked and queries the same provider number after a create timeout", async () => {
    const fixture = await createIdentityPaymentOrder();
    const provider = new ScriptedRealPaymentProvider("wechat_h5");
    provider.createError = new Error("socket disconnected after dispatch");
    try {
      await expect(start(fixture, provider)).rejects.toMatchObject({
        code: "PAYMENT_PROVIDER_FAILED"
      });
      const first = await query<{
        id: string;
        status: string;
        provider_order_no: string;
      }>(
        `SELECT attempt.id, attempt.status, identity.provider_order_no
           FROM payment_attempts attempt
           JOIN provider_payment_orders identity
             ON identity.id = attempt.provider_payment_order_id
          WHERE attempt.order_id = $1`,
        [fixture.order.id]
      );
      expect(first.rows).toHaveLength(1);
      expect(first.rows[0].status).toBe("CREATE_UNKNOWN");

      provider.createError = undefined;
      await expect(start(fixture, provider)).rejects.toMatchObject({
        code: expect.stringMatching(/PAYMENT_(?:INITIALIZING|CHANNEL_LOCKED)/)
      });
      expect(provider.createInputs).toHaveLength(1);
      expect(provider.queryProviderOrderNos).toEqual([
        first.rows[0].provider_order_no
      ]);
    } finally {
      await cleanupIdentityPaymentOrders([fixture]);
    }
  });

  it("claims only canonical eligible real identities for reconciliation", async () => {
    const fixture = await createIdentityPaymentOrder();
    const provider = new ScriptedRealPaymentProvider("wechat_h5");
    const providerOrderNo = `WX${randomUUID().replaceAll("-", "").slice(0, 28)}`;
    const identityId = randomUUID();
    const ownerId = randomUUID();
    const aliasId = randomUUID();
    try {
      await withTransaction(async (client) => {
        await client.query("SET CONSTRAINTS ALL DEFERRED");
        await enableIdentityPaymentWrites(client);
        await client.query(
          `UPDATE orders
              SET status = 'CLOSED',
                  created_at = now() - interval '3 minutes',
                  expires_at = now() - interval '1 minute',
                  closed_at = now()
            WHERE id = $1`,
          [fixture.order.id]
        );
        await client.query(
          `INSERT INTO provider_payment_orders(
             id, order_id, channel, provider_order_no, origin,
             allocated_at, canonical_attempt_id, manual_review_required
           ) VALUES ($1, $2, 'wechat_h5', $3, 'legacy_order_no', now(), $4, false)`,
          [identityId, fixture.order.id, providerOrderNo, ownerId]
        );
        await client.query(
          `INSERT INTO payment_attempts(
             id, order_id, channel, status, provider_payment_order_id,
             provider_identity_role, provider_operation_eligible,
             request_snapshot, reconciliation_state,
             reconciliation_next_at, reconciliation_deadline_at,
             reconciliation_last_result
           ) VALUES (
             $1, $2, 'wechat_h5', 'CLOSED', $3, 'canonical_owner', true,
             jsonb_build_object('providerOrderNo', $4::text), 'REQUIRED',
             now() - interval '1 second', now() + interval '1 hour',
             'LOCAL_CLOSE_PENDING_FINAL_QUERY'
           )`,
          [ownerId, fixture.order.id, identityId, providerOrderNo]
        );
        await client.query(
          `INSERT INTO payment_attempts(
             id, order_id, channel, status, provider_payment_order_id,
             provider_identity_role, provider_operation_eligible,
             request_snapshot, reconciliation_state,
             reconciliation_last_result
           ) VALUES (
             $1, $2, 'wechat_h5', 'CLOSED', $3, 'audit_alias', false,
             jsonb_build_object('providerOrderNo', $4::text), 'TERMINAL',
             'LEGACY_PROVIDER_IDENTITY_ALIAS'
           )`,
          [aliasId, fixture.order.id, identityId, providerOrderNo]
        );
      });

      await reconcileAndCloseExpiredOrders({
        provider: provider as never,
        providerTimeoutMs: 500,
        limit: 10
      });
      expect(provider.queryProviderOrderNos).toEqual([providerOrderNo]);
    } finally {
      await cleanupIdentityPaymentOrders([fixture]);
    }
  });

  it("permits only one active attempt when two real channels start concurrently", async () => {
    const fixture = await createIdentityPaymentOrder();
    const wechat = new ScriptedRealPaymentProvider("wechat_h5");
    const alipay = new ScriptedRealPaymentProvider("alipay_wap");
    try {
      const outcomes = await Promise.allSettled([
        start(fixture, wechat),
        start(fixture, alipay)
      ]);
      expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
      expect(outcomes.filter(({ status }) => status === "rejected")).toHaveLength(1);
      const active = await query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM payment_attempts
          WHERE order_id = $1
            AND status IN (
              'CREATED', 'REDIRECT_READY', 'PENDING', 'CREATE_UNKNOWN',
              'RECONCILING', 'CLOSE_UNKNOWN'
            )`,
        [fixture.order.id]
      );
      expect(active.rows).toEqual([{ count: "1" }]);
      expect(wechat.createInputs.length + alipay.createInputs.length).toBe(1);
    } finally {
      await cleanupIdentityPaymentOrders([fixture]);
    }
  });

  it("keeps an attempt_v1 owner locked when a legacy writer tries to mark it FAILED", async () => {
    const fixture = await createIdentityPaymentOrder();
    const wechat = new ScriptedRealPaymentProvider("wechat_h5");
    const alipay = new ScriptedRealPaymentProvider("alipay_wap");
    try {
      const started = await start(fixture, wechat);
      await expect(
        withTransaction(async (client) => {
          await enableIdentityPaymentWrites(client);
          await client.query(
            "UPDATE payment_attempts SET status = 'FAILED' WHERE id = $1",
            [started.paymentAttemptId]
          );
        })
      ).rejects.toMatchObject({
        code: "23514",
        constraint: "payment_attempts_attempt_v1_failed_forbidden"
      });
      await expect(start(fixture, alipay)).rejects.toMatchObject({
        code: "PAYMENT_CHANNEL_LOCKED"
      });
      expect(alipay.createInputs).toHaveLength(0);
      const persisted = await query<{ status: string }>(
        "SELECT status FROM payment_attempts WHERE id = $1",
        [started.paymentAttemptId]
      );
      expect(persisted.rows).toEqual([{ status: "REDIRECT_READY" }]);
    } finally {
      await cleanupIdentityPaymentOrders([fixture]);
    }
  });

  it("reuses a launch URL only while launch_expires_at is in the future", async () => {
    const fixture = await createIdentityPaymentOrder();
    const provider = new ScriptedRealPaymentProvider("wechat_h5");
    try {
      const first = await start(fixture, provider);
      const reused = await start(fixture, provider);
      expect(reused.launchUrl).toBe(first.launchUrl);
      expect(provider.createInputs).toHaveLength(1);

      await withTransaction(async (client) => {
        await enableIdentityPaymentWrites(client);
        await client.query(
          `UPDATE payment_attempts
              SET launch_expires_at = now() - interval '1 second'
            WHERE id = $1`,
          [first.paymentAttemptId]
        );
      });
      await expect(start(fixture, provider)).rejects.toMatchObject({
        code: "PAYMENT_CHANNEL_LOCKED"
      });
      expect(provider.createInputs).toHaveLength(1);
    } finally {
      await cleanupIdentityPaymentOrders([fixture]);
    }
  });

  it("matches verified payment by providerOrderNo instead of the business order number", async () => {
    const fixture = await createIdentityPaymentOrder();
    const provider = new ScriptedRealPaymentProvider("alipay_wap");
    try {
      const started = await start(fixture, provider);
      const identity = await query<{ provider_order_no: string }>(
        `SELECT identity.provider_order_no
           FROM payment_attempts attempt
           JOIN provider_payment_orders identity
             ON identity.id = attempt.provider_payment_order_id
          WHERE attempt.id = $1`,
        [started.paymentAttemptId]
      );
      const completed = await markOrderPaid({
        orderId: fixture.order.id,
        paymentAttemptId: started.paymentAttemptId,
        verified: {
          providerOrderNo: identity.rows[0].provider_order_no,
          channel: "alipay_wap",
          channelTransactionId: `ALI-${randomUUID()}`,
          amountFen: fixture.order.amountFen,
          currency: "CNY",
          paidAt: new Date().toISOString(),
          raw: { scripted: true }
        } as never
      });
      expect(completed.status).toBe("COMPLETED");
      expect(identity.rows[0].provider_order_no).not.toBe(fixture.order.orderNo);
    } finally {
      await cleanupIdentityPaymentOrders([fixture]);
    }
  });
});
