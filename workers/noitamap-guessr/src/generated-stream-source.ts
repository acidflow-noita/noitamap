import { createPreparedRoundSource, createPreparedSourceCache, type PreparedSourceCache } from '../../../src/guessr/prepared-rounds';
import { encryptedPreparedReader, PreparedSourceReadError, validatePreparedSourcePackage, type PreparedSourcePackage } from '../../../src/guessr/prepared-source-package';
import type { ImageGameConfig } from '../../../src/guessr/image-game';
import type { DailyImagePack } from '../../../src/guessr/daily-pack';
import { ImageGameError } from '../../../src/guessr/image-game-server';
import { preparedSource } from './prepared-source';
import type { Env, Database } from './index';

interface GeneratedMap {
  day: string; seed: number; version: string; renderId: string; generatedAt: string;
  config: ImageGameConfig; preparedSource: PreparedSourcePackage;
}
const caches = new Map<string, PreparedSourceCache>();
const sourceErrors = new Map([
  ['Prepared game data is unavailable. Run prepare-worker-data.mts.', 'data-unavailable'],
  ['Prepared game data exceeds its size limit.', 'data-size'],
  ['Prepared game catalog is invalid.', 'catalog-invalid'],
  ['Prepared map geometry is invalid.', 'geometry-invalid'],
  ['Prepared area sampling data is invalid.', 'sampler-metadata'],
  ['Prepared image grid is invalid.', 'grid-invalid'],
  ['Prepared starting positions are truncated.', 'sampler-truncated'],
  ['Prepared starting positions are invalid.', 'sampler-invalid'],
  ['Prepared starting position lies outside its mask.', 'sampler-position'],
  ['Prepared starting view is outside the captured map.', 'view-outside-map'],
  ['Not enough eligible puzzle areas.', 'areas-unavailable'],
]);

export function generatedMapStatements(db: Database, pack: DailyImagePack, now: number) {
  if (!pack.preparedSource) return [];
  const value: GeneratedMap = { day: pack.day, seed: pack.seed, version: pack.version, renderId: pack.renderId,
    generatedAt: pack.generatedAt, config: pack.config, preparedSource: pack.preparedSource };
  return [db.prepare(`INSERT INTO stream_maps(day,generated_at,source_json) VALUES(?,?,?)
    ON CONFLICT(day) DO UPDATE SET generated_at=excluded.generated_at,source_json=excluded.source_json
    WHERE stream_maps.generated_at<=excluded.generated_at`).bind(pack.day, Date.parse(pack.generatedAt), JSON.stringify(value)),
    db.prepare('UPDATE stream_map_control SET enabled=1 WHERE id=1 AND ?=?').bind(pack.day, new Date(now).toISOString().slice(0, 10)),
    db.prepare('DELETE FROM stream_maps WHERE day<?').bind(new Date(now - 7 * 86400000).toISOString().slice(0, 10))];
}

export async function generatedStreamSource(env: Env, now: number, fetcher: typeof fetch = fetch) {
  const day = new Date(now).toISOString().slice(0, 10);
  const unavailable = (stage: string, error?: unknown) => {
    const reason = error instanceof PreparedSourceReadError ? error.code : error instanceof Error && sourceErrors.has(error.message) ? sourceErrors.get(error.message)
      : error instanceof Error && ['Error', 'TypeError', 'RangeError', 'SyntaxError', 'OperationError', 'DataError', 'AbortError', 'TimeoutError'].includes(error.name) ? error.name : 'validation';
    console.error(JSON.stringify({ event: 'generated_map_load_failed', day, stage, reason,
      ...(error instanceof PreparedSourceReadError && error.status ? { status: error.status } : {}) }));
    return new ImageGameError(503, 'Game images are temporarily unavailable. Try again shortly.');
  };
  const row = await env.DB.prepare('SELECT enabled,(SELECT source_json FROM stream_maps WHERE day=?) AS source_json FROM stream_map_control WHERE id=1')
    .bind(day).first<{ enabled: number; source_json: string | null }>();
  if (!row) throw unavailable('control');
  // Explicit rollout state. The first authenticated generated-map publication
  // switches this on permanently; a missing later Daily never falls back.
  if (!row.enabled) return { source: preparedSource(env) };
  if (!row.source_json) throw new ImageGameError(503, 'Today’s generated map is still being prepared. Try again shortly.');
  const map = JSON.parse(row.source_json) as GeneratedMap;
  const imageRoot = new URL(map.preparedSource.root).origin + '/images';
  validatePreparedSourcePackage(map.preparedSource, map.version, new URL(imageRoot).origin);
  const key = map.version + '\n' + map.preparedSource.root + '\n' + map.preparedSource.key;
  let cache = caches.get(key);
  if (!cache) {
    if (caches.size >= 2) caches.delete(caches.keys().next().value!);
    cache = createPreparedSourceCache(); caches.set(key, cache);
  }
  const source = createPreparedRoundSource(encryptedPreparedReader(map.preparedSource, fetcher), imageRoot, map.config.map.tiles, undefined, cache);
  let config: ImageGameConfig;
  try { config = await source.config(); } catch (error) { throw unavailable('catalog', error); }
  if (map.day !== day || config.version !== map.version || JSON.stringify(config) !== JSON.stringify(map.config))
    throw unavailable('geometry');
  return { source: { config: async () => config, sampleRounds: async (count: number) => {
    try { return await source.sampleRounds(count); }
    catch (error) { throw unavailable('rounds', error); }
  } }, imageRoot, dataset: { day: map.day, seed: map.seed, renderId: map.renderId } };
}
