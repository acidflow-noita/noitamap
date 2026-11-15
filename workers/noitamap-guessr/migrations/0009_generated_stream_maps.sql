CREATE TABLE stream_map_control (
  id INTEGER PRIMARY KEY CHECK(id=1),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1))
);
INSERT INTO stream_map_control(id,enabled) VALUES(1,0);
CREATE TABLE stream_maps (
  day TEXT PRIMARY KEY,
  generated_at INTEGER NOT NULL,
  source_json TEXT NOT NULL CHECK(json_valid(source_json) AND length(source_json)<=131072)
);
