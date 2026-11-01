-- One immutable bounded document per game. No players, rounds or read counters.
CREATE TABLE stream_results (
  id TEXT PRIMARY KEY NOT NULL,
  owner TEXT NOT NULL,
  day TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  bytes INTEGER NOT NULL CHECK(bytes > 0 AND bytes <= 1572864),
  digest TEXT NOT NULL,
  result_json TEXT NOT NULL CHECK(json_valid(result_json))
);
CREATE INDEX stream_results_day ON stream_results(day);
CREATE INDEX stream_results_owner_day ON stream_results(owner,day);
CREATE TRIGGER stream_results_no_update BEFORE UPDATE ON stream_results BEGIN
  SELECT RAISE(ABORT, 'Published stream results are immutable');
END;
