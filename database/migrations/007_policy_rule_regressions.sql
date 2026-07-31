ALTER TABLE policy_rule_versions
  ADD COLUMN regression_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (regression_status IN ('pending', 'passed', 'failed')),
  ADD COLUMN regression_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN regression_run_at TIMESTAMPTZ;

UPDATE policy_rule_versions
   SET regression_status = 'passed',
       regression_summary = jsonb_build_object(
         'total', 0,
         'passed', 0,
         'failed', 0,
         'source', 'pre-regression-migration'
       ),
       regression_run_at = coalesce(published_at, updated_at)
 WHERE status IN ('published', 'retired');
