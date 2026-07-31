CREATE OR REPLACE FUNCTION pg_temp.raise_payment_migration_diagnostic(
  diagnostic_code TEXT,
  order_ids UUID[],
  attempt_ids UUID[],
  transaction_ids UUID[],
  refund_ids UUID[]
) RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = 'P0001',
    MESSAGE = 'PAYMENT_MIGRATION_DIAGNOSTIC ' ||
      json_build_object(
        'code', diagnostic_code,
        'orderIds', COALESCE(order_ids, ARRAY[]::UUID[]),
        'attemptIds', COALESCE(attempt_ids, ARRAY[]::UUID[]),
        'transactionIds', COALESCE(transaction_ids, ARRAY[]::UUID[]),
        'refundIds', COALESCE(refund_ids, ARRAY[]::UUID[])
      )::TEXT;
END;
$$;

CREATE TEMP TABLE payment_migration_evidence ON COMMIT DROP AS
SELECT pa.id AS attempt_id,
       pa.order_id,
       pa.channel,
       NULLIF(btrim(pa.request_snapshot ->> 'providerOrderNo'), '')
         AS provider_evidence,
       NULLIF(btrim(pa.request_snapshot ->> 'orderNo'), '')
         AS order_evidence,
       COALESCE(
         NULLIF(btrim(pa.request_snapshot ->> 'providerOrderNo'), ''),
         NULLIF(btrim(pa.request_snapshot ->> 'orderNo'), ''),
         o.order_no
       ) AS provider_order_no
  FROM payment_attempts pa
  JOIN orders o ON o.id = pa.order_id;

DO $$
DECLARE
  affected_orders UUID[];
  affected_attempts UUID[];
BEGIN
  SELECT array_agg(DISTINCT order_id ORDER BY order_id),
         array_agg(DISTINCT attempt_id ORDER BY attempt_id)
    INTO affected_orders, affected_attempts
    FROM payment_migration_evidence
   WHERE provider_evidence IS NOT NULL
     AND order_evidence IS NOT NULL
     AND provider_evidence <> order_evidence;
  IF affected_attempts IS NOT NULL THEN
    PERFORM pg_temp.raise_payment_migration_diagnostic(
      'PROVIDER_PAYMENT_ORDER_MIGRATION_CONFLICT',
      affected_orders,
      affected_attempts,
      ARRAY[]::UUID[],
      ARRAY[]::UUID[]
    );
  END IF;
END;
$$;

DO $$
DECLARE
  affected_orders UUID[];
  affected_attempts UUID[];
BEGIN
  WITH conflicting_groups AS (
    SELECT order_id, channel
      FROM payment_migration_evidence
     GROUP BY order_id, channel
    HAVING count(DISTINCT provider_order_no) > 1
  )
  SELECT array_agg(DISTINCT evidence.order_id ORDER BY evidence.order_id),
         array_agg(DISTINCT evidence.attempt_id ORDER BY evidence.attempt_id)
    INTO affected_orders, affected_attempts
    FROM payment_migration_evidence evidence
    JOIN conflicting_groups conflict
      ON conflict.order_id = evidence.order_id
     AND conflict.channel = evidence.channel;
  IF affected_attempts IS NOT NULL THEN
    PERFORM pg_temp.raise_payment_migration_diagnostic(
      'PROVIDER_PAYMENT_ORDER_MIGRATION_CONFLICT',
      affected_orders,
      affected_attempts,
      ARRAY[]::UUID[],
      ARRAY[]::UUID[]
    );
  END IF;
END;
$$;

DO $$
DECLARE
  affected_orders UUID[];
  affected_attempts UUID[];
  affected_transactions UUID[];
BEGIN
  WITH conflicting_groups AS (
    SELECT evidence.order_id,
           evidence.channel,
           evidence.provider_order_no
      FROM payment_migration_evidence evidence
      JOIN payment_transactions transaction
        ON transaction.payment_attempt_id = evidence.attempt_id
       AND transaction.status = 'SUCCESS'
     GROUP BY evidence.order_id,
              evidence.channel,
              evidence.provider_order_no
    HAVING count(DISTINCT transaction.id) > 1
       AND NOT EXISTS (
         SELECT 1
           FROM refunds refund
          WHERE refund.order_id = evidence.order_id
            AND refund.channel = evidence.channel
       )
  ), related_attempts AS (
    SELECT evidence.*
      FROM payment_migration_evidence evidence
      JOIN conflicting_groups conflict
        ON conflict.order_id = evidence.order_id
       AND conflict.channel = evidence.channel
       AND conflict.provider_order_no = evidence.provider_order_no
  )
  SELECT array_agg(DISTINCT related.order_id ORDER BY related.order_id),
         array_agg(DISTINCT related.attempt_id ORDER BY related.attempt_id),
         array_agg(DISTINCT transaction.id ORDER BY transaction.id)
    INTO affected_orders, affected_attempts, affected_transactions
    FROM related_attempts related
    JOIN payment_transactions transaction
      ON transaction.payment_attempt_id = related.attempt_id
     AND transaction.status = 'SUCCESS';
  IF affected_transactions IS NOT NULL THEN
    PERFORM pg_temp.raise_payment_migration_diagnostic(
      'PROVIDER_PAYMENT_ORDER_MIGRATION_CONFLICT',
      affected_orders,
      affected_attempts,
      affected_transactions,
      ARRAY[]::UUID[]
    );
  END IF;
END;
$$;

DO $$
DECLARE
  affected_orders UUID[];
  affected_attempts UUID[];
  affected_transactions UUID[];
BEGIN
  WITH conflicting_identities AS (
    SELECT channel, provider_order_no
      FROM payment_migration_evidence
     GROUP BY channel, provider_order_no
    HAVING count(DISTINCT order_id) > 1
  ), related AS (
    SELECT evidence.*
      FROM payment_migration_evidence evidence
      JOIN conflicting_identities conflict
        ON conflict.channel = evidence.channel
       AND conflict.provider_order_no = evidence.provider_order_no
  )
  SELECT array_agg(DISTINCT related.order_id ORDER BY related.order_id),
         array_agg(DISTINCT related.attempt_id ORDER BY related.attempt_id),
         array_agg(DISTINCT transaction.id ORDER BY transaction.id)
           FILTER (WHERE transaction.id IS NOT NULL)
    INTO affected_orders, affected_attempts, affected_transactions
    FROM related
    LEFT JOIN payment_transactions transaction
      ON transaction.payment_attempt_id = related.attempt_id
     AND transaction.status = 'SUCCESS';
  IF affected_attempts IS NOT NULL THEN
    PERFORM pg_temp.raise_payment_migration_diagnostic(
      'PROVIDER_PAYMENT_ORDER_MIGRATION_CONFLICT',
      affected_orders,
      affected_attempts,
      COALESCE(affected_transactions, ARRAY[]::UUID[]),
      ARRAY[]::UUID[]
    );
  END IF;
END;
$$;

DO $$
DECLARE
  affected_orders UUID[];
  affected_attempts UUID[];
BEGIN
  WITH active_candidates AS (
    SELECT pa.id, pa.order_id, pa.channel
      FROM payment_attempts pa
     WHERE pa.channel IN ('wechat_h5', 'alipay_wap')
       AND (
         pa.status IN ('CREATED', 'REDIRECT_READY', 'PENDING', 'FAILED')
         OR pa.reconciliation_state IN ('REQUIRED', 'RETRY_SCHEDULED')
       )
  ), conflicting_orders AS (
    SELECT order_id
      FROM active_candidates
     GROUP BY order_id
    HAVING count(DISTINCT channel) > 1
  )
  SELECT array_agg(DISTINCT candidate.order_id ORDER BY candidate.order_id),
         array_agg(DISTINCT candidate.id ORDER BY candidate.id)
    INTO affected_orders, affected_attempts
    FROM active_candidates candidate
    JOIN conflicting_orders conflict USING (order_id);
  IF affected_attempts IS NOT NULL THEN
    PERFORM pg_temp.raise_payment_migration_diagnostic(
      'MULTI_ACTIVE_PAYMENT_MIGRATION_CONFLICT',
      affected_orders,
      affected_attempts,
      ARRAY[]::UUID[],
      ARRAY[]::UUID[]
    );
  END IF;
END;
$$;

DO $$
DECLARE
  affected_orders UUID[];
  affected_attempts UUID[];
  affected_transactions UUID[];
  affected_refunds UUID[];
BEGIN
  WITH refund_candidates AS (
    SELECT refund.id AS refund_id,
           refund.order_id,
           refund.channel,
           count(DISTINCT transaction.id) AS success_count,
           bool_and(
             transaction.id IS NULL
             OR (
               transaction.payment_attempt_id IS NOT NULL
               AND attempt.id IS NOT NULL
               AND attempt.order_id = refund.order_id
               AND attempt.channel = refund.channel
             )
           ) AS facts_consistent
      FROM refunds refund
      LEFT JOIN payment_transactions transaction
        ON transaction.order_id = refund.order_id
       AND transaction.channel = refund.channel
       AND transaction.status = 'SUCCESS'
      LEFT JOIN payment_attempts attempt
        ON attempt.id = transaction.payment_attempt_id
     GROUP BY refund.id, refund.order_id, refund.channel
  ), bad_refunds AS (
    SELECT *
      FROM refund_candidates
     WHERE success_count <> 1
        OR NOT facts_consistent
  ), related_attempts AS (
    SELECT DISTINCT bad.refund_id, attempt.id, attempt.order_id
      FROM bad_refunds bad
      JOIN payment_attempts attempt
        ON attempt.order_id = bad.order_id
       AND attempt.channel = bad.channel
    UNION
    SELECT DISTINCT bad.refund_id, attempt.id, attempt.order_id
      FROM bad_refunds bad
      JOIN payment_transactions transaction
        ON transaction.order_id = bad.order_id
       AND transaction.channel = bad.channel
       AND transaction.status = 'SUCCESS'
      JOIN payment_attempts attempt
        ON attempt.id = transaction.payment_attempt_id
  ), related_transactions AS (
    SELECT DISTINCT bad.refund_id,
           transaction.id,
           transaction.order_id
      FROM bad_refunds bad
      JOIN payment_transactions transaction
        ON transaction.order_id = bad.order_id
       AND transaction.channel = bad.channel
       AND transaction.status = 'SUCCESS'
  ), all_orders AS (
    SELECT order_id FROM bad_refunds
    UNION
    SELECT order_id FROM related_attempts
    UNION
    SELECT order_id FROM related_transactions
  )
  SELECT (SELECT array_agg(DISTINCT order_id ORDER BY order_id) FROM all_orders),
         (SELECT array_agg(DISTINCT id ORDER BY id) FROM related_attempts),
         (SELECT array_agg(DISTINCT id ORDER BY id) FROM related_transactions),
         (SELECT array_agg(DISTINCT refund_id ORDER BY refund_id) FROM bad_refunds)
    INTO affected_orders,
         affected_attempts,
         affected_transactions,
         affected_refunds;
  IF affected_refunds IS NOT NULL THEN
    PERFORM pg_temp.raise_payment_migration_diagnostic(
      'LEGACY_REFUND_MIGRATION_CONFLICT',
      affected_orders,
      COALESCE(affected_attempts, ARRAY[]::UUID[]),
      COALESCE(affected_transactions, ARRAY[]::UUID[]),
      affected_refunds
    );
  END IF;
END;
$$;

ALTER TABLE payment_attempts
  DROP CONSTRAINT payment_attempts_status_check,
  DROP CONSTRAINT payment_attempts_reconciliation_last_result_check,
  DROP CONSTRAINT payment_attempts_reconciliation_schedule_check,
  DROP CONSTRAINT payment_attempts_reconciliation_state_result_check;

ALTER TABLE payment_attempts
  ADD COLUMN provider_payment_order_id UUID,
  ADD COLUMN provider_identity_role TEXT,
  ADD COLUMN provider_operation_eligible BOOLEAN,
  ADD COLUMN launch_expires_at TIMESTAMPTZ,
  ADD CONSTRAINT payment_attempts_status_check CHECK (
    status IN (
      'CREATED',
      'REDIRECT_READY',
      'PENDING',
      'SUCCEEDED',
      'FAILED',
      'CLOSED',
      'CREATE_UNKNOWN',
      'RECONCILING',
      'CLOSE_UNKNOWN'
    )
  );

CREATE TABLE provider_payment_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('wechat_h5', 'alipay_wap', 'fake')),
  provider_order_no TEXT NOT NULL CHECK (length(btrim(provider_order_no)) > 0),
  origin TEXT NOT NULL CHECK (origin IN ('legacy_order_no', 'attempt_v1')),
  allocated_at TIMESTAMPTZ NOT NULL,
  canonical_attempt_id UUID NOT NULL,
  manual_review_required BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT provider_payment_orders_order_fk
    FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
  CONSTRAINT provider_payment_orders_channel_number_unique
    UNIQUE (channel, provider_order_no),
  CONSTRAINT provider_payment_orders_id_order_channel_unique
    UNIQUE (id, order_id, channel),
  CONSTRAINT provider_payment_orders_attempt_v1_contract CHECK (
    origin = 'legacy_order_no'
    OR (
      channel IN ('wechat_h5', 'alipay_wap')
      AND length(provider_order_no) <= 32
      AND provider_order_no ~ '^(WX|AL)[A-Za-z0-9]+$'
      AND (
        (channel = 'wechat_h5' AND provider_order_no LIKE 'WX%')
        OR (channel = 'alipay_wap' AND provider_order_no LIKE 'AL%')
      )
    )
  )
);

CREATE TEMP TABLE payment_migration_owner_choice ON COMMIT DROP AS
SELECT evidence.order_id,
       evidence.channel,
       evidence.provider_order_no,
       pa.id AS attempt_id,
       pa.created_at,
       row_number() OVER (
         PARTITION BY evidence.order_id,
                      evidence.channel,
                      evidence.provider_order_no
         ORDER BY
           EXISTS (
             SELECT 1
               FROM payment_transactions transaction
              WHERE transaction.payment_attempt_id = pa.id
                AND transaction.status = 'SUCCESS'
           ) DESC,
           (
             pa.status IN ('CREATED', 'REDIRECT_READY', 'PENDING', 'FAILED')
             OR pa.reconciliation_state IN ('REQUIRED', 'RETRY_SCHEDULED')
           ) DESC,
           pa.created_at DESC,
           pa.id DESC
       ) AS owner_rank
  FROM payment_migration_evidence evidence
  JOIN payment_attempts pa ON pa.id = evidence.attempt_id;

INSERT INTO provider_payment_orders(
  order_id,
  channel,
  provider_order_no,
  origin,
  allocated_at,
  canonical_attempt_id,
  manual_review_required
)
SELECT choice.order_id,
       choice.channel,
       choice.provider_order_no,
       'legacy_order_no',
       choice.created_at,
       choice.attempt_id,
       choice.channel = 'fake'
         AND NOT EXISTS (
           SELECT 1
             FROM payment_transactions transaction
             JOIN payment_attempts attempt
               ON attempt.id = transaction.payment_attempt_id
            WHERE attempt.order_id = choice.order_id
              AND attempt.channel = choice.channel
              AND transaction.status = 'SUCCESS'
         )
  FROM payment_migration_owner_choice choice
 WHERE choice.owner_rank = 1;

UPDATE payment_attempts attempt
   SET provider_payment_order_id = identity.id,
       provider_identity_role = CASE
         WHEN identity.canonical_attempt_id = attempt.id
           THEN 'canonical_owner'
         ELSE 'audit_alias'
       END,
       provider_operation_eligible =
         identity.canonical_attempt_id = attempt.id
         AND attempt.channel IN ('wechat_h5', 'alipay_wap'),
       request_snapshot = jsonb_set(
         attempt.request_snapshot,
         '{providerOrderNo}',
         to_jsonb(identity.provider_order_no),
         true
       ),
       status = CASE
         WHEN identity.canonical_attempt_id <> attempt.id THEN 'CLOSED'
         WHEN attempt.channel = 'fake'
              AND identity.manual_review_required THEN 'CLOSED'
         WHEN attempt.channel IN ('wechat_h5', 'alipay_wap')
              AND attempt.status = 'FAILED' THEN 'CREATE_UNKNOWN'
         ELSE attempt.status
       END,
       reconciliation_state = CASE
         WHEN identity.canonical_attempt_id <> attempt.id THEN 'TERMINAL'
         WHEN attempt.channel = 'fake'
              AND identity.manual_review_required THEN 'TERMINAL'
         ELSE attempt.reconciliation_state
       END,
       reconciliation_next_at = CASE
         WHEN identity.canonical_attempt_id <> attempt.id
           OR (attempt.channel = 'fake' AND identity.manual_review_required)
           THEN NULL
         ELSE attempt.reconciliation_next_at
       END,
       reconciliation_deadline_at = CASE
         WHEN identity.canonical_attempt_id <> attempt.id
           OR (attempt.channel = 'fake' AND identity.manual_review_required)
           THEN NULL
         ELSE attempt.reconciliation_deadline_at
       END,
       reconciliation_last_result = CASE
         WHEN identity.canonical_attempt_id <> attempt.id
           THEN 'LEGACY_PROVIDER_IDENTITY_ALIAS'
         WHEN attempt.channel = 'fake'
              AND identity.manual_review_required
           THEN 'LEGACY_FAKE_REQUIRES_MANUAL_REVIEW'
         ELSE attempt.reconciliation_last_result
       END
  FROM provider_payment_orders identity
 WHERE identity.order_id = attempt.order_id
   AND identity.channel = attempt.channel;

ALTER TABLE payment_attempts
  ALTER COLUMN provider_payment_order_id SET NOT NULL,
  ALTER COLUMN provider_identity_role SET NOT NULL,
  ALTER COLUMN provider_operation_eligible SET NOT NULL,
  ADD CONSTRAINT payment_attempts_provider_identity_role_check CHECK (
    provider_identity_role IN ('canonical_owner', 'audit_alias')
  ),
  ADD CONSTRAINT payment_attempts_provider_operation_eligibility_check CHECK (
    provider_operation_eligible = (
      provider_identity_role = 'canonical_owner'
      AND channel IN ('wechat_h5', 'alipay_wap')
    )
  ),
  ADD CONSTRAINT payment_attempts_alias_terminal_check CHECK (
    provider_identity_role <> 'audit_alias'
    OR (
      status = 'CLOSED'
      AND reconciliation_state = 'TERMINAL'
      AND reconciliation_last_result = 'LEGACY_PROVIDER_IDENTITY_ALIAS'
      AND reconciliation_next_at IS NULL
      AND reconciliation_deadline_at IS NULL
      AND NOT provider_operation_eligible
    )
  ),
  ADD CONSTRAINT payment_attempts_id_order_channel_unique
    UNIQUE (id, order_id, channel),
  ADD CONSTRAINT payment_attempts_identity_fk
    FOREIGN KEY (provider_payment_order_id, order_id, channel)
    REFERENCES provider_payment_orders(id, order_id, channel)
    DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE provider_payment_orders
  ADD CONSTRAINT provider_payment_orders_owner_fk
    FOREIGN KEY (canonical_attempt_id, order_id, channel)
    REFERENCES payment_attempts(id, order_id, channel)
    DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE payment_attempts
  ADD CONSTRAINT payment_attempts_reconciliation_last_result_check CHECK (
    reconciliation_last_result IS NULL
    OR reconciliation_last_result IN (
      'LOCAL_CLOSE_PENDING_FINAL_QUERY',
      'QUERY_IN_PROGRESS',
      'QUERY_ERROR',
      'NO_PAYMENT',
      'PAID',
      'DEADLINE_EXCEEDED',
      'NO_PAYMENT_LIMIT_EXCEEDED',
      'PAYMENT_AFTER_EXPIRY',
      'PAYMENT_VERIFICATION_FAILED',
      'DUPLICATE_PAYMENT',
      'ORDER_COMPLETED_BY_OTHER_ATTEMPT',
      'LEGACY_PROVIDER_IDENTITY_ALIAS',
      'LEGACY_FAKE_REQUIRES_MANUAL_REVIEW'
    )
  ),
  ADD CONSTRAINT payment_attempts_reconciliation_schedule_check CHECK (
    (
      reconciliation_state IN ('REQUIRED', 'RETRY_SCHEDULED')
      AND status IN ('CLOSED', 'RECONCILING', 'CLOSE_UNKNOWN')
      AND reconciliation_next_at IS NOT NULL
      AND reconciliation_deadline_at IS NOT NULL
      AND reconciliation_next_at <= reconciliation_deadline_at
    )
    OR (
      reconciliation_state IN ('NONE', 'RECOVERED', 'TERMINAL')
      AND reconciliation_next_at IS NULL
      AND reconciliation_deadline_at IS NULL
    )
  ),
  ADD CONSTRAINT payment_attempts_reconciliation_state_result_check CHECK (
    (reconciliation_state = 'NONE' AND reconciliation_last_result IS NULL)
    OR (
      reconciliation_state = 'REQUIRED'
      AND reconciliation_last_result = 'LOCAL_CLOSE_PENDING_FINAL_QUERY'
    )
    OR (
      reconciliation_state = 'RETRY_SCHEDULED'
      AND reconciliation_last_result IN (
        'QUERY_IN_PROGRESS', 'QUERY_ERROR', 'NO_PAYMENT'
      )
    )
    OR (
      reconciliation_state = 'RECOVERED'
      AND status = 'SUCCEEDED'
      AND reconciliation_last_result = 'PAID'
    )
    OR (
      reconciliation_state = 'TERMINAL'
      AND status = 'CLOSED'
      AND reconciliation_last_result IN (
        'DEADLINE_EXCEEDED',
        'NO_PAYMENT_LIMIT_EXCEEDED',
        'PAYMENT_AFTER_EXPIRY',
        'PAYMENT_VERIFICATION_FAILED',
        'DUPLICATE_PAYMENT',
        'ORDER_COMPLETED_BY_OTHER_ATTEMPT',
        'LEGACY_PROVIDER_IDENTITY_ALIAS',
        'LEGACY_FAKE_REQUIRES_MANUAL_REVIEW'
      )
    )
  );

CREATE UNIQUE INDEX payment_attempts_one_canonical_owner_per_identity
  ON payment_attempts(provider_payment_order_id)
  WHERE provider_identity_role = 'canonical_owner';

CREATE UNIQUE INDEX payment_attempts_one_active_per_order
  ON payment_attempts(order_id)
  WHERE status IN (
    'CREATED',
    'REDIRECT_READY',
    'PENDING',
    'CREATE_UNKNOWN',
    'RECONCILING',
    'CLOSE_UNKNOWN'
  );

CREATE FUNCTION provider_payment_identity_immutable_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.order_id IS DISTINCT FROM OLD.order_id
     OR NEW.channel IS DISTINCT FROM OLD.channel
     OR NEW.provider_order_no IS DISTINCT FROM OLD.provider_order_no
     OR NEW.origin IS DISTINCT FROM OLD.origin
     OR NEW.allocated_at IS DISTINCT FROM OLD.allocated_at
     OR NEW.canonical_attempt_id IS DISTINCT FROM OLD.canonical_attempt_id THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'provider_payment_identity_immutable',
      MESSAGE = 'provider payment identity fields are immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER provider_payment_identity_immutable_trigger
BEFORE UPDATE ON provider_payment_orders
FOR EACH ROW EXECUTE FUNCTION provider_payment_identity_immutable_guard();

CREATE FUNCTION provider_payment_owner_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  owner_attempt payment_attempts%ROWTYPE;
BEGIN
  SELECT * INTO owner_attempt
    FROM payment_attempts
   WHERE id = NEW.canonical_attempt_id;
  IF NOT FOUND
     OR owner_attempt.order_id <> NEW.order_id
     OR owner_attempt.channel <> NEW.channel
     OR owner_attempt.provider_payment_order_id <> NEW.id
     OR owner_attempt.provider_identity_role <> 'canonical_owner' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'provider_payment_owner_guard',
      MESSAGE = 'provider payment identity owner is inconsistent';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER provider_payment_owner_guard_trigger
AFTER INSERT OR UPDATE ON provider_payment_orders
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION provider_payment_owner_guard();

CREATE FUNCTION payment_attempt_provider_owner_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  identity provider_payment_orders%ROWTYPE;
BEGIN
  SELECT * INTO identity
    FROM provider_payment_orders
   WHERE id = NEW.provider_payment_order_id;
  IF NOT FOUND
     OR identity.order_id <> NEW.order_id
     OR identity.channel <> NEW.channel
     OR (
       NEW.provider_identity_role = 'canonical_owner'
       AND identity.canonical_attempt_id <> NEW.id
     )
     OR (
       NEW.provider_identity_role = 'audit_alias'
       AND (
         identity.origin <> 'legacy_order_no'
         OR identity.canonical_attempt_id = NEW.id
       )
     )
     OR EXISTS (
       SELECT 1
         FROM provider_payment_orders other_identity
        WHERE other_identity.canonical_attempt_id = NEW.id
          AND other_identity.id <> NEW.provider_payment_order_id
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'payment_attempts_provider_owner_guard',
      MESSAGE = 'payment attempt provider owner relationship is inconsistent';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER payment_attempt_provider_owner_guard_trigger
AFTER INSERT OR UPDATE ON payment_attempts
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION payment_attempt_provider_owner_guard();

CREATE FUNCTION payment_attempt_write_contract_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  identity_provider_order_no TEXT;
  identity_origin TEXT;
  expected_write_contract TEXT;
BEGIN
  IF NEW.provider_payment_order_id IS NULL THEN
    RETURN NEW;
  END IF;
  expected_write_contract :=
    'identity_v1:' || txid_current()::text;
  IF current_setting('peileme.payment_write_contract', true)
       IS DISTINCT FROM expected_write_contract THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'payment_attempts_write_contract_guard',
      MESSAGE = 'transaction-bound identity_v1 payment write contract is required';
  END IF;
  SELECT provider_order_no, origin
    INTO identity_provider_order_no, identity_origin
    FROM provider_payment_orders
   WHERE id = NEW.provider_payment_order_id;
  IF NEW.status = 'FAILED'
     AND NEW.channel IN ('wechat_h5', 'alipay_wap')
     AND NEW.provider_identity_role = 'canonical_owner'
     AND identity_origin = 'attempt_v1' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'payment_attempts_attempt_v1_failed_forbidden',
      MESSAGE = 'attempt_v1 canonical owners cannot enter FAILED';
  END IF;
  IF NEW.request_snapshot ->> 'providerOrderNo'
       IS DISTINCT FROM identity_provider_order_no THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'payment_attempts_provider_order_no_match',
      MESSAGE = 'request snapshot providerOrderNo must match provider identity';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER payment_attempt_write_contract_guard_trigger
BEFORE INSERT OR UPDATE ON payment_attempts
FOR EACH ROW EXECUTE FUNCTION payment_attempt_write_contract_guard();

ALTER TABLE refunds
  DROP CONSTRAINT refunds_status_check,
  ADD COLUMN provider_refund_no TEXT,
  ADD COLUMN payment_attempt_id UUID,
  ADD COLUMN payment_transaction_id UUID,
  ADD COLUMN request_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN failure_code TEXT,
  ADD COLUMN failure_message TEXT,
  ADD COLUMN succeeded_at TIMESTAMPTZ,
  ADD COLUMN provider_operation_eligible BOOLEAN;

UPDATE refunds refund
   SET provider_refund_no = refund.refund_no,
       payment_attempt_id = transaction.payment_attempt_id,
       payment_transaction_id = transaction.id,
       status = CASE
         WHEN refund.channel = 'fake'
              AND refund.status IN ('PENDING', 'PROCESSING')
           THEN 'FAILED'
         ELSE refund.status
       END,
       failure_code = CASE
         WHEN refund.channel = 'fake'
              AND refund.status IN ('PENDING', 'PROCESSING')
           THEN 'LEGACY_FAKE_REQUIRES_MANUAL_REVIEW'
         ELSE NULL
       END,
       succeeded_at = CASE
         WHEN refund.status = 'SUCCEEDED'
           THEN COALESCE(refund.updated_at, refund.created_at)
         ELSE NULL
       END,
       provider_operation_eligible =
         refund.channel IN ('wechat_h5', 'alipay_wap')
         AND refund.status IN ('PENDING', 'PROCESSING')
  FROM payment_transactions transaction
 WHERE transaction.order_id = refund.order_id
   AND transaction.channel = refund.channel
   AND transaction.status = 'SUCCESS';

ALTER TABLE payment_transactions
  ADD CONSTRAINT payment_transactions_refund_fact_unique
    UNIQUE (id, order_id, payment_attempt_id, channel);

ALTER TABLE refunds
  ALTER COLUMN provider_refund_no SET NOT NULL,
  ALTER COLUMN payment_attempt_id SET NOT NULL,
  ALTER COLUMN payment_transaction_id SET NOT NULL,
  ALTER COLUMN provider_operation_eligible SET NOT NULL,
  ADD CONSTRAINT refunds_status_check CHECK (
    status IN (
      'PENDING',
      'SUBMITTING',
      'UNKNOWN',
      'PROCESSING',
      'SUCCEEDED',
      'FAILED'
    )
  ),
  ADD CONSTRAINT refunds_request_snapshot_check CHECK (
    jsonb_typeof(request_snapshot) = 'object'
  ),
  ADD CONSTRAINT refunds_provider_refund_number_unique
    UNIQUE (channel, provider_refund_no),
  ADD CONSTRAINT refunds_payment_fact_fk
    FOREIGN KEY (
      payment_transaction_id,
      order_id,
      payment_attempt_id,
      channel
    ) REFERENCES payment_transactions(
      id,
      order_id,
      payment_attempt_id,
      channel
    ),
  ADD CONSTRAINT refunds_provider_operation_eligibility_check CHECK (
    provider_operation_eligible = (
      channel IN ('wechat_h5', 'alipay_wap')
      AND status IN ('PENDING', 'SUBMITTING', 'UNKNOWN', 'PROCESSING')
    )
  );

CREATE FUNCTION refund_payment_fact_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  payment_fact payment_transactions%ROWTYPE;
BEGIN
  SELECT * INTO payment_fact
    FROM payment_transactions
   WHERE id = NEW.payment_transaction_id;
  IF NOT FOUND
     OR payment_fact.status <> 'SUCCESS'
     OR payment_fact.order_id <> NEW.order_id
     OR payment_fact.payment_attempt_id IS DISTINCT FROM NEW.payment_attempt_id
     OR payment_fact.channel <> NEW.channel THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'refunds_payment_fact_guard',
      MESSAGE = 'refund must reference one consistent SUCCESS payment fact';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER refund_payment_fact_guard_trigger
BEFORE INSERT OR UPDATE ON refunds
FOR EACH ROW EXECUTE FUNCTION refund_payment_fact_guard();

CREATE FUNCTION payment_transactions_refund_fact_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
       SELECT 1
         FROM refunds refund
        WHERE refund.payment_transaction_id = OLD.id
     )
     AND (
       NEW.id IS DISTINCT FROM OLD.id
       OR NEW.status IS DISTINCT FROM OLD.status
       OR NEW.order_id IS DISTINCT FROM OLD.order_id
       OR NEW.payment_attempt_id IS DISTINCT FROM OLD.payment_attempt_id
       OR NEW.channel IS DISTINCT FROM OLD.channel
       OR NEW.amount_fen IS DISTINCT FROM OLD.amount_fen
       OR NEW.currency IS DISTINCT FROM OLD.currency
       OR NEW.channel_transaction_id IS DISTINCT FROM OLD.channel_transaction_id
       OR NEW.paid_at IS DISTINCT FROM OLD.paid_at
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'payment_transactions_refund_fact_immutable',
      MESSAGE = 'refund-referenced SUCCESS payment fact is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER refund_payment_fact_guard_on_transactions
BEFORE UPDATE ON payment_transactions
FOR EACH ROW EXECUTE FUNCTION payment_transactions_refund_fact_guard();

CREATE TABLE payment_notification_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel TEXT NOT NULL CHECK (channel IN ('wechat_h5', 'alipay_wap')),
  provider_event_id TEXT NOT NULL CHECK (length(btrim(provider_event_id)) > 0),
  dedupe_key TEXT NOT NULL CHECK (length(btrim(dedupe_key)) > 0),
  raw_body BYTEA NOT NULL,
  body_hash TEXT NOT NULL CHECK (body_hash ~ '^[0-9a-f]{64}$'),
  headers JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(headers) = 'object'),
  event_type TEXT NOT NULL CHECK (length(btrim(event_type)) > 0),
  provider_payment_order_id UUID REFERENCES provider_payment_orders(id),
  provider_order_no TEXT,
  provider_transaction_id TEXT,
  verification_status TEXT NOT NULL
    CHECK (verification_status IN ('VERIFIED', 'REJECTED')),
  processing_status TEXT NOT NULL DEFAULT 'RECEIVED'
    CHECK (processing_status IN ('RECEIVED', 'PROCESSING', 'PROCESSED', 'FAILED')),
  payment_attempt_id UUID REFERENCES payment_attempts(id),
  refund_id UUID REFERENCES refunds(id),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error TEXT,
  processed_at TIMESTAMPTZ,
  retention_until TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '180 days'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT payment_notification_events_raw_body_size_check
    CHECK (octet_length(raw_body) <= 262144),
  CONSTRAINT payment_notification_events_provider_event_unique
    UNIQUE (channel, provider_event_id),
  CONSTRAINT payment_notification_events_dedupe_unique
    UNIQUE (channel, dedupe_key)
);

CREATE INDEX payment_notification_events_processing_idx
  ON payment_notification_events(processing_status, created_at, id)
  WHERE processing_status IN ('RECEIVED', 'FAILED');

CREATE INDEX payment_notification_events_retention_idx
  ON payment_notification_events(retention_until, id);

CREATE TABLE payment_notification_conflicts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel TEXT NOT NULL CHECK (channel IN ('wechat_h5', 'alipay_wap')),
  provider_event_id TEXT NOT NULL CHECK (length(btrim(provider_event_id)) > 0),
  payment_notification_event_id UUID NOT NULL
    REFERENCES payment_notification_events(id) ON DELETE CASCADE,
  original_body_hash TEXT NOT NULL CHECK (original_body_hash ~ '^[0-9a-f]{64}$'),
  conflicting_body_hash TEXT NOT NULL CHECK (conflicting_body_hash ~ '^[0-9a-f]{64}$'),
  original_evidence BYTEA NOT NULL,
  conflicting_evidence BYTEA NOT NULL,
  alert_status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (alert_status IN ('PENDING', 'ACKNOWLEDGED', 'RESOLVED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  CONSTRAINT payment_notification_conflicts_hash_difference_check
    CHECK (original_body_hash <> conflicting_body_hash),
  CONSTRAINT payment_notification_conflicts_evidence_size_check
    CHECK (
      octet_length(original_evidence) <= 16384
      AND octet_length(conflicting_evidence) <= 16384
    ),
  CONSTRAINT payment_notification_conflicts_event_hash_unique
    UNIQUE (channel, provider_event_id, conflicting_body_hash)
);
