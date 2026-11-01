-- Expand the existing database constraints to ten rounds and 50,000 points.
-- Rebuild only tables whose CHECK limits change.

CREATE TABLE questions_ten (
  challenge_id TEXT NOT NULL REFERENCES challenges(id),
  ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 0 AND 9),
  asset_key TEXT NOT NULL, name TEXT NOT NULL, biome TEXT NOT NULL,
  x REAL NOT NULL, y REAL NOT NULL, seed INTEGER NOT NULL,
  area_json TEXT, clue_json TEXT,
  PRIMARY KEY(challenge_id, ordinal)
);
INSERT INTO questions_ten SELECT * FROM questions;

CREATE TABLE attempts_ten (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
  challenge_id TEXT NOT NULL REFERENCES challenges(id),
  display_name TEXT NOT NULL, started_at INTEGER NOT NULL, round_started_at INTEGER NOT NULL,
  next_round INTEGER NOT NULL DEFAULT 0 CHECK(next_round BETWEEN 0 AND 10),
  score INTEGER NOT NULL DEFAULT 0 CHECK(score BETWEEN 0 AND 50000),
  elapsed_ms INTEGER NOT NULL DEFAULT 0 CHECK(elapsed_ms >= 0), completed_at INTEGER,
  UNIQUE(user_id, challenge_id)
);
INSERT INTO attempts_ten SELECT * FROM attempts;

-- This temporarily references the replacement parent, so dropping the old
-- attempts table cannot affect these copied guesses. RENAME updates the FK.
CREATE TABLE guesses_ten (
  attempt_id TEXT NOT NULL REFERENCES attempts_ten(id),
  ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 0 AND 9),
  request_id TEXT NOT NULL, request_hash TEXT NOT NULL,
  x REAL, y REAL, score INTEGER NOT NULL CHECK(score BETWEEN 0 AND 5000), distance REAL,
  elapsed_ms INTEGER NOT NULL CHECK(elapsed_ms >= 0), accepted_at INTEGER NOT NULL,
  maximum INTEGER NOT NULL DEFAULT 5000, area_score INTEGER, position_score INTEGER,
  PRIMARY KEY(attempt_id, ordinal), UNIQUE(attempt_id, request_id)
);
INSERT INTO guesses_ten SELECT * FROM guesses;

DROP TRIGGER accept_guess;
DROP TRIGGER advance_attempt;
DROP TABLE guesses;
DROP TABLE attempts;
DROP TABLE questions;
ALTER TABLE questions_ten RENAME TO questions;
ALTER TABLE attempts_ten RENAME TO attempts;
ALTER TABLE guesses_ten RENAME TO guesses;

CREATE INDEX attempts_leaderboard ON attempts(challenge_id, next_round, score DESC, elapsed_ms, completed_at);
CREATE INDEX attempts_user ON attempts(user_id, started_at DESC);

CREATE TRIGGER accept_guess BEFORE INSERT ON guesses BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM attempts a JOIN challenges c ON c.id = a.challenge_id
    WHERE a.id = NEW.attempt_id AND a.next_round = NEW.ordinal AND a.completed_at IS NULL
      AND NEW.ordinal < 10 AND c.enabled = 1 AND NEW.accepted_at >= c.opens_at
  ) THEN RAISE(ABORT, 'round_not_current') END;
END;
CREATE TRIGGER advance_attempt AFTER INSERT ON guesses BEGIN
  UPDATE attempts SET next_round = next_round + 1, score = score + NEW.score,
    elapsed_ms = elapsed_ms + NEW.elapsed_ms, round_started_at = NEW.accepted_at,
    completed_at = CASE WHEN next_round = 9 THEN NEW.accepted_at ELSE NULL END
  WHERE id = NEW.attempt_id;
END;
