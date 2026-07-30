CREATE TABLE policy_result_shares (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assessment_id UUID NOT NULL
    REFERENCES assessments(id) ON DELETE CASCADE,
  owner_user_id UUID NOT NULL
    REFERENCES users(id) ON DELETE CASCADE,
  token_hash CHAR(64) NOT NULL UNIQUE
    CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  last_accessed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at)
);

CREATE INDEX policy_result_shares_owner_idx
  ON policy_result_shares(owner_user_id, created_at DESC);

CREATE INDEX policy_result_shares_active_expiry_idx
  ON policy_result_shares(expires_at)
  WHERE revoked_at IS NULL;
