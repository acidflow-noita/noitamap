-- Prepared, reusable clue tiles and area scoring replace fixed Daily crops.
ALTER TABLE challenges ADD COLUMN image_config_json TEXT;
ALTER TABLE challenges ADD COLUMN dataset_version TEXT;
ALTER TABLE challenges ADD COLUMN publication_hash TEXT;
ALTER TABLE challenges ADD COLUMN publication_created_at INTEGER;
ALTER TABLE questions ADD COLUMN area_json TEXT;
ALTER TABLE questions ADD COLUMN clue_json TEXT;
ALTER TABLE guesses ADD COLUMN maximum INTEGER NOT NULL DEFAULT 5000;
ALTER TABLE guesses ADD COLUMN area_score INTEGER;
ALTER TABLE guesses ADD COLUMN position_score INTEGER;
