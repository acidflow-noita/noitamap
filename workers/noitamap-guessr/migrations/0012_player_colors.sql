-- Presentation fallback. Published scores and their original colors stay immutable.
CREATE TABLE stream_player_colors (
  player_id TEXT PRIMARY KEY, color TEXT NOT NULL, seen_at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE TABLE stream_color_backfill (
  game_id TEXT PRIMARY KEY REFERENCES stream_results(id) ON DELETE CASCADE
) WITHOUT ROWID;
INSERT INTO stream_color_backfill(game_id) SELECT id FROM stream_results;
CREATE TRIGGER stream_color_queue_insert AFTER INSERT ON stream_results BEGIN
  INSERT INTO stream_color_backfill(game_id) VALUES(NEW.id);
END;
