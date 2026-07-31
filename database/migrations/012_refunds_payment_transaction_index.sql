-- migrate:no-transaction
DROP INDEX CONCURRENTLY IF EXISTS refunds_payment_transaction_idx;
-- migrate:statement-break
CREATE INDEX CONCURRENTLY refunds_payment_transaction_idx
  ON refunds(payment_transaction_id);
