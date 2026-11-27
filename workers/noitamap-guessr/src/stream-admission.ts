import { ImageGameError } from '../../../src/guessr/image-game-server';
import { STREAM_MAX_DOCUMENT_BYTES } from '../../../src/guessr/stream-types';
import { STREAM_STORAGE_BUDGET_BYTES, STREAM_RESULT_OVERHEAD_BYTES } from './result-storage';
import type { Database } from './index';

export const STREAM_HOST_DAILY_CREATE_CAP = 20;
export class StreamAdmissionError extends ImageGameError {
  constructor(message: string, readonly resetAt: number, readonly scope: 'host-games') { super(429, message); }
}

/** One atomic admission before sampling or allocating a live game. */
export async function admitStreamGame(db: Database, hostId: string, now: number): Promise<string> {
  const day = new Date(now).toISOString().slice(0, 10), id = crypto.randomUUID();
  const admitted = await db.prepare(`INSERT INTO stream_game_admissions(id,host_id,day,created_at)
    SELECT ?,?,?,? WHERE (SELECT COUNT(*) FROM stream_game_admissions WHERE day=? AND host_id=?)<?
      AND (SELECT used_bytes FROM stream_result_storage WHERE id=1)+?<=? RETURNING id`)
    .bind(id, hostId, day, now, day, hostId, STREAM_HOST_DAILY_CREATE_CAP,
      STREAM_MAX_DOCUMENT_BYTES + STREAM_RESULT_OVERHEAD_BYTES, STREAM_STORAGE_BUDGET_BYTES).first();
  if (admitted) return id;
  const counts = await db.prepare('SELECT COUNT(*) AS host FROM stream_game_admissions WHERE day=? AND host_id=?')
    .bind(day, hostId).first<{ host: number }>();
  const resetAt = Date.parse(day) + 86400000;
  if (counts && counts.host >= STREAM_HOST_DAILY_CREATE_CAP)
    throw new StreamAdmissionError('You have reached today’s limit of 20 games.', resetAt, 'host-games');
  throw new ImageGameError(507, 'Result storage is full. A new game cannot be started.');
}

/** A failed preparation did not create a lobby. Cancelled live lobbies still count. */
export async function cancelStreamAdmission(db: Database, id: string, hostId: string): Promise<void> {
  await db.prepare('DELETE FROM stream_game_admissions WHERE id=? AND host_id=?').bind(id, hostId).run();
}
