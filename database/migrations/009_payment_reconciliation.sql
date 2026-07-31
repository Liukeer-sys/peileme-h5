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
        AND reconciliation_next_at IS NOT NULL
        AND reconciliation_deadline_at IS NOT NULL
      )
      OR (
        reconciliation_state IN ('NONE', 'RECOVERED', 'TERMINAL')
        AND reconciliation_next_at IS NULL
        AND reconciliation_deadline_at IS NULL
      )
    );

CREATE INDEX payment_attempts_reconciliation_due_idx
  ON payment_attempts(channel, reconciliation_next_at, updated_at, id)
  WHERE reconciliation_state IN ('REQUIRED', 'RETRY_SCHEDULED');
