CREATE TABLE ai_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('severance_analysis', 'document_review')),
  product_channel TEXT NOT NULL DEFAULT 'ai' CHECK (product_channel = 'ai'),
  status TEXT NOT NULL CHECK (
    status IN (
      'QUEUED',
      'AWAITING_ENTITLEMENT',
      'RUNNING',
      'COMPLETED',
      'FAILED_FINAL'
    )
  ),
  progress INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  idempotency_key TEXT NOT NULL CHECK (length(btrim(idempotency_key)) BETWEEN 8 AND 120),
  input_hash TEXT NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  input_metadata JSONB NOT NULL CHECK (jsonb_typeof(input_metadata) = 'object'),
  upload_metadata JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(upload_metadata) = 'array'),
  entitlement_usage_id UUID REFERENCES entitlement_usages(id) ON DELETE SET NULL,
  selected_provider TEXT,
  selected_model TEXT,
  failure_code TEXT,
  failure_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  UNIQUE (user_id, idempotency_key)
);

CREATE INDEX ai_jobs_user_time_idx ON ai_jobs(user_id, created_at DESC);
CREATE INDEX ai_jobs_status_time_idx ON ai_jobs(status, updated_at DESC);

CREATE TABLE ai_job_events (
  id BIGSERIAL PRIMARY KEY,
  job_id UUID NOT NULL REFERENCES ai_jobs(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status TEXT NOT NULL,
  progress INTEGER NOT NULL CHECK (progress BETWEEN 0 AND 100),
  detail JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(detail) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ai_job_events_job_idx ON ai_job_events(job_id, id);

CREATE TABLE ai_provider_attempts (
  id BIGSERIAL PRIMARY KEY,
  job_id UUID NOT NULL REFERENCES ai_jobs(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  provider_key TEXT NOT NULL,
  model TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'failed')),
  error_code TEXT,
  latency_ms INTEGER NOT NULL CHECK (latency_ms >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (job_id, ordinal)
);

CREATE INDEX ai_provider_attempts_job_idx
  ON ai_provider_attempts(job_id, ordinal);

CREATE TABLE ai_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL UNIQUE REFERENCES ai_jobs(id) ON DELETE CASCADE,
  schema_version TEXT NOT NULL,
  content JSONB NOT NULL CHECK (jsonb_typeof(content) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
