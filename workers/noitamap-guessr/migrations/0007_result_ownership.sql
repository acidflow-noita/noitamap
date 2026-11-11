-- Beta security cutover. The owner approved discarding old test statistics.
-- Old compressed history headers lack stable host IDs, so do not infer identity
-- from recyclable logins. Daily attempts and challenges are untouched.
DELETE FROM stream_results;
ALTER TABLE stream_results ADD COLUMN host_id TEXT NOT NULL DEFAULT '';
ALTER TABLE stream_results ADD COLUMN host_verified_at INTEGER NOT NULL DEFAULT 0;
DROP INDEX stream_results_channel_history;
CREATE INDEX stream_results_host_history ON stream_results(host_id,created_at DESC,id DESC);
CREATE TABLE stream_channels (
  twitch_id TEXT PRIMARY KEY,
  login TEXT NOT NULL UNIQUE,
  verified_at INTEGER NOT NULL
);
CREATE TABLE stream_result_removals (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  host_id TEXT NOT NULL,
  deleted_at INTEGER NOT NULL
);
-- Alias maintenance occurs once on publication, never when viewers read.
CREATE TRIGGER stream_channel_publication AFTER INSERT ON stream_results
WHEN NEW.host_id <> '' AND NEW.host_verified_at >= COALESCE((SELECT verified_at FROM stream_channels WHERE twitch_id=NEW.host_id),0)
BEGIN
  DELETE FROM stream_channels WHERE verified_at<=NEW.host_verified_at
    AND (twitch_id=NEW.host_id OR login=json_extract(NEW.result_json,'$.host.login'));
  INSERT OR IGNORE INTO stream_channels(twitch_id,login,verified_at)
    VALUES(NEW.host_id,json_extract(NEW.result_json,'$.host.login'),NEW.host_verified_at);
END;
