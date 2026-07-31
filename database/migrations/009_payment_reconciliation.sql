ALTER TABLE payment_attempts
  ADD COLUMN reconciliation_state TEXT NOT NULL DEFAULT 'NONE'
    CHECK (
      reconciliation_state IN (
        'NONE',
        'REQUIRED',
        'RETRY_SCHEDULED',
        'RECOVERED',
        'TERMINAL'
      )
    ),
  ADD COLUMN reconciliation_attempt_count INTEGER NOT NULL DEFAULT 0
    CHECK (reconciliation_attempt_count >= 0),
  ADD COLUMN reconciliation_no_payment_count INTEGER NOT NULL DEFAULT 0
    CHECK (reconciliation_no_payment_count >= 0),
  ADD COLUMN reconciliation_query_error_count INTEGER NOT NULL DEFAULT 0
    CHECK (reconciliation_query_error_count >= 0),
  ADD COLUMN reconciliation_next_at TIMESTAMPTZ,
  ADD COLUMN reconciliation_deadline_at TIMESTAMPTZ,
  ADD COLUMN reconciliation_last_result TEXT,
  ADD CONSTRAINT payment_attempts_reconciliation_last_result_check
    CHECK (
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
        'ORDER_COMPLETED_BY_OTHER_ATTEMPT'
      )
    ),
  ADD CONSTRAINT payment_attempts_reconciliation_schedule_check
    CHECK (
      (
        reconciliation_state IN ('REQUIRED', 'RETRY_SCHEDULED')
        AND status = 'CLOSED'
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
  ADD CONSTRAINT payment_attempts_reconciliation_state_result_check
    CHECK (
      (
        reconciliation_state = 'NONE'
        AND reconciliation_last_result IS NULL
      )
      OR (
        reconciliation_state = 'REQUIRED'
        AND reconciliation_last_result =
          'LOCAL_CLOSE_PENDING_FINAL_QUERY'
      )
      OR (
        reconciliation_state = 'RETRY_SCHEDULED'
        AND reconciliation_last_result IN (
          'QUERY_IN_PROGRESS',
          'QUERY_ERROR',
          'NO_PAYMENT'
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
          'ORDER_COMPLETED_BY_OTHER_ATTEMPT'
        )
      )
    );

WITH ranked_legacy_attempts AS (
  SELECT
    pa.id,
    row_number() OVER (
      PARTITION BY pa.order_id, pa.channel
      ORDER BY pa.created_at DESC, pa.id DESC
    ) AS channel_rank
  FROM payment_attempts pa
  JOIN orders o ON o.id = pa.order_id
  WHERE o.status = 'CLOSED'
    AND pa.status IN (
      'CREATED',
      'REDIRECT_READY',
      'PENDING',
      'FAILED',
      'CLOSED'
    )
)
UPDATE payment_attempts pa
SET status = 'CLOSED',
    reconciliation_state = 'REQUIRED',
    reconciliation_attempt_count = 0,
    reconciliation_no_payment_count = 0,
    reconciliation_query_error_count = 0,
    reconciliation_next_at = now() + interval '30 seconds',
    reconciliation_deadline_at = now() + interval '24 hours',
    reconciliation_last_result = 'LOCAL_CLOSE_PENDING_FINAL_QUERY',
    updated_at = now()
FROM ranked_legacy_attempts ranked
WHERE ranked.id = pa.id
  AND ranked.channel_rank = 1;

CREATE UNIQUE INDEX
  payment_attempts_one_scheduled_reconciliation_per_channel
  ON payment_attempts(order_id, channel)
  WHERE reconciliation_state IN ('REQUIRED', 'RETRY_SCHEDULED');

CREATE INDEX payment_attempts_reconciliation_due_idx
  ON payment_attempts(channel, reconciliation_next_at, updated_at, id)
  WHERE reconciliation_state IN ('REQUIRED', 'RETRY_SCHEDULED');

CREATE INDEX payment_attempts_reconciliation_deadline_due_idx
  ON payment_attempts(channel, reconciliation_deadline_at, updated_at, id)
  WHERE reconciliation_state IN ('REQUIRED', 'RETRY_SCHEDULED');

CREATE INDEX orders_open_reconciliation_due_idx
  ON orders(expires_at, status, updated_at, id)
  WHERE status IN ('CREATED', 'PAYING', 'PAYMENT_FAILED');
