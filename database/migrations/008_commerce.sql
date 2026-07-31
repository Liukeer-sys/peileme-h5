CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sku TEXT NOT NULL UNIQUE
    CHECK (sku ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  name TEXT NOT NULL CHECK (length(btrim(name)) > 0),
  description TEXT NOT NULL CHECK (length(btrim(description)) > 0),
  product_channel TEXT NOT NULL
    CHECK (product_channel IN ('main', 'ai', 'all')),
  fulfillment_type TEXT NOT NULL
    CHECK (
      fulfillment_type IN (
        'policy_calculation',
        'ai_analysis',
        'document_review'
      )
    ),
  status TEXT NOT NULL CHECK (status IN ('active', 'inactive')),
  entitlement_policy JSONB NOT NULL
    CHECK (jsonb_typeof(entitlement_policy) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    fulfillment_type <> 'document_review'
    OR product_channel = 'ai'
  ),
  CONSTRAINT products_seeded_sku_contract CHECK (
    (
      sku <> 'POLICY_CALC'
      OR (
        product_channel = 'main'
        AND fulfillment_type = 'policy_calculation'
      )
    )
    AND (
      sku <> 'AI_SEVERANCE_ANALYSIS'
      OR (
        product_channel = 'ai'
        AND fulfillment_type = 'ai_analysis'
      )
    )
    AND (
      sku <> 'AI_DOCUMENT_REVIEW'
      OR (
        product_channel = 'ai'
        AND fulfillment_type = 'document_review'
      )
    )
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
  UNIQUE (product_id, effective_from),
  CONSTRAINT product_prices_no_overlap EXCLUDE USING gist (
    product_id WITH =,
    tstzrange(effective_from, effective_to, '[)') WITH &&
  )
);

CREATE UNIQUE INDEX product_prices_one_open_idx
  ON product_prices(product_id)
  WHERE effective_to IS NULL;

CREATE INDEX product_prices_effective_idx
  ON product_prices(product_id, effective_from DESC, effective_to);

CREATE TABLE promotion_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE
    CHECK (code ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  name TEXT NOT NULL CHECK (length(btrim(name)) > 0),
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  grant_count INTEGER NOT NULL CHECK (grant_count > 0),
  trigger_type TEXT NOT NULL
    CHECK (
      trigger_type IN (
        'first_verified_user',
        'invite_redemption',
        'admin_grant'
      )
    ),
  constraints JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(constraints) = 'object'),
  status TEXT NOT NULL CHECK (status IN ('active', 'inactive')),
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at > starts_at)
);

CREATE INDEX promotion_rules_active_idx
  ON promotion_rules(product_id, trigger_type, starts_at, ends_at)
  WHERE status = 'active';

CREATE TABLE orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_no TEXT NOT NULL UNIQUE CHECK (length(btrim(order_no)) > 0),
  user_id UUID NOT NULL REFERENCES users(id),
  product_channel TEXT NOT NULL CHECK (product_channel IN ('main', 'ai')),
  status TEXT NOT NULL
    CHECK (
      status IN (
        'CREATED',
        'PAYING',
        'PAID',
        'FULFILLING',
        'COMPLETED',
        'CLOSED',
        'PAYMENT_FAILED',
        'REFUND_PENDING',
        'PARTIALLY_REFUNDED',
        'REFUNDED',
        'REFUND_FAILED'
      )
    ),
  total_fen BIGINT NOT NULL CHECK (total_fen >= 0),
  currency TEXT NOT NULL DEFAULT 'CNY' CHECK (currency = 'CNY'),
  idempotency_key TEXT NOT NULL CHECK (length(btrim(idempotency_key)) > 0),
  business_draft_id UUID,
  paid_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key),
  CONSTRAINT orders_id_user_unique UNIQUE (id, user_id),
  CHECK (expires_at > created_at)
);

CREATE TABLE order_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id),
  sku TEXT NOT NULL CHECK (length(btrim(sku)) > 0),
  product_name TEXT NOT NULL CHECK (length(btrim(product_name)) > 0),
  unit_price_fen BIGINT NOT NULL CHECK (unit_price_fen >= 0),
  quantity INTEGER NOT NULL CHECK (quantity = 1),
  entitlement_policy JSONB NOT NULL
    CHECK (jsonb_typeof(entitlement_policy) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (order_id, product_id)
);

CREATE TABLE payment_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('wechat_h5', 'alipay_wap', 'fake')),
  status TEXT NOT NULL
    CHECK (
      status IN (
        'CREATED',
        'REDIRECT_READY',
        'PENDING',
        'SUCCEEDED',
        'FAILED',
        'CLOSED'
      )
    ),
  channel_prepay_id TEXT,
  launch_url TEXT,
  request_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(request_snapshot) = 'object'),
  response_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(response_snapshot) = 'object'),
  error_code TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT payment_attempts_order_id_channel_unique
    UNIQUE (order_id, id, channel)
);

CREATE UNIQUE INDEX payment_attempts_channel_prepay_unique_idx
  ON payment_attempts(channel, channel_prepay_id)
  WHERE channel_prepay_id IS NOT NULL;

CREATE TABLE payment_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id),
  payment_attempt_id UUID,
  channel TEXT NOT NULL CHECK (channel IN ('wechat_h5', 'alipay_wap', 'fake')),
  channel_transaction_id TEXT NOT NULL
    CHECK (length(btrim(channel_transaction_id)) > 0),
  amount_fen BIGINT NOT NULL CHECK (amount_fen > 0),
  currency TEXT NOT NULL CHECK (currency = 'CNY'),
  status TEXT NOT NULL CHECK (status IN ('SUCCESS', 'CLOSED', 'REFUND')),
  verified_payload JSONB NOT NULL
    CHECK (jsonb_typeof(verified_payload) = 'object'),
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (channel, channel_transaction_id),
  CONSTRAINT payment_transactions_attempt_order_fk
    FOREIGN KEY (order_id, payment_attempt_id, channel)
    REFERENCES payment_attempts(order_id, id, channel)
);

CREATE TABLE entitlements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id),
  source_type TEXT NOT NULL
    CHECK (source_type IN ('first_free', 'order', 'invite', 'admin')),
  source_id UUID,
  total_uses INTEGER NOT NULL CHECK (total_uses > 0),
  remaining_uses INTEGER NOT NULL
    CHECK (remaining_uses >= 0 AND remaining_uses <= total_uses),
  status TEXT NOT NULL
    CHECK (status IN ('active', 'reserved', 'consumed', 'revoked')),
  reserved_for UUID,
  reserved_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (reserved_for IS NULL AND reserved_at IS NULL)
    OR (reserved_for IS NOT NULL AND reserved_at IS NOT NULL)
  ),
  CONSTRAINT entitlements_id_user_unique UNIQUE (id, user_id)
);

CREATE UNIQUE INDEX entitlements_source_unique_idx
  ON entitlements(user_id, product_id, source_type, source_id)
  WHERE source_id IS NOT NULL;

CREATE UNIQUE INDEX entitlements_first_free_unique_idx
  ON entitlements(user_id, product_id)
  WHERE source_type = 'first_free';

CREATE TABLE entitlement_usages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entitlement_id UUID NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id),
  business_type TEXT NOT NULL CHECK (length(btrim(business_type)) > 0),
  business_id UUID NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('reserved', 'consumed', 'released')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  consumed_at TIMESTAMPTZ,
  UNIQUE (business_type, business_id),
  CHECK (
    (status = 'consumed' AND consumed_at IS NOT NULL)
    OR (status <> 'consumed' AND consumed_at IS NULL)
  ),
  CONSTRAINT entitlement_usages_owner_fk
    FOREIGN KEY (entitlement_id, user_id)
    REFERENCES entitlements(id, user_id)
);

CREATE TABLE refunds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  refund_no TEXT NOT NULL UNIQUE CHECK (length(btrim(refund_no)) > 0),
  order_id UUID NOT NULL REFERENCES orders(id),
  channel TEXT NOT NULL CHECK (channel IN ('wechat_h5', 'alipay_wap', 'fake')),
  channel_refund_id TEXT,
  amount_fen BIGINT NOT NULL CHECK (amount_fen > 0),
  reason TEXT NOT NULL CHECK (length(btrim(reason)) > 0),
  status TEXT NOT NULL
    CHECK (status IN ('PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED')),
  requested_by UUID REFERENCES users(id),
  response_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(response_snapshot) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX refunds_channel_refund_unique_idx
  ON refunds(channel, channel_refund_id)
  WHERE channel_refund_id IS NOT NULL;

CREATE TABLE reconciliation_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel TEXT NOT NULL CHECK (channel IN ('wechat_h5', 'alipay_wap', 'fake')),
  business_date DATE NOT NULL,
  status TEXT NOT NULL
    CHECK (status IN ('RUNNING', 'MATCHED', 'DIFFERENCES', 'FAILED')),
  summary JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(summary) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  UNIQUE (channel, business_date)
);

CREATE TABLE invoice_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  order_id UUID NOT NULL,
  title TEXT NOT NULL CHECK (length(btrim(title)) > 0),
  tax_number TEXT,
  email TEXT NOT NULL CHECK (length(btrim(email)) > 0),
  status TEXT NOT NULL
    CHECK (status IN ('SUBMITTED', 'PROCESSING', 'ISSUED', 'REJECTED')),
  invoice_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, order_id),
  CONSTRAINT invoice_requests_order_owner_fk
    FOREIGN KEY (order_id, user_id)
    REFERENCES orders(id, user_id)
);

CREATE INDEX orders_user_time_idx ON orders(user_id, created_at DESC);
CREATE INDEX orders_status_time_idx ON orders(status, created_at DESC);
CREATE INDEX entitlements_available_idx
  ON entitlements(user_id, product_id, status, expires_at);
CREATE INDEX payment_attempts_order_idx
  ON payment_attempts(order_id, created_at DESC);
CREATE INDEX payment_transactions_order_idx
  ON payment_transactions(order_id, created_at DESC);
CREATE INDEX refunds_order_idx ON refunds(order_id, created_at DESC);
