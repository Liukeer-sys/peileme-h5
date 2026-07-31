ALTER TABLE analytics_events
  ADD COLUMN source TEXT NOT NULL DEFAULT 'client'
    CHECK (source IN ('client', 'server')),
  ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 1
    CHECK (schema_version > 0);

CREATE INDEX analytics_events_server_facts_idx
  ON analytics_events(event_name, occurred_at DESC)
  WHERE source = 'server';

ALTER TABLE announcements
  ADD COLUMN revision INTEGER NOT NULL DEFAULT 1
    CHECK (revision > 0);

ALTER TABLE regional_parameters
  ADD COLUMN revision INTEGER NOT NULL DEFAULT 1
    CHECK (revision > 0);

ALTER TABLE admin_audit_logs
  ADD COLUMN actor_role TEXT,
  ADD COLUMN request_id TEXT;

CREATE INDEX admin_audit_logs_actor_time_idx
  ON admin_audit_logs(admin_user_id, created_at DESC);

CREATE TABLE app_errors (
  id BIGSERIAL PRIMARY KEY,
  request_id TEXT,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  code TEXT NOT NULL,
  message TEXT NOT NULL,
  status_code INTEGER NOT NULL DEFAULT 500 CHECK (status_code BETWEEN 400 AND 599),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  product_channel TEXT CHECK (product_channel IN ('main', 'ai', 'admin')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX app_errors_time_idx ON app_errors(created_at DESC);

ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (
  role IN (
    'user', 'admin', 'policy_editor', 'policy_reviewer', 'operations',
    'finance', 'support', 'ai_operator', 'auditor', 'analyst'
  )
);

ALTER TABLE role_capabilities DROP CONSTRAINT role_capabilities_role_check;
ALTER TABLE role_capabilities ADD CONSTRAINT role_capabilities_role_check CHECK (
  role IN (
    'user', 'admin', 'policy_editor', 'policy_reviewer', 'operations',
    'finance', 'support', 'ai_operator', 'auditor', 'analyst'
  )
);

CREATE TABLE operational_job_runs (
  id BIGSERIAL PRIMARY KEY,
  job_name TEXT NOT NULL CHECK (length(btrim(job_name)) BETWEEN 1 AND 100),
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  CHECK (
    (status = 'running' AND finished_at IS NULL) OR
    (status <> 'running' AND finished_at IS NOT NULL)
  )
);

CREATE INDEX operational_job_runs_name_time_idx
  ON operational_job_runs(job_name, started_at DESC);
CREATE INDEX operational_job_runs_failed_time_idx
  ON operational_job_runs(started_at DESC)
  WHERE status = 'failed';
