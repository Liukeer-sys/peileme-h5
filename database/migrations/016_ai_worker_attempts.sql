ALTER TABLE ai_provider_attempts
  ADD COLUMN job_attempt INTEGER NOT NULL DEFAULT 1
    CHECK (job_attempt > 0);

ALTER TABLE ai_provider_attempts
  DROP CONSTRAINT ai_provider_attempts_job_id_ordinal_key;

ALTER TABLE ai_provider_attempts
  ADD CONSTRAINT ai_provider_attempts_job_attempt_ordinal_unique
    UNIQUE (job_id, job_attempt, ordinal);
