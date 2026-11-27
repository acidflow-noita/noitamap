import { twitchColor } from '../../../src/guessr/player-color.ts';
import type { StreamPublishedResult } from '../../../src/guessr/stream-types';
import type { Database } from './index';

export function hasMissingColors(result: StreamPublishedResult): boolean {
  return (
    Array.isArray(result.players) &&
    result.players.some(p => (result.mode === 'pvp' || p.id !== result.host.id) && !twitchColor(p.color))
  );
}

export async function rememberResultColors(db: Database, result: StreamPublishedResult): Promise<void> {
  const colors = result.players.flatMap(p => {
    const value = twitchColor(p.color);
    return value && /^\d{1,30}$/.test(p.id) ? [[p.id, value]] : [];
  });
  const statements = [];
  if (colors.length) {
    statements.push(
      db
        .prepare(
          `INSERT INTO stream_player_colors(player_id,color,seen_at)
      SELECT json_extract(value,'$[0]'),json_extract(value,'$[1]'),? FROM json_each(?) WHERE true
      ON CONFLICT(player_id) DO UPDATE SET color=excluded.color,seen_at=excluded.seen_at
      WHERE stream_player_colors.seen_at<excluded.seen_at`
        )
        .bind(result.finishedAt, JSON.stringify(colors))
    );
  }
  statements.push(db.prepare('DELETE FROM stream_color_backfill WHERE game_id=?').bind(result.id));
  await db.batch(statements);
}

export async function fillMissingColors(db: Database, result: StreamPublishedResult): Promise<StreamPublishedResult> {
  const missing = result.players
    .filter(p => !twitchColor(p.color) && (result.mode === 'pvp' || p.id !== result.host.id))
    .map(p => p.id);
  if (!missing.length) return result;
  const { results } = await db
    .prepare('SELECT player_id,color FROM stream_player_colors WHERE player_id IN (SELECT value FROM json_each(?))')
    .bind(JSON.stringify(missing))
    .all<{ player_id: string; color: string }>();
  if (!results.length) return result;
  const known = new Map(results.map(row => [row.player_id, row.color]));
  return {
    ...result,
    players: result.players.map(p => {
      const color = !twitchColor(p.color) && known.get(p.id);
      return color ? { ...p, color } : p;
    }),
  };
}
