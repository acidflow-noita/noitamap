import type { Database } from './index';
import { DAILY_PUBLISH_LIMIT, DAILY_ROUNDS, type DailyImagePack } from '../../../src/guessr/daily-pack';
import { scoreAreaGuess } from '../../../src/guessr/area-rules';
import { within } from '../../../src/guessr/rules';
import { supportedCamera } from '../../../src/guessr/clue-camera';

interface PublisherEnv { DB: Database; DAILY_PUBLISH_SECRET?: string; DAILY_ASSET_HOSTS?: string }
const encoder = new TextEncoder();
const response = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

function publicRoot(value: string, suffix: string, projects: string[]): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash
      || url.pathname.replace(/\/$/, '') !== suffix
      || !/^[a-f0-9]{8}$/.test(url.hostname.split('.')[0])
      || !projects.some(host => host.endsWith('.pages.dev') && url.hostname.endsWith(`.${host}`) && url.hostname.split('.').length === host.split('.').length + 1))
    throw new Error('Daily assets must use verified immutable Pages deployment URLs.');
  return url;
}

export function validateDailyPack(value: unknown, projects: string[], now: number): DailyImagePack {
  const pack = value as DailyImagePack;
  const date = typeof pack?.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(pack.day) ? Date.parse(pack.day) : NaN;
  const today = Math.floor(now / 86400000) * 86400000;
  if (pack?.schemaVersion !== 1 || !Number.isFinite(date) || new Date(date).toISOString().slice(0, 10) !== pack.day
      || date > today || date < today - 86400000 || !Number.isSafeInteger(pack.seed) || pack.seed < 0 || pack.seed > 0xffffffff
      || !/^guessr-images-[a-f0-9]{32}$/.test(pack.version) || pack.config?.version !== pack.version
      || typeof pack.renderId !== 'string' || !pack.renderId || pack.renderId.length > 200
      || !Number.isFinite(Date.parse(pack.generatedAt)) || Date.parse(pack.generatedAt) > now + 300000
      || !Array.isArray(pack.rounds) || pack.rounds.length !== DAILY_ROUNDS)
    throw new Error('Invalid daily identity, date, or round count.');
  const config = pack.config, c = config.map, b = config.bounds;
  if (!c || !b || ![b.x, b.y, b.width, b.height, c.width, c.height, c.tileSize, c.overlap, c.maxLevel].every(Number.isSafeInteger)
      || b.width <= 0 || b.height <= 0 || b.width > 65536 || b.height > 131072 || b.width !== c.width || b.height !== c.height || config.overview !== ''
      || c.tileSize !== 512 || c.overlap !== 2 || c.maxLevel !== Math.ceil(Math.log2(Math.max(c.width, c.height))))
    throw new Error('Invalid daily map geometry.');
  publicRoot(c.tiles, '/map_files', projects);
  for (const round of pack.rounds) {
    if (!round || !within(round.answer, b) || !Array.isArray(round.frames) || !round.frames.length || round.frames.length > 32)
      throw new Error('Invalid daily round.');
    scoreAreaGuess(round.area, round.answer, null);
    for (const frame of round.frames) {
      if (![frame.x, frame.y, frame.width, frame.height].every(Number.isSafeInteger)
          || frame.width <= 0 || frame.height <= 0 || frame.width > 516 || frame.height > 516
          || Math.abs(frame.x) > 4096 || Math.abs(frame.y) > 4096)
        throw new Error('Invalid relative clue geometry.');
      const url = new URL(frame.image);
      if (!/^\/images\/[a-f0-9]{32}\.webp$/.test(url.pathname)) throw new Error('Clue filenames must be opaque.');
      url.pathname = '/images'; publicRoot(url.href, '/images', projects);
    }
    if (!supportedCamera({ frames: round.frames }, { dx: 0, dy: 0, level: 0 })
        || !supportedCamera({ frames: round.frames }, { dx: 0, dy: 0, level: 6 }))
      throw new Error('Daily clue images do not cover all zoom levels.');
  }
  return pack;
}

async function boundedBody(request: Request): Promise<Uint8Array<ArrayBuffer>> {
  if (Number(request.headers.get('Content-Length')) > DAILY_PUBLISH_LIMIT) throw new Error('Daily publication is too large.');
  const reader = request.body?.getReader();
  if (!reader) throw new Error('Daily publication is empty.');
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.byteLength;
      if (length > DAILY_PUBLISH_LIMIT) { await reader.cancel(); throw new Error('Daily publication is too large.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length); let at = 0;
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }
  return bytes;
}

/** Only the CI publisher can call this route. No image bytes pass through it. */
export async function publishDaily(request: Request, env: PublisherEnv, now: number): Promise<Response> {
  if (request.method !== 'POST') return response({ error: 'Method not allowed.' }, 405);
  const secret = env.DAILY_PUBLISH_SECRET || '';
  if (secret.length < 32) return response({ error: 'Daily publishing is not configured.' }, 503);
  const signature = request.headers.get('X-Guessr-Publish-Signature') || '';
  if (!/^[a-f0-9]{64}$/.test(signature)) return response({ error: 'Publisher authentication required.' }, 401);
  let bytes: Uint8Array<ArrayBuffer>;
  try { bytes = await boundedBody(request); } catch { return response({ error: 'Invalid daily publication size.' }, 413); }
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const mac = Uint8Array.from(signature.match(/../g)!, byte => parseInt(byte, 16));
  if (!await crypto.subtle.verify('HMAC', key, mac, bytes)) return response({ error: 'Publisher authentication failed.' }, 401);
  let pack: DailyImagePack;
  try {
    pack = validateDailyPack(JSON.parse(new TextDecoder().decode(bytes)), (env.DAILY_ASSET_HOSTS || '').split(',').map(p => p.trim()).filter(Boolean), now);
  } catch (error) { return response({ error: error instanceof Error ? error.message : 'Invalid daily publication.' }, 400); }
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('');
  const id = `daily-${pack.day}`, opens = Date.parse(pack.day), closes = opens + 2 * 86400000;
  const created = Date.parse(pack.generatedAt);
  const previous = await env.DB.prepare('SELECT id,publication_hash,publication_created_at FROM challenges WHERE day=?').bind(pack.day).first<{ id: string; publication_hash: string | null; publication_created_at: number | null }>();
  if (previous?.publication_hash === digest) return response({ id: previous.id, day: pack.day, seed: pack.seed, version: pack.version, unchanged: true });
  if (previous?.publication_created_at && previous.publication_created_at > created) return response({ error: 'A newer daily bake is already published.' }, 409);
  const used = previous && await env.DB.prepare('SELECT id FROM attempts WHERE challenge_id=? LIMIT 1').bind(previous.id).first();
  if (used || previous && previous.id !== id) return response({ error: 'This daily already has players. Its images and answers cannot be replaced.' }, 409);
  const statements = [env.DB.prepare(`INSERT INTO challenges(id,day,title,opens_at,closes_at,reveal_at,bounds_json,round_seconds,enabled,image_config_json,dataset_version,publication_hash,publication_created_at)
    VALUES(?,?,?,?,?,?,?,600,1,?,?,?,?) ON CONFLICT(day) DO UPDATE SET title=excluded.title,opens_at=excluded.opens_at,closes_at=excluded.closes_at,reveal_at=excluded.reveal_at,
    bounds_json=excluded.bounds_json,image_config_json=excluded.image_config_json,dataset_version=excluded.dataset_version,publication_hash=excluded.publication_hash,publication_created_at=excluded.publication_created_at,enabled=1
    WHERE NOT EXISTS(SELECT 1 FROM attempts WHERE challenge_id=challenges.id) AND COALESCE(challenges.publication_created_at,0)<=excluded.publication_created_at`)
    .bind(id, pack.day, `NoitaGuessr · ${pack.day}`, opens, closes, closes, JSON.stringify(pack.config.bounds), JSON.stringify(pack.config), pack.version, digest, created)];
  for (const [ordinal, round] of pack.rounds.entries()) {
    const image = new URL(round.frames[0].image).pathname.split('/').at(-1)!;
    statements.push(env.DB.prepare(`INSERT INTO questions(challenge_id,ordinal,asset_key,name,biome,x,y,seed,area_json,clue_json) VALUES(?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(challenge_id,ordinal) DO UPDATE SET asset_key=excluded.asset_key,name=excluded.name,biome=excluded.biome,x=excluded.x,y=excluded.y,seed=excluded.seed,area_json=excluded.area_json,clue_json=excluded.clue_json
      WHERE NOT EXISTS(SELECT 1 FROM attempts WHERE challenge_id=questions.challenge_id) AND EXISTS(SELECT 1 FROM challenges WHERE id=questions.challenge_id AND publication_hash=?)`)
      .bind(id, ordinal, image, round.area.label, round.area.label, round.answer.x, round.answer.y, pack.seed, JSON.stringify(round.area), JSON.stringify({ frames: round.frames }), digest));
  }
  await env.DB.batch(statements);
  const current = await env.DB.prepare('SELECT publication_hash FROM challenges WHERE id=?').bind(id).first<{ publication_hash: string }>();
  if (current?.publication_hash !== digest) return response({ error: 'A player started this daily during publication; the existing daily was preserved.' }, 409);
  return response({ id, day: pack.day, seed: pack.seed, version: pack.version, complete: true });
}
