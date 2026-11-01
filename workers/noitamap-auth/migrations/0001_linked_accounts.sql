CREATE TABLE auth_accounts (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE auth_identities (
  provider TEXT NOT NULL CHECK (provider IN ('patreon', 'twitch')),
  provider_user_id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES auth_accounts(id),
  username TEXT NOT NULL,
  nickname TEXT,
  login TEXT,
  is_follower INTEGER NOT NULL,
  is_subscriber INTEGER NOT NULL,
  checked_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'reconnect')),
  credentials TEXT NOT NULL,
  refresh_lock TEXT,
  refresh_lock_until INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (provider, provider_user_id),
  UNIQUE (account_id, provider)
);
CREATE TABLE auth_link_intents (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES auth_accounts(id),
  account_version INTEGER NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('patreon', 'twitch')),
  chat INTEGER NOT NULL DEFAULT 0,
  redirect_url TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  started INTEGER NOT NULL DEFAULT 0,
  candidate TEXT,
  completion TEXT UNIQUE
);
CREATE INDEX auth_link_expiry ON auth_link_intents(expires_at);
CREATE TRIGGER auth_unlink_revoke AFTER DELETE ON auth_identities BEGIN
  UPDATE auth_accounts SET version = version + 1 WHERE id = OLD.account_id;
END;
CREATE TRIGGER auth_merge_revoke AFTER UPDATE OF account_id ON auth_identities
WHEN OLD.account_id <> NEW.account_id BEGIN
  UPDATE auth_accounts SET version = version + 1 WHERE id = OLD.account_id;
END;
