CREATE TABLE guessr_polls (
  id TEXT PRIMARY KEY,
  opens_at INTEGER NOT NULL,
  closes_at INTEGER NOT NULL CHECK (closes_at > opens_at),
  yes_count INTEGER NOT NULL DEFAULT 0,
  no_count INTEGER NOT NULL DEFAULT 0,
  CHECK (id <> 'hard-puzzles-v1' OR closes_at - opens_at = 259200)
) WITHOUT ROWID;

CREATE TABLE guessr_votes (
  id INTEGER PRIMARY KEY,
  poll_id TEXT NOT NULL REFERENCES guessr_polls(id),
  account_id TEXT NOT NULL REFERENCES auth_accounts(id),
  choice TEXT NOT NULL CHECK (choice IN ('yes', 'no')),
  cast_at INTEGER NOT NULL,
  UNIQUE (account_id, poll_id)
);

CREATE TRIGGER guessr_vote_cast AFTER INSERT ON guessr_votes BEGIN
  UPDATE guessr_polls SET yes_count = yes_count + (NEW.choice = 'yes'),
    no_count = no_count + (NEW.choice = 'no') WHERE id = NEW.poll_id;
END;

CREATE TRIGGER guessr_vote_removed AFTER DELETE ON guessr_votes BEGIN
  UPDATE guessr_polls SET yes_count = yes_count - (OLD.choice = 'yes'),
    no_count = no_count - (OLD.choice = 'no') WHERE id = OLD.poll_id;
END;

-- An account link can absorb an existing single-provider account. Transfer
-- its ballots in the same transaction, keeping the first cast for each poll.
CREATE TRIGGER guessr_merge_votes AFTER UPDATE OF account_id ON auth_identities
WHEN NEW.account_id <> OLD.account_id
  AND NOT EXISTS (SELECT 1 FROM auth_identities WHERE account_id = OLD.account_id)
BEGIN
  DELETE FROM guessr_votes WHERE id IN (
    SELECT MAX(id) FROM guessr_votes WHERE account_id IN (OLD.account_id, NEW.account_id)
    GROUP BY poll_id HAVING COUNT(*) > 1
  );
  UPDATE guessr_votes SET account_id = NEW.account_id WHERE account_id = OLD.account_id;
END;
