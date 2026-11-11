CREATE TABLE auth_sessions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES auth_accounts(id),
  account_version INTEGER NOT NULL,
  refresh_version INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  refreshed_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX auth_session_expiry ON auth_sessions(expires_at);
CREATE INDEX auth_session_account ON auth_sessions(account_id);
ALTER TABLE auth_link_intents ADD COLUMN session_format INTEGER NOT NULL DEFAULT 1;
