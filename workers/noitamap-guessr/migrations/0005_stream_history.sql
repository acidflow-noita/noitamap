-- Find a channel's completed games without scanning large result documents.
-- Existing immutable results are included without rewriting their rows.
CREATE INDEX stream_results_channel_history ON stream_results(
  json_extract(result_json, '$.host.login'), created_at DESC, id DESC
);
