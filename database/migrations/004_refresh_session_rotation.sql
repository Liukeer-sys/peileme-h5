ALTER TABLE refresh_sessions
  ADD COLUMN IF NOT EXISTS parent_session_id UUID
    REFERENCES refresh_sessions(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS refresh_sessions_parent_unique_idx
  ON refresh_sessions(parent_session_id)
  WHERE parent_session_id IS NOT NULL;
