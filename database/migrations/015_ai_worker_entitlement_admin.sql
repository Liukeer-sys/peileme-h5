ALTER TABLE ai_jobs
  ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0
    CHECK (attempt_count >= 0),
  ADD COLUMN available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN claimed_by TEXT,
  ADD COLUMN claimed_at TIMESTAMPTZ,
  ADD COLUMN lease_expires_at TIMESTAMPTZ;

CREATE INDEX ai_jobs_worker_queue_idx
  ON ai_jobs(available_at, created_at, id)
  WHERE status = 'QUEUED';

CREATE INDEX ai_jobs_expired_lease_idx
  ON ai_jobs(lease_expires_at, id)
  WHERE status = 'RUNNING';

CREATE TABLE service_heartbeats (
  service_name TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('starting', 'healthy', 'stopping')),
  detail JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(detail) = 'object'),
  seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
