PRAGMA foreign_keys = ON;
CREATE TABLE challenges (
  id TEXT PRIMARY KEY,
  day TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  opens_at INTEGER NOT NULL,
  closes_at INTEGER NOT NULL,
  reveal_at INTEGER NOT NULL,
  bounds_json TEXT NOT NULL,
  round_seconds INTEGER NOT NULL CHECK(round_seconds BETWEEN 15 AND 600),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
  CHECK(opens_at < closes_at AND closes_at <= reveal_at)
);
CREATE TABLE questions (
  challenge_id TEXT NOT NULL REFERENCES challenges(id),
  ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 0 AND 4),
  asset_key TEXT NOT NULL,
  name TEXT NOT NULL,
  biome TEXT NOT NULL,
  x REAL NOT NULL,
  y REAL NOT NULL,
  seed INTEGER NOT NULL,
  PRIMARY KEY(challenge_id, ordinal)
);
CREATE TABLE attempts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  challenge_id TEXT NOT NULL REFERENCES challenges(id),
  display_name TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  round_started_at INTEGER NOT NULL,
  next_round INTEGER NOT NULL DEFAULT 0 CHECK(next_round BETWEEN 0 AND 5),
  score INTEGER NOT NULL DEFAULT 0 CHECK(score BETWEEN 0 AND 25000),
  elapsed_ms INTEGER NOT NULL DEFAULT 0 CHECK(elapsed_ms >= 0),
  completed_at INTEGER,
  UNIQUE(user_id, challenge_id)
);
CREATE TABLE guesses (
  attempt_id TEXT NOT NULL REFERENCES attempts(id),
  ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 0 AND 4),
  request_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  x REAL,
  y REAL,
  score INTEGER NOT NULL CHECK(score BETWEEN 0 AND 5000),
  distance REAL,
  elapsed_ms INTEGER NOT NULL CHECK(elapsed_ms >= 0),
  accepted_at INTEGER NOT NULL,
  PRIMARY KEY(attempt_id, ordinal),
  UNIQUE(attempt_id, request_id)
);
CREATE TABLE usage_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX attempts_leaderboard ON attempts(challenge_id, next_round, score DESC, elapsed_ms, completed_at);
CREATE INDEX attempts_user ON attempts(user_id, started_at DESC);
CREATE INDEX usage_expiry ON usage_limits(expires_at);

-- Acceptance and progress are one atomic database operation. Retrying a guess
-- cannot advance twice, even with concurrent Worker instances/tabs.
CREATE TRIGGER accept_guess BEFORE INSERT ON guesses BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM attempts a JOIN challenges c ON c.id = a.challenge_id
    WHERE a.id = NEW.attempt_id AND a.next_round = NEW.ordinal AND a.completed_at IS NULL
      AND c.enabled = 1 AND NEW.accepted_at >= c.opens_at
  ) THEN RAISE(ABORT, 'round_not_current') END;
END;
CREATE TRIGGER advance_attempt AFTER INSERT ON guesses BEGIN
  UPDATE attempts SET next_round = next_round + 1, score = score + NEW.score,
    elapsed_ms = elapsed_ms + NEW.elapsed_ms, round_started_at = NEW.accepted_at,
    completed_at = CASE WHEN next_round = 4 THEN NEW.accepted_at ELSE NULL END
  WHERE id = NEW.attempt_id;
END;
