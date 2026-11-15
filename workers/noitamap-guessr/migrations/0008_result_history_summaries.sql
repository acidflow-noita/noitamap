-- Totals for older compressed results. The immutable result remains untouched.
-- New results include the same summary in their existing metadata row.
CREATE TABLE stream_result_history (
  result_id TEXT PRIMARY KEY REFERENCES stream_results(id) ON DELETE CASCADE,
  summary_json TEXT NOT NULL CHECK(json_valid(summary_json)),
  bytes INTEGER NOT NULL CHECK(bytes>0)
);
CREATE TRIGGER stream_result_history_insert AFTER INSERT ON stream_result_history BEGIN
  UPDATE stream_result_storage SET used_bytes=used_bytes+NEW.bytes+4096 WHERE id=1;
END;
CREATE TRIGGER stream_result_history_delete AFTER DELETE ON stream_result_history BEGIN
  UPDATE stream_result_storage SET used_bytes=used_bytes-OLD.bytes-4096 WHERE id=1;
END;
CREATE TRIGGER stream_result_history_immutable BEFORE UPDATE ON stream_result_history BEGIN
  SELECT RAISE(ABORT, 'Published history summaries are immutable');
END;
