ALTER TABLE policy_calculation_snapshots
  ADD COLUMN parameter_provenance JSONB NOT NULL DEFAULT '{}'::jsonb;
