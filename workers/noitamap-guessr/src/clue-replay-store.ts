import type { Database } from './index';
import type { ParallelIdentity } from '../../../src/guessr/parallel-types';
import type { ParallelRecord } from '../../../src/guessr/parallel-core';
import { ParallelActionError } from '../../../src/guessr/parallel-core';
import type { StreamGame } from '../../../src/guessr/stream-types';
import { STREAM_DELIVERY_GRACE_MS, STREAM_START_COUNTDOWN_MS } from '../../../src/guessr/stream-timing';
import {
  encodeReplayFrames,
  publicClueReplay,
  ENCODED_FRAME_SIZE,
  type StoredClueTrack,
  type StoredGuessStep,
  REPLAY_BATCH,
  REPLAY_LIMIT,
  validReplayFrame,
  type ClueReplay,
  type ReplayFrame,
} from '../../../src/guessr/clue-replay';

export function createReplayTable(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS clue_replays (
    round INTEGER NOT NULL, player TEXT NOT NULL, last_at INTEGER NOT NULL, frames INTEGER NOT NULL, track TEXT NOT NULL,
    opens INTEGER, guesses TEXT NOT NULL DEFAULT '[]', partial INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(round,player)) WITHOUT ROWID`);
  const columns = sql.exec<{ name: string }>('PRAGMA table_info(clue_replays)').toArray();
  if (!columns.some(c => c.name === 'opens')) {
    sql.exec('ALTER TABLE clue_replays ADD COLUMN opens INTEGER');
    sql.exec("ALTER TABLE clue_replays ADD COLUMN guesses TEXT NOT NULL DEFAULT '[]'");
    sql.exec('ALTER TABLE clue_replays ADD COLUMN partial INTEGER NOT NULL DEFAULT 0');
  }
}

type TrackRow = { track: string; opens: number | null; guesses: string; partial: number };
function privateTrack(row: TrackRow): StoredClueTrack {
  return {
    track: row.track,
    opens: row.opens,
    guesses: JSON.parse(row.guesses) as StoredGuessStep[],
    ...(row.partial ? { partial: true } : {}),
  };
}
const maxTrackBytes = REPLAY_LIMIT * ENCODED_FRAME_SIZE;

export interface AcceptedReplayGuess {
  round: number;
  player: string;
  opens: number;
  step: StoredGuessStep;
}
/** Capture the authorized revision before ticking can advance the round. Persist it in the guess transaction. */
export function acceptedReplayGuess(
  game: StreamGame,
  round: number,
  player: string
): AcceptedReplayGuess | undefined {
  if (!game.session.clueReplays) return;
  const guess = game.participants.find(p => p.id === player)?.guesses[round];
  if (!guess?.point) return;
  const opensAt = player === game.session.host.id ? game.openedAt : game.timing?.windows[round]?.opensAt;
  if (opensAt == null) return;
  return {
    round: round + 1,
    player,
    opens: opensAt - game.session.createdAt,
    step: [guess.sentAt - game.session.createdAt, guess.point.x, guess.point.y, Number(!!guess.automatic)],
  };
}
export function appendReplayGuess(sql: SqlStorage, record: ParallelRecord, guess: AcceptedReplayGuess): void {
  const { round, player, opens, step } = guess;
  const encoded = JSON.stringify(step);
  const write = sql.exec(
    `INSERT INTO clue_replays(round,player,last_at,frames,track,opens,guesses)
    VALUES(?,?,-1,0,'',?,json_array(json(?))) ON CONFLICT(round,player) DO UPDATE SET
    guesses=CASE WHEN length(track)+length(guesses)+length(?)+1<=? THEN json_insert(guesses,'$[#]',json(?)) ELSE guesses END,
    partial=CASE WHEN length(track)+length(guesses)+length(?)+1>? THEN 1 ELSE partial END`,
    round,
    player,
    opens,
    encoded,
    encoded,
    maxTrackBytes,
    encoded,
    encoded,
    maxTrackBytes
  );
  record.metrics.storageRowsWritten += write.rowsWritten;
}

/** Append a player's ordered, newly displayed cameras. Retransmitted prefixes
 * cost no writes. A recording is never consulted by scoring or game timing. */
export function appendClueFrames(
  sql: SqlStorage,
  record: ParallelRecord,
  identity: ParallelIdentity,
  roundId: string,
  frames: ReplayFrame[],
  now: number
): number {
  const game = record.game,
    timing = game.timing;
  const round = game.session.rounds.findIndex(r => r.id === roundId);
  if (round < 0 || !Array.isArray(frames) || !frames.length || frames.length > REPLAY_BATCH)
    throw new ParallelActionError('Invalid clue replay');
  const clue = game.session.rounds[round].clue,
    origin = game.session.createdAt;
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    if (
      !validReplayFrame(f, clue) ||
      f[0] < origin ||
      f[0] > now + 2000 ||
      f[0] - origin > 0xffffffff ||
      (i > 0 && f[0] <= frames[i - 1][0])
    )
      throw new ParallelActionError('Invalid clue replay');
  }
  const through = frames[frames.length - 1][0];
  const player = game.participants.find(p => p.id === identity.id);
  if (!player || !timing || game.paused || record.ended || game.stage === 'complete' || game.reveals[round])
    return through;
  const host = identity.id === game.session.host.id;
  const window = host
    ? round === game.round && timing.phase === 'play'
      ? { opensAt: game.openedAt, closesAt: timing.deadline }
      : null
    : timing.phase !== 'lobby'
      ? timing.windows[round]
      : null;
  if (!window || (window.closesAt !== null && now > window.closesAt + STREAM_DELIVERY_GRACE_MS)) return through;
  const lock = player.guesses[round];
  const until = Math.min(window.closesAt ?? Infinity, host || game.pvp ? (lock?.sentAt ?? Infinity) : Infinity);
  const stored = sql
    .exec<{ last_at: number; frames: number; guess_bytes: number }>(
      'SELECT last_at,frames,length(guesses)-2 AS guess_bytes FROM clue_replays WHERE round=? AND player=?',
      round + 1,
      player.id
    )
    .toArray()[0];
  const valid = frames.filter(
    ([at, x, y, level]) =>
      at > (stored?.last_at ?? -1) &&
      at <= until &&
      (at >= window.opensAt ||
        (at >= window.opensAt - STREAM_START_COUNTDOWN_MS - 2000 && x === 0 && y === 0 && level === 0))
  );
  const remaining = Math.max(
    0,
    REPLAY_LIMIT - (stored?.frames ?? 0) - Math.ceil((stored?.guess_bytes ?? 0) / ENCODED_FRAME_SIZE)
  );
  const fresh = valid.slice(0, remaining);
  if (valid.length) {
    const write = sql.exec(
      `INSERT INTO clue_replays(round,player,last_at,frames,track,opens,partial) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(round,player) DO UPDATE SET last_at=excluded.last_at,frames=frames+excluded.frames,
      track=track||excluded.track,opens=coalesce(opens,excluded.opens),partial=max(partial,excluded.partial)`,
      round + 1,
      player.id,
      valid[valid.length - 1][0],
      fresh.length,
      encodeReplayFrames(fresh, origin),
      window.opensAt - origin,
      Number(fresh.length < valid.length)
    );
    record.metrics.storageRowsWritten += write.rowsWritten;
  }
  return through;
}

export function releasedClueReplay(
  sql: SqlStorage,
  game: StreamGame,
  round: number,
  player: string
): ClueReplay | null {
  if (
    !game.session.clueReplays ||
    !Number.isInteger(round) ||
    round < 1 ||
    !game.reveals[round - 1] ||
    !/^\d{1,30}$/.test(player)
  )
    return null;
  const row = sql
    .exec<TrackRow>('SELECT track,opens,guesses,partial FROM clue_replays WHERE round=? AND player=?', round, player)
    .toArray()[0];
  return row ? publicClueReplay(game.session.rounds[round - 1].clue, privateTrack(row)) : null;
}

export function replayReservation(sql: SqlStorage, game: StreamGame): number {
  if (!game.session.clueReplays || !game.reveals.length) return 0;
  const { n } = sql
    .exec<{ n: number }>(
      'SELECT COALESCE(SUM(length(track)+length(guesses)+length(player)+256),0) AS n FROM clue_replays WHERE round<=?',
      game.reveals.length
    )
    .one();
  if (!n) return 0;
  const encoder = new TextEncoder();
  return game.reveals.reduce(
    (sum, _, i) => sum + encoder.encode(JSON.stringify(game.session.rounds[i].clue)).length + 256,
    n
  );
}

export interface ReplayArchiveCursor {
  round: number;
  after: string;
}
/** Sorted pages bound each read and write even in a full 1,500-player room.
 * The empty key contains the original clue and seals its round. Retrying a
 * committed batch after a coordinator restart inserts the same pages. */
export async function archiveReplayBatch(
  db: Database,
  sql: SqlStorage,
  game: StreamGame,
  cursor?: ReplayArchiveCursor
): Promise<ReplayArchiveCursor | undefined> {
  let { round, after } = cursor ?? { round: 1, after: '' };
  const writes = [];
  const insert = (first: string, payload: string) =>
    db
      .prepare(
        'INSERT INTO stream_result_replay_pages(game_id,round,first_player,payload) VALUES(?,?,?,?) ON CONFLICT DO NOTHING'
      )
      .bind(game.session.id, round, first, payload);
  while (round <= game.reveals.length && writes.length < 8) {
    const entries: Record<string, StoredClueTrack> = Object.create(null);
    let first = '',
      bytes = 0;
    const rows = sql.exec<TrackRow & { player: string }>(
      'SELECT player,track,opens,guesses,partial FROM clue_replays WHERE round=? AND player>? ORDER BY player LIMIT 256',
      round,
      after
    );
    for (const row of rows) {
      const { player } = row;
      const size = row.track.length + row.guesses.length + player.length + 96;
      if (first && bytes + size > 128 * 1024) break;
      first ||= player;
      after = player;
      entries[player] = privateTrack(row);
      bytes += size;
    }
    if (first) writes.push(insert(first, JSON.stringify(entries)));
    else {
      writes.push(insert('', JSON.stringify(game.session.rounds[round - 1].clue)));
      round++;
      after = '';
    }
  }
  if (writes.length) await db.batch(writes);
  if (round <= game.reveals.length) return { round, after };
}
