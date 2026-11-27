ALTER TABLE stream_results ADD COLUMN replay_bytes INTEGER NOT NULL DEFAULT 0 CHECK(replay_bytes >= 0);
CREATE TABLE stream_result_replay_pages (
  game_id TEXT NOT NULL REFERENCES stream_results(id) ON DELETE CASCADE,
  round INTEGER NOT NULL CHECK(round BETWEEN 1 AND 10),
  first_player TEXT NOT NULL,
  payload TEXT NOT NULL CHECK(json_valid(payload)),
  PRIMARY KEY(game_id, round, first_player)
) WITHOUT ROWID;
CREATE TRIGGER stream_result_replays_reserve AFTER INSERT ON stream_results WHEN NEW.replay_bytes > 0 BEGIN
  UPDATE stream_result_storage SET used_bytes=used_bytes+NEW.replay_bytes WHERE id=1;
END;
CREATE TRIGGER stream_result_replays_release AFTER DELETE ON stream_results WHEN OLD.replay_bytes > 0 BEGIN
  UPDATE stream_result_storage SET used_bytes=used_bytes-OLD.replay_bytes WHERE id=1;
END;
