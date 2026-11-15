CREATE TABLE stream_game_admissions (
  id TEXT PRIMARY KEY,
  host_id TEXT NOT NULL,
  day TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX stream_game_admissions_day_host ON stream_game_admissions(day,host_id);
CREATE INDEX stream_game_admissions_created ON stream_game_admissions(created_at);
CREATE TRIGGER stream_game_admissions_expire AFTER INSERT ON stream_game_admissions BEGIN
  DELETE FROM stream_game_admissions WHERE created_at<NEW.created_at-2764800000;
END;
