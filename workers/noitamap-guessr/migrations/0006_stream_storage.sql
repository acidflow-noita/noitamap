-- Existing immutable documents and URLs remain intact. New results may store
-- compressed JSON in a BLOB plus a small, indexable JSON history header.
ALTER TABLE stream_results ADD COLUMN result_gzip BLOB
  CHECK(result_gzip IS NULL OR (typeof(result_gzip)='blob' AND length(result_gzip) BETWEEN 1 AND 1572864));

-- Account for payload plus a conservative 4 KiB per-game allowance for row,
-- index and page overhead. No table-wide SUM is needed during publication.
CREATE TABLE stream_result_storage (
  id INTEGER PRIMARY KEY CHECK(id=1),
  used_bytes INTEGER NOT NULL CHECK(used_bytes>=0),
  games INTEGER NOT NULL CHECK(games>=0)
);
INSERT INTO stream_result_storage(id,used_bytes,games)
  SELECT 1,COALESCE(SUM(bytes+4096),0),COUNT(*) FROM stream_results;
CREATE TRIGGER stream_result_storage_insert AFTER INSERT ON stream_results BEGIN
  UPDATE stream_result_storage SET used_bytes=used_bytes+NEW.bytes+4096,games=games+1 WHERE id=1;
END;
CREATE TRIGGER stream_result_storage_delete AFTER DELETE ON stream_results BEGIN
  UPDATE stream_result_storage SET used_bytes=used_bytes-OLD.bytes-4096,games=games-1 WHERE id=1;
END;
