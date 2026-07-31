CREATE INDEX IF NOT EXISTS refunds_payment_transaction_idx
  ON refunds(payment_transaction_id);
