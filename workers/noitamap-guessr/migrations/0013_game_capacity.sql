-- The usage observer runs outside the game API. Holds survive the UTC rollover.
CREATE TABLE guessr_capacity (
  id INTEGER PRIMARY KEY CHECK(id=1),
  day_start INTEGER NOT NULL DEFAULT 0,
  measured_through INTEGER NOT NULL DEFAULT 0,
  checked_at INTEGER NOT NULL DEFAULT 0,
  used_requests INTEGER NOT NULL DEFAULT 0 CHECK(used_requests>=0),
  background_requests INTEGER NOT NULL DEFAULT 0 CHECK(background_requests>=0),
  peak_per_minute INTEGER NOT NULL DEFAULT 0 CHECK(peak_per_minute>=0),
  held_requests INTEGER NOT NULL DEFAULT 0 CHECK(held_requests>=0),
  paused_until INTEGER NOT NULL DEFAULT 0
);
INSERT INTO guessr_capacity(id) VALUES(1);
CREATE TABLE guessr_finish_holds (
  game TEXT NOT NULL, seat TEXT NOT NULL, requests INTEGER NOT NULL CHECK(requests>0),
  release_after INTEGER NOT NULL, PRIMARY KEY(game,seat)
) WITHOUT ROWID;
CREATE INDEX guessr_finish_hold_expiry ON guessr_finish_holds(release_after);
CREATE TRIGGER guessr_hold_add AFTER INSERT ON guessr_finish_holds BEGIN
  UPDATE guessr_capacity SET held_requests=held_requests+NEW.requests WHERE id=1;
END;
-- Credit completed rounds only after the outside usage observer covers their requests.
CREATE TABLE guessr_capacity_progress (
  game TEXT PRIMARY KEY, credit INTEGER NOT NULL CHECK(credit>=0), at INTEGER NOT NULL
) WITHOUT ROWID;

-- A short provisional claim becomes durable in the same transaction as the ranked attempt.
CREATE TRIGGER guessr_ranked_started AFTER INSERT ON attempts BEGIN
  UPDATE guessr_finish_holds SET release_after=9007199254740991 WHERE game=NEW.id AND seat='';
END;
CREATE TRIGGER guessr_ranked_progress AFTER UPDATE OF next_round ON attempts
WHEN NEW.next_round>OLD.next_round AND NEW.completed_at IS NULL BEGIN
  INSERT INTO guessr_capacity_progress(game,credit,at)
    SELECT game,max(0,requests-(4+8*(10-NEW.next_round))),NEW.round_started_at FROM guessr_finish_holds WHERE game=NEW.id AND seat=''
    ON CONFLICT(game) DO UPDATE SET credit=excluded.credit,at=excluded.at;
END;
CREATE TRIGGER guessr_ranked_finished AFTER UPDATE OF completed_at ON attempts
WHEN OLD.completed_at IS NULL AND NEW.completed_at IS NOT NULL BEGIN
  UPDATE guessr_finish_holds SET release_after=NEW.completed_at WHERE game=NEW.id;
END;
CREATE TRIGGER guessr_multiplayer_published AFTER INSERT ON stream_results BEGIN
  UPDATE guessr_finish_holds SET release_after=min(release_after,NEW.created_at) WHERE game=NEW.id;
END;
-- Existing unfinished Dailies keep their remaining rounds across UTC dates.
INSERT INTO guessr_finish_holds(game,seat,requests,release_after)
  SELECT id,'',4+8*(10-next_round),9007199254740991 FROM attempts WHERE completed_at IS NULL AND next_round<10;
-- Old live coordinators did not report a roster to D1. Cover the maximum supported roster/rounds
-- during the one-time transition. These holds expire with the old rooms or release on publication.
INSERT INTO guessr_finish_holds(game,seat,requests,release_after)
  SELECT a.id,'legacy',2+1500*(2+2*10),a.created_at+86400000 FROM stream_game_admissions a
  WHERE a.created_at>1000*unixepoch()-86400000 AND NOT EXISTS(SELECT 1 FROM stream_results r WHERE r.id=a.id);

-- Returning credits and advancing the time covered by usage are one atomic update.
CREATE TRIGGER guessr_observe_capacity AFTER UPDATE OF measured_through ON guessr_capacity
WHEN NEW.measured_through>=OLD.measured_through BEGIN
  DELETE FROM guessr_finish_holds WHERE release_after<=NEW.measured_through;
  DELETE FROM guessr_capacity_progress WHERE NOT EXISTS(SELECT 1 FROM guessr_finish_holds h WHERE h.game=guessr_capacity_progress.game);
  UPDATE guessr_capacity SET held_requests=(
    SELECT coalesce(sum(max(0,room.gross-coalesce(p.credit,0))),0) FROM
      (SELECT game,sum(requests) AS gross FROM guessr_finish_holds GROUP BY game) room
      LEFT JOIN guessr_capacity_progress p ON p.game=room.game AND p.at<=NEW.measured_through
  ) WHERE id=1;
END;
