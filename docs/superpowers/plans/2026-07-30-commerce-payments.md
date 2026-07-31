# Commerce and Payments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add configurable per-use products, first-use eligibility, orders, WeChat H5 and Alipay WAP payment, entitlements, refunds, reconciliation, invoice requests, invite rewards, and complete user/admin transaction UX.

**Architecture:** Keep calculation and payment as separate state machines. A validated business draft requests an entitlement; a free or paid entitlement is consumed atomically before work begins. Channel callbacks are verified, persisted idempotently, and converted into entitlements through a single fulfillment service.

**Tech Stack:** Express 5, PostgreSQL 16, Zod 4, Node crypto/fetch, Alipay SDK 4.14, React 19, Vitest/Supertest, Playwright, Docker Compose

**Prerequisite:** Complete `2026-07-30-dual-web-policy-foundation.md`.

---

## File map

### Create

- `database/migrations/008_commerce.sql` — catalog, prices, promotions, orders, payment attempts, transactions, refunds, entitlements, reconciliation and invoices.
- `server/modules/commerce/types.ts` — SKU, order, entitlement and channel contracts.
- `server/modules/commerce/catalog.ts` — effective price and product availability.
- `server/modules/commerce/entitlements.ts` — grant, reserve, consume, release and free-use eligibility.
- `server/modules/commerce/orders.ts` — order state machine and fulfillment.
- `server/modules/commerce/routes.ts` — user catalog, checkout, order, refund and invoice routes.
- `server/modules/commerce/admin-routes.ts` — product, price, promotion, order, refund and reconciliation routes.
- `server/modules/payments/provider.ts` — payment adapter interface.
- `server/modules/payments/wechat.ts` — WeChat Pay API v3 H5 adapter.
- `server/modules/payments/alipay.ts` — Alipay WAP adapter.
- `server/modules/payments/webhooks.ts` — raw-body callback handlers.
- `server/modules/payments/reconciliation.ts` — active query, reconciliation and anomaly detection.
- `server/modules/payments/fake.ts` — test-only deterministic channel.
- `server/tests/commerce.test.ts` — catalog, free quota, state machine and idempotency.
- `server/tests/payment-webhooks.test.ts` — signature, amount, duplicate callback and refund tests.
- `src/commerce/types.ts` — browser commerce contracts.
- `src/commerce/CheckoutSheet.tsx` — channel selection, launch and polling.
- `src/commerce/OrderHistory.tsx` — order/refund/invoice history.
- `src/commerce/PaymentReturn.tsx` — return-page polling.
- `src/admin/CommerceAdmin.tsx` — catalog, price, order, refund and reconciliation admin.
- `e2e/commerce.spec.ts` — free-use, payment, cancel, duplicate and refund browser paths.

### Modify

- `package.json` / `package-lock.json` — Alipay SDK and commerce scripts.
- `database/migrations/007_policy_rule_regressions.sql` — no edit after application; Plan 2 starts with migration 008 only.
- `server/config.ts` — channel credentials, callback URLs and payment mode.
- `server/app.ts` — raw webhook mounting and commerce routers.
- `server/modules/policy/routes.ts` — entitlement gate before calculation.
- `server/modules/policy/seed.ts` — product and promotion seed call.
- `server/security.ts` — finance/operations capabilities.
- `src/main/MainApp.tsx` — payment-required transition.
- `src/main/PolicyResult.tsx` — entitlement and order context.
- `src/components/AccountPanel.tsx` — orders, refunds, invoices and invite rewards.
- `src/admin/AdminDashboard.tsx` — commerce navigation.
- `.env.example` — payment secrets and URLs.
- `docker-compose.yml` — payment configuration and scheduled job entry.

## Task 1: Add commerce persistence and seed the three site-scoped SKUs

**Files:**
- Create: `database/migrations/008_commerce.sql`
- Create: `server/modules/commerce/types.ts`
- Modify: `server/modules/policy/seed.ts`
- Test: `server/tests/commerce.test.ts`

- [ ] **Step 1: Write the failing catalog test**

```ts
it("seeds the three site-scoped per-use products and their default prices", async () => {
  await seedPolicyFoundation();
  const result = await query<{ sku: string; amount_fen: string }>(
    `SELECT p.sku, pp.amount_fen
       FROM products p
       JOIN product_prices pp ON pp.product_id = p.id
      WHERE pp.effective_to IS NULL
      ORDER BY p.sku`
  );
  expect(result.rows).toEqual([
    { sku: "AI_DOCUMENT_REVIEW", amount_fen: "2990" },
    { sku: "AI_SEVERANCE_ANALYSIS", amount_fen: "3990" },
    { sku: "POLICY_CALC", amount_fen: "990" }
  ]);
});
```

- [ ] **Step 2: Run and verify failure**

Run:

```bash
npm run test:db:up
npm test -- --run server/tests/commerce.test.ts
```

Expected: FAIL because `products` does not exist.

- [ ] **Step 3: Create the migration**

Create `database/migrations/008_commerce.sql`:

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sku TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  product_channel TEXT NOT NULL CHECK (product_channel IN ('main', 'ai', 'all')),
  fulfillment_type TEXT NOT NULL CHECK (
    fulfillment_type IN ('policy_calculation', 'ai_analysis', 'document_review')
  ),
  status TEXT NOT NULL CHECK (status IN ('active', 'inactive')),
  entitlement_policy JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (fulfillment_type <> 'document_review' OR product_channel = 'ai'),
  CONSTRAINT products_seeded_sku_contract CHECK (
    (sku <> 'POLICY_CALC' OR (
      product_channel = 'main' AND fulfillment_type = 'policy_calculation'
    ))
    AND (sku <> 'AI_SEVERANCE_ANALYSIS' OR (
      product_channel = 'ai' AND fulfillment_type = 'ai_analysis'
    ))
    AND (sku <> 'AI_DOCUMENT_REVIEW' OR (
      product_channel = 'ai' AND fulfillment_type = 'document_review'
    ))
  )
);

CREATE TABLE product_prices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  amount_fen BIGINT NOT NULL CHECK (amount_fen >= 1),
  currency TEXT NOT NULL DEFAULT 'CNY' CHECK (currency = 'CNY'),
  effective_from TIMESTAMPTZ NOT NULL,
  effective_to TIMESTAMPTZ,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to > effective_from),
  CONSTRAINT product_prices_no_overlap EXCLUDE USING gist (
    product_id WITH =,
    tstzrange(effective_from, effective_to, '[)') WITH &&
  )
);
CREATE UNIQUE INDEX product_prices_one_open_idx
  ON product_prices(product_id) WHERE effective_to IS NULL;

CREATE TABLE promotion_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  grant_count INTEGER NOT NULL CHECK (grant_count > 0),
  trigger_type TEXT NOT NULL CHECK (
    trigger_type IN ('first_verified_user', 'invite_redemption', 'admin_grant')
  ),
  constraints JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL CHECK (status IN ('active', 'inactive')),
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_no TEXT NOT NULL UNIQUE,
  user_id UUID NOT NULL REFERENCES users(id),
  product_channel TEXT NOT NULL CHECK (product_channel IN ('main', 'ai')),
  status TEXT NOT NULL CHECK (
    status IN (
      'CREATED', 'PAYING', 'PAID', 'FULFILLING', 'COMPLETED',
      'CLOSED', 'PAYMENT_FAILED', 'REFUND_PENDING',
      'PARTIALLY_REFUNDED', 'REFUNDED', 'REFUND_FAILED'
    )
  ),
  total_fen BIGINT NOT NULL CHECK (total_fen >= 0),
  currency TEXT NOT NULL DEFAULT 'CNY' CHECK (currency = 'CNY'),
  idempotency_key TEXT NOT NULL,
  business_draft_id UUID,
  paid_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key),
  UNIQUE (id, user_id)
);

CREATE TABLE order_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id),
  sku TEXT NOT NULL,
  product_name TEXT NOT NULL,
  unit_price_fen BIGINT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity = 1),
  entitlement_policy JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE payment_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('wechat_h5', 'alipay_wap', 'fake')),
  status TEXT NOT NULL CHECK (
    status IN ('CREATED', 'REDIRECT_READY', 'PENDING', 'SUCCEEDED', 'FAILED', 'CLOSED')
  ),
  channel_prepay_id TEXT,
  launch_url TEXT,
  request_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  response_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_code TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (order_id, id)
);

CREATE TABLE payment_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id),
  payment_attempt_id UUID,
  channel TEXT NOT NULL,
  channel_transaction_id TEXT NOT NULL,
  amount_fen BIGINT NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('SUCCESS', 'CLOSED', 'REFUND')),
  verified_payload JSONB NOT NULL,
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (channel, channel_transaction_id),
  FOREIGN KEY (order_id, payment_attempt_id)
    REFERENCES payment_attempts(order_id, id)
);

CREATE TABLE entitlements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id),
  source_type TEXT NOT NULL CHECK (
    source_type IN ('first_free', 'order', 'invite', 'admin')
  ),
  source_id UUID,
  total_uses INTEGER NOT NULL CHECK (total_uses > 0),
  remaining_uses INTEGER NOT NULL CHECK (remaining_uses >= 0),
  status TEXT NOT NULL CHECK (status IN ('active', 'reserved', 'consumed', 'revoked')),
  reserved_for UUID,
  reserved_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, user_id)
);

CREATE TABLE entitlement_usages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entitlement_id UUID NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id),
  business_type TEXT NOT NULL,
  business_id UUID NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('reserved', 'consumed', 'released')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  consumed_at TIMESTAMPTZ,
  UNIQUE (business_type, business_id),
  FOREIGN KEY (entitlement_id, user_id)
    REFERENCES entitlements(id, user_id)
);

CREATE TABLE refunds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  refund_no TEXT NOT NULL UNIQUE,
  order_id UUID NOT NULL REFERENCES orders(id),
  channel TEXT NOT NULL,
  channel_refund_id TEXT,
  amount_fen BIGINT NOT NULL CHECK (amount_fen > 0),
  reason TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED')
  ),
  requested_by UUID REFERENCES users(id),
  response_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE reconciliation_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel TEXT NOT NULL,
  business_date DATE NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('RUNNING', 'MATCHED', 'DIFFERENCES', 'FAILED')),
  summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  UNIQUE (channel, business_date)
);

CREATE TABLE invoice_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  order_id UUID NOT NULL,
  title TEXT NOT NULL,
  tax_number TEXT,
  email TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('SUBMITTED', 'PROCESSING', 'ISSUED', 'REJECTED')),
  invoice_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, order_id),
  FOREIGN KEY (order_id, user_id)
    REFERENCES orders(id, user_id)
);

CREATE INDEX orders_user_time_idx ON orders(user_id, created_at DESC);
CREATE INDEX orders_status_time_idx ON orders(status, created_at DESC);
CREATE INDEX entitlements_available_idx
  ON entitlements(user_id, product_id, status, expires_at);
CREATE INDEX payment_attempts_order_idx ON payment_attempts(order_id, created_at DESC);
```

- [ ] **Step 4: Define commerce types**

Create `server/modules/commerce/types.ts`:

```ts
export const productSkus = [
  "POLICY_CALC",
  "AI_SEVERANCE_ANALYSIS",
  "AI_DOCUMENT_REVIEW"
] as const;
export type ProductSku = typeof productSkus[number];
export type OrderProductChannel = "main" | "ai";
export type PromotionTriggerType =
  | "first_verified_user" | "invite_redemption" | "admin_grant";
export type PromotionStatus = "active" | "inactive";

export type OrderStatus =
  | "CREATED" | "PAYING" | "PAID" | "FULFILLING" | "COMPLETED"
  | "CLOSED" | "PAYMENT_FAILED" | "REFUND_PENDING"
  | "PARTIALLY_REFUNDED" | "REFUNDED" | "REFUND_FAILED";

export type PaymentChannel = "wechat_h5" | "alipay_wap" | "fake";
```

- [ ] **Step 5: Seed products, prices and first-free promotion**

Extend `seedPolicyFoundation()` with one transaction that inserts the three product defaults only when each SKU is absent and inserts an open price only when one does not exist. Re-running the seed preserves administrator-configured names, descriptions, status, entitlement policies and open prices. The database fixes `POLICY_CALC` to `main/policy_calculation`, `AI_SEVERANCE_ANALYSIS` to `ai/ai_analysis`, and `AI_DOCUMENT_REVIEW` to `ai/document_review`. Insert promotion `FIRST_POLICY_CALC` for `POLICY_CALC`, `grant_count = 1`, `trigger_type = first_verified_user`.

The file-signing/document-review product is AI-site only. Main-site APIs, navigation, copy, JavaScript and built artifacts must continue to exclude it.

- [ ] **Step 6: Run the test**

Run:

```bash
npm test -- --run server/tests/commerce.test.ts
```

Expected: catalog seed test passes.

- [ ] **Step 7: Commit**

```bash
git add database/migrations/008_commerce.sql server/modules/commerce server/modules/policy/seed.ts server/tests/commerce.test.ts
git commit -m "feat: add per-use commerce schema and catalog"
```

## Task 2: Implement catalog and atomic entitlements

**Files:**
- Create: `server/modules/commerce/catalog.ts`
- Create: `server/modules/commerce/entitlements.ts`
- Modify: `server/tests/commerce.test.ts`

- [ ] **Step 1: Write failing entitlement tests**

```ts
it("grants the first policy use exactly once under concurrency", async () => {
  const attempts = await Promise.allSettled([
    reserveEntitlement(userId, "POLICY_CALC", businessIdA),
    reserveEntitlement(userId, "POLICY_CALC", businessIdB)
  ]);
  expect(attempts.filter((item) => item.status === "fulfilled")).toHaveLength(1);
  expect(attempts.filter((item) => item.status === "rejected")).toHaveLength(1);
});

it("releases a reservation after a recoverable calculation failure", async () => {
  const reserved = await reserveEntitlement(userId, "POLICY_CALC", businessIdA);
  await releaseEntitlement(reserved.usageId);
  const available = await getAvailableEntitlements(userId, "POLICY_CALC");
  expect(available).toHaveLength(1);
});
```

- [ ] **Step 2: Run and verify failure**

Run:

```bash
npm test -- --run server/tests/commerce.test.ts
```

Expected: FAIL because entitlement functions do not exist.

- [ ] **Step 3: Implement effective catalog reads**

`catalog.ts` exports `getActiveCatalog(channel)`, `getProductBySku(sku)`, and `getEffectivePrice(productId, at)`. Effective price SQL requires `effective_from <= at` and `effective_to IS NULL OR effective_to > at`.

- [ ] **Step 4: Implement one-time grant and reservation**

Use a transaction and a PostgreSQL advisory lock derived from `user_id + product_id`. The core query is:

```ts
await client.query(
  "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
  [`${userId}:${product.id}`]
);
```

Inside the lock:

1. Find an active entitlement with remaining uses.
2. If absent and the SKU is `POLICY_CALC`, check verified identity and absence of any `first_free` entitlement, then insert one.
3. Insert `entitlement_usages` as `reserved`.
4. Decrement `remaining_uses`; set entitlement state to `reserved` or `consumed`.
5. Return `usageId`, `entitlementId` and `sourceType`.

`consumeEntitlement(usageId)` changes the usage to `consumed`. `releaseEntitlement(usageId)` changes it to `released` and restores one remaining use once.

- [ ] **Step 5: Run entitlement tests**

Run:

```bash
npm test -- --run server/tests/commerce.test.ts
```

Expected: concurrency and release tests pass.

- [ ] **Step 6: Commit**

```bash
git add server/modules/commerce server/tests/commerce.test.ts
git commit -m "feat: reserve and consume per-use entitlements"
```

## Task 3: Build order creation, checkout and fulfillment

**Files:**
- Create: `server/modules/commerce/orders.ts`
- Create: `server/modules/commerce/routes.ts`
- Create: `server/modules/payments/provider.ts`
- Create: `server/modules/payments/fake.ts`
- Modify: `server/app.ts`
- Modify: `server/modules/policy/routes.ts`
- Modify: `server/tests/commerce.test.ts`

- [ ] **Step 1: Write failing order idempotency tests**

```ts
it("returns the same open order for the same idempotency key", async () => {
  const first = await createOrder({
    userId,
    sku: "POLICY_CALC",
    channel: "main",
    idempotencyKey: "calc-draft-1",
    businessDraftId
  });
  const second = await createOrder({
    userId,
    sku: "POLICY_CALC",
    channel: "main",
    idempotencyKey: "calc-draft-1",
    businessDraftId
  });
  expect(second.id).toBe(first.id);
  expect(second.orderNo).toBe(first.orderNo);
});

it("fulfills a paid order exactly once", async () => {
  await markOrderPaid(orderId, verifiedTransaction);
  await markOrderPaid(orderId, verifiedTransaction);
  const rows = await query(
    "SELECT * FROM entitlements WHERE source_type = 'order' AND source_id = $1",
    [orderId]
  );
  expect(rows.rowCount).toBe(1);
});
```

- [ ] **Step 2: Define the provider interface**

Create `server/modules/payments/provider.ts`:

```ts
export type CreatePaymentInput = {
  orderNo: string;
  description: string;
  amountFen: number;
  clientIp: string;
  returnUrl: string;
  notifyUrl: string;
};

export type VerifiedPayment = {
  orderNo: string;
  channelTransactionId: string;
  amountFen: number;
  currency: "CNY";
  paidAt: string;
  raw: Record<string, unknown>;
};

export interface PaymentProvider {
  createPayment(input: CreatePaymentInput): Promise<{
    prepayId?: string;
    launchUrl: string;
    response: Record<string, unknown>;
  }>;
  queryPayment(orderNo: string): Promise<VerifiedPayment | null>;
  refund(input: {
    orderNo: string;
    refundNo: string;
    amountFen: number;
    totalFen: number;
    reason: string;
  }): Promise<{ channelRefundId: string; raw: Record<string, unknown> }>;
}
```

- [ ] **Step 3: Implement order state transitions**

`orders.ts` must export:

- `createOrder`
- `startPayment`
- `markOrderPaid`
- `fulfillOrder`
- `closeExpiredOrders`
- `getOwnedOrder`
- `listOwnedOrders`

Every transition uses `SELECT ... FOR UPDATE` and validates the previous state. `markOrderPaid` inserts `payment_transactions` with `ON CONFLICT DO NOTHING`, checks transaction amount/currency against the order, updates `PAID`, and calls `fulfillOrder` in the same transaction. Fulfillment inserts one order entitlement and changes the order through `FULFILLING` to `COMPLETED`.

- [ ] **Step 4: Add a deterministic fake provider**

`fake.ts` accepts only `NODE_ENV=test`, returns `/api/test-payments/<orderNo>/complete`, and its completion endpoint produces a signed in-process `VerifiedPayment`. Production startup throws if `PAYMENT_MODE=fake`.

- [ ] **Step 5: Add commerce routes**

Mount:

```ts
router.get("/catalog", optionalAuth, listCatalog);
router.post("/orders", requireAuth, createOwnedOrder);
router.post("/orders/:id/pay", requireAuth, startOwnedPayment);
router.get("/orders", requireAuth, listOrders);
router.get("/orders/:id", requireAuth, getOrder);
router.post("/orders/:id/invoice", requireAuth, createInvoiceRequest);
```

Mount the user router at `/api/commerce`, the admin router at `/api/admin/commerce`, and the test completion router at `/api/test-payments` only when `NODE_ENV=test`.

The payment start response contains `{ orderId, orderNo, status, launchUrl, expiresAt }`.

- [ ] **Step 6: Gate policy calculation with entitlements**

Change `/api/policy/calculate`:

1. Save a validated calculation draft.
2. Call `reserveEntitlement(userId, "POLICY_CALC", draftId)`.
3. When no entitlement is available, return status `402` with:

```json
{
  "error": "PAYMENT_REQUIRED",
  "message": "本次完整测算需要按次购买",
  "sku": "POLICY_CALC",
  "businessDraftId": "uuid",
  "priceFen": 990
}
```

4. On calculation success, consume the reservation.
5. On recoverable server failure, release it.

- [ ] **Step 7: Run order and compatibility tests**

Run:

```bash
npm test -- --run server/tests/commerce.test.ts server/tests/policy.api.test.ts
```

Expected: idempotency, fulfillment and policy entitlement tests pass.

- [ ] **Step 8: Commit**

```bash
git add server/modules/commerce server/modules/payments server/modules/policy/routes.ts server/app.ts server/tests
git commit -m "feat: create orders and fulfill usage entitlements"
```

## Task 4: Integrate WeChat H5 and Alipay WAP

**Files:**
- Create: `server/modules/payments/wechat.ts`
- Create: `server/modules/payments/alipay.ts`
- Create: `server/modules/payments/webhooks.ts`
- Create: `server/tests/payment-webhooks.test.ts`
- Modify: `server/config.ts`
- Modify: `server/app.ts`
- Modify: `.env.example`
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Install the official-compatible Alipay SDK**

Run:

```bash
npm install alipay-sdk@4.14.0
```

Expected: dependency installs without audit high/critical findings.

- [ ] **Step 2: Write callback failure tests**

Cover:

```ts
await request(createApp())
  .post("/api/payments/wechat/notify")
  .set("wechatpay-signature", "bad")
  .send(validWechatBody)
  .expect(401);

await request(createApp())
  .post("/api/payments/alipay/notify")
  .type("form")
  .send({ ...validAlipayBody, total_amount: "0.01" })
  .expect(400);
```

Also test duplicate success callbacks produce one transaction and one entitlement.

- [ ] **Step 3: Add channel configuration**

Add Zod fields for:

```text
PAYMENT_MODE
PAYMENT_RETURN_BASE_URL
WECHAT_PAY_MCH_ID
WECHAT_PAY_APP_ID
WECHAT_PAY_API_V3_KEY
WECHAT_PAY_PRIVATE_KEY_PATH
WECHAT_PAY_CERT_SERIAL
WECHAT_PAY_PLATFORM_PUBLIC_KEY_PATH
ALIPAY_APP_ID
ALIPAY_PRIVATE_KEY_PATH
ALIPAY_PUBLIC_KEY_PATH
```

In production, channel credentials are required only when that channel is enabled.

- [ ] **Step 4: Implement WeChat API v3**

`wechat.ts` must:

- Sign `POST /v3/pay/transactions/h5` with RSA-SHA256.
- Pass the actual client IP and configured H5 scene information.
- Return `h5_url`.
- Verify timestamp, nonce, body and `Wechatpay-Signature`.
- Decrypt notification resource using AES-256-GCM and API v3 key.
- Query `/v3/pay/transactions/out-trade-no/{orderNo}`.
- Submit `/v3/refund/domestic/refunds`.

Use Node `crypto`, `fetch`, `readFileSync` and constant-time signature verification. Log order number and result, excluding private keys and raw personal information.

- [ ] **Step 5: Implement Alipay WAP**

`alipay.ts` creates an `AlipaySdk` using file-loaded keys, calls `pageExec("alipay.trade.wap.pay", ...)`, verifies notification signatures with `checkNotifySignV2`, queries `alipay.trade.query`, and refunds with `alipay.trade.refund`.

- [ ] **Step 6: Mount raw callbacks before JSON parsing**

In `server/app.ts`, mount payment notification handlers before `express.json()`:

```ts
app.post(
  "/api/payments/wechat/notify",
  express.raw({ type: "application/json", limit: "256kb" }),
  handleWechatNotification
);
app.post(
  "/api/payments/alipay/notify",
  express.urlencoded({ extended: false, limit: "256kb" }),
  handleAlipayNotification
);
```

- [ ] **Step 7: Run callback tests**

Run:

```bash
npm test -- --run server/tests/payment-webhooks.test.ts server/tests/commerce.test.ts
```

Expected: signature, amount, duplicate and fulfillment tests pass.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json server/config.ts server/app.ts server/modules/payments server/tests/payment-webhooks.test.ts .env.example
git commit -m "feat: integrate WeChat H5 and Alipay WAP payments"
```

## Task 5: Add refunds, reconciliation, invoices and invite rewards

**Files:**
- Create: `server/modules/payments/reconciliation.ts`
- Create: `server/modules/commerce/admin-routes.ts`
- Modify: `server/modules/commerce/routes.ts`
- Modify: `server/modules/commerce/entitlements.ts`
- Modify: `server/modules/commerce/orders.ts`
- Modify: `server/services.ts`
- Modify: `server/security.ts`
- Test: `server/tests/commerce.test.ts`

- [ ] **Step 1: Write failing tests**

Test that:

- A consumed digital entitlement creates `REFUND_PENDING` and requires finance action.
- An unused entitlement is revoked after successful refund.
- A reconciliation mismatch is persisted with order/channel amounts.
- Redeeming a configured invite promotion grants exactly one entitlement.
- Analyst cannot refund, finance capability can refund.

- [ ] **Step 2: Add finance and operations capabilities**

Seed:

```sql
('admin', 'commerce.read'),
('admin', 'commerce.write'),
('admin', 'refund.approve'),
('admin', 'reconciliation.run'),
('analyst', 'commerce.read')
```

- [ ] **Step 3: Implement refund state transitions**

`requestRefund` validates ownership and amount. `approveRefund` locks the order and refund, calls the channel adapter outside the database transaction using an idempotent refund number, then records the response and updates the order. A successful refund revokes remaining order entitlements. Failed channel calls remain retryable with the same `refund_no`.

- [ ] **Step 4: Implement reconciliation**

For each channel and business date:

1. Load local successful transactions.
2. Query channel state for orders without a final match.
3. Compare transaction ID, amount, currency and state.
4. Store counts and a bounded anomaly list in `reconciliation_runs.summary`.
5. Emit `payment_reconciliation_difference` for every mismatch.

- [ ] **Step 5: Implement configurable invite rewards**

Replace legacy module grants with promotion-driven entitlement grants. Keep legacy rows readable during migration. Invite redemption locks the code and user, inserts the relationship, then grants the product/count configured in the promotion constraint.

- [ ] **Step 6: Add invoice request and admin routes**

Users can submit one invoice request per paid order. Admin can transition `SUBMITTED → PROCESSING → ISSUED/REJECTED` and attach a URL. All transitions write admin audit logs.

- [ ] **Step 7: Run commerce tests**

Run:

```bash
npm test -- --run server/tests/commerce.test.ts
```

Expected: refund, reconciliation, invite and capability tests pass.

- [ ] **Step 8: Commit**

```bash
git add server/modules server/services.ts server/security.ts server/tests
git commit -m "feat: reconcile payments and manage refunds"
```

## Task 6: Build user checkout and transaction history

**Files:**
- Create: `src/commerce/types.ts`
- Create: `src/commerce/CheckoutSheet.tsx`
- Create: `src/commerce/OrderHistory.tsx`
- Create: `src/commerce/PaymentReturn.tsx`
- Modify: `src/main/MainApp.tsx`
- Modify: `src/components/AccountPanel.tsx`
- Modify: `src/lib/api.ts`
- Modify: `src/styles.css`
- Test: `e2e/commerce.spec.ts`

- [ ] **Step 1: Write the failing browser flow**

```ts
test("first calculation is free and the second uses checkout", async ({ page }) => {
  await loginAsFreshUser(page);
  await completeAndSubmitPolicy(page);
  await expect(page.getByText("本次使用首次免费权益")).toBeVisible();
  await page.getByRole("button", { name: "重新测算" }).click();
  await completeAndSubmitPolicy(page);
  await expect(page.getByRole("dialog", { name: "确认购买" })).toBeVisible();
  await expect(page.getByText("¥9.90")).toBeVisible();
  await page.getByRole("button", { name: "支付宝支付" }).click();
  await completeFakePayment(page);
  await expect(page.getByRole("heading", { name: "政策测算结果" })).toBeVisible();
});
```

- [ ] **Step 2: Implement checkout state**

`CheckoutSheet` receives `{ sku, businessDraftId, onPaid, onClose }`, loads the effective price, creates an idempotent order, starts the selected payment, stores the order ID in session storage, and navigates to the channel launch URL. On return it polls `/api/commerce/orders/:id` with capped exponential intervals until `COMPLETED`, `CLOSED`, or 90 seconds.

- [ ] **Step 3: Handle `402 PAYMENT_REQUIRED`**

`MainApp` preserves all answers and the returned draft ID, opens `CheckoutSheet`, and resumes `/api/policy/drafts/:id/execute` after the order entitlement is fulfilled. Canceling the sheet keeps the draft and questionnaire.

- [ ] **Step 4: Add order/refund/invoice history**

`AccountPanel` adds a transaction tab with order number, product, amount, channel, state, date, refund action and invoice action. Every action shows a real server state and refreshes after completion.

- [ ] **Step 5: Add WeChat embedded-browser guidance**

Detect `MicroMessenger` user agent. For `wechat_h5`, show a full-screen instruction to use the system browser. Preserve the current URL and order in session storage.

- [ ] **Step 6: Run the browser flow**

Run:

```bash
npm run build:web:main
E2E_PAYMENT_MODE=fake npx playwright test e2e/commerce.spec.ts
```

Expected: first-free and fake payment paths pass.

- [ ] **Step 7: Commit**

```bash
git add src/commerce src/main src/components/AccountPanel.tsx src/lib/api.ts src/styles.css e2e/commerce.spec.ts
git commit -m "feat: add per-use checkout and order history"
```

## Task 7: Build commerce administration

**Files:**
- Create: `src/admin/CommerceAdmin.tsx`
- Modify: `src/admin/AdminDashboard.tsx`
- Modify: `src/admin/admin.css`
- Modify: `server/modules/commerce/admin-routes.ts`
- Modify: `e2e/commerce.spec.ts`

- [ ] **Step 1: Add admin API contract tests**

Verify product price changes close the prior price at the new effective time, order filters are paginated, refund approval requires capability, reconciliation summaries return channel/local differences, and audit rows contain before/after values.

- [ ] **Step 2: Add admin tabs**

Add `products`, `orders`, `refunds`, `reconciliation`, and `invoices`. Product editing accepts integer yuan/fen safely, effective time and active state. Orders display immutable price snapshots. Refund approval requires a reason confirmation. Analyst controls render disabled and API still returns 403 for writes.

- [ ] **Step 3: Add admin Playwright coverage**

Create a price change in the admin, assert the public catalog reflects it, restore the default price, inspect the test order, approve a test refund, and confirm an audit row exists.

- [ ] **Step 4: Run Plan 2 checks**

Run:

```bash
npm run test:db:up
npm test
npm run build
E2E_PAYMENT_MODE=fake npx playwright test e2e/commerce.spec.ts
npm audit --omit=dev
npm run test:db:down
```

Expected: all tests pass and no production high/critical dependency issue is reported.

- [ ] **Step 5: Commit**

```bash
git add src/admin server/modules/commerce server/tests e2e/commerce.spec.ts
git commit -m "feat: administer products orders and refunds"
```

## Task 8: Exercise official sandboxes and document production handoff

**Files:**
- Modify: `docs/production-runbook.md`
- Create: `docs/payment-acceptance.md`

- [ ] **Step 1: Configure channel sandboxes through environment files**

Populate an untracked `.env.payment-sandbox` with sandbox application IDs, keys, certificates and callback URLs. Set file mode `0600`. Confirm `git status --ignored` does not expose it.

- [ ] **Step 2: Run Alipay sandbox end to end**

Create a `POLICY_CALC` order, launch WAP payment, complete it with a sandbox account, verify callback and active query agree, consume entitlement, refund it, and verify the refund state.

- [ ] **Step 3: Run WeChat acceptance available to the merchant account**

Use the merchant-provided test or low-value production acceptance mode supported by the account. Verify H5 domain, signed request, callback, active query and refund. Record transaction IDs in the protected acceptance artifact, excluding secrets.

- [ ] **Step 4: Save acceptance evidence**

`docs/payment-acceptance.md` records date, environment, SKU, order number prefix, callback result, active query result, refund result, reconciliation result and operator. It contains no full credentials, private keys, personal identifiers or complete transaction IDs.

- [ ] **Step 5: Update the runbook**

Document credential names, certificate mount paths, callback URLs, H5-domain configuration, rotation steps, reconciliation command, refund recovery and channel-disable procedure.

- [ ] **Step 6: Commit**

```bash
git add docs/payment-acceptance.md docs/production-runbook.md
git commit -m "docs: record payment acceptance and recovery"
```

## Plan 2 completion gate

- First verified user receives exactly one free policy calculation.
- Subsequent calculations require one paid or promotional entitlement.
- Price changes are versioned and visible in the admin.
- Order creation and callbacks are idempotent.
- WeChat and Alipay signatures, amounts, currency and merchant/app identity are verified.
- Refund, active query and reconciliation paths pass.
- Invite rewards grant configurable product entitlements.
- User and admin transaction UX pass happy and unhappy Playwright coverage.
- Official sandbox and available merchant acceptance evidence is recorded without secrets.
