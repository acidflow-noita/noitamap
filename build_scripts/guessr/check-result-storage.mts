/** Isolated native D1/HTTP test. No browser, production writes or deployment. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { encodeStoredResult, STREAM_RESULT_OVERHEAD_BYTES } from '../../workers/noitamap-guessr/src/result-storage';
import type { StreamPublishedResult } from '../../src/guessr/stream-types';

const require = createRequire(new URL('../../workers/noitamap-guessr/package.json', import.meta.url));
const { Miniflare, convertV4MiniflareOptions } = require('miniflare');
const { build } = require('esbuild');
const root = fileURLToPath(new URL('../../', import.meta.url));
const bundle = await build({ entryPoints: [root + 'workers/noitamap-guessr/src/index.ts'], bundle: true, write: false,
  format: 'esm', platform: 'neutral', target: 'es2022', external: ['cloudflare:*'], logLevel: 'silent' });
const runtime = new Miniflare(convertV4MiniflareOptions({ compatibilityDate: '2026-10-08', modules: true,
  script: bundle.outputFiles[0].text, d1Databases: { DB: 'result-storage-test' },
  bindings: { STREAM_ENABLED: 'true', ALLOWED_ORIGINS: 'https://example.com', GAME_SIGNING_SECRET: 'local-test-only-key-with-at-least-32-characters' } }));
try {
  const db = await runtime.getD1Database('DB');
  const old = await readFile(root + 'workers/noitamap-guessr/migrations/0002_stream_results.sql', 'utf8');
  await db.prepare(old.match(/CREATE TABLE stream_results[\s\S]*?;/)![0]).run();
  const legacyId = crypto.randomUUID(), legacy = '{ "legacy": "結果" }\n';
  const legacyBytes = new TextEncoder().encode(legacy).byteLength;
  await db.prepare('INSERT INTO stream_results VALUES(?,?,?,?,?,?,?)').bind(legacyId, 'test-owner', '2026-01-01', 1,
    legacyBytes, 'legacy-digest', legacy).run();
  const legacyBeforeMigration = await runtime.dispatchFetch('https://api.test/api/streams/results/' + legacyId);
  assert.equal(legacyBeforeMigration.status, 200); assert.equal(await legacyBeforeMigration.text(), legacy);
  const migration = await readFile(root + 'workers/noitamap-guessr/migrations/0006_stream_storage.sql', 'utf8');
  const statements = [migration.match(/ALTER TABLE[\s\S]*?;/)![0], migration.match(/CREATE TABLE[\s\S]*?;/)![0],
    migration.match(/INSERT INTO[\s\S]*?;/)![0], ...migration.matchAll(/CREATE TRIGGER[\s\S]*?END;/g)].map(item => typeof item === 'string' ? item : item[0]);
  await db.batch(statements.map(sql => db.prepare(sql)));
  let randomState = 123456789;
  const random = () => { randomState ^= randomState << 13; randomState ^= randomState >>> 17; randomState ^= randomState << 5; return randomState >>> 0; };
  let accounted = legacyBytes + STREAM_RESULT_OVERHEAD_BYTES;
  for (const count of [1, 1000, 1500]) {
    const value: StreamPublishedResult = { schema: 1, format: 'compact-scores-v1', id: crypto.randomUUID(), version: 'fixture',
      createdAt: 1, finishedAt: 2, host: { id: '1000000', login: 'streamer', name: 'Streamer' },
      rounds: Array.from({ length: 10 }, (_, i) => ({ id: crypto.randomUUID(), answer: { x: i * 1000, y: i * -200 }, name: 'Fixture area', difficultyTier: 'normal' })),
      players: Array.from({ length: count }, (_, i) => {
        const rounds: [number, number][] = Array.from({ length: 10 }, () => [random() % 2 ? 1000 : 0, random() % 4001]);
        return { id: String(1000000 + i), login: 'player_' + i, name: i % 2 ? '視聴者 ' + i : 'Player ' + i,
          color: '#' + (random() % 0xffffff).toString(16).padStart(6, '0'), rank: i + 1, rounds,
          score: rounds.reduce((sum, pair) => sum + pair[0] + pair[1], 0) };
      }) };
    const text = JSON.stringify(value), raw = new TextEncoder().encode(text).byteLength, start = performance.now();
    const encoded = await encodeStoredResult(value, text), encodeMs = performance.now() - start;
    await db.prepare('INSERT INTO stream_results(id,owner,day,created_at,bytes,digest,result_json,result_gzip) VALUES(?,?,?,?,?,?,?,?)')
      .bind(value.id, 'test-owner', '2026-11-08', 2, encoded.bytes, 'test-digest', encoded.json, encoded.gzip).run();
    accounted += encoded.bytes + STREAM_RESULT_OVERHEAD_BYTES;
    for (const encoding of ['gzip', 'identity']) {
      const response = await runtime.dispatchFetch('https://api.test/api/streams/results/' + value.id,
        { headers: { Origin: 'https://example.com', 'Accept-Encoding': encoding } });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('access-control-allow-origin'), 'https://example.com');
      assert.match(response.headers.get('vary')!, /Accept-Encoding/); assert.match(response.headers.get('vary')!, /Origin/);
      // dispatchFetch crosses the HTTP boundary and decodes Content-Encoding.
      // A double-gzipped CORS response fails this JSON/equality check.
      assert.equal(await response.text(), text);
    }
    console.log(JSON.stringify({ players: count, rawBytes: raw, storedBytes: encoded.bytes,
      reductionPercent: Number((100 * (1 - encoded.bytes / raw)).toFixed(1)), nodeEncodeMs: Number(encodeMs.toFixed(2)) }));
  }
  assert.equal(await db.prepare('SELECT used_bytes FROM stream_result_storage WHERE id=1').first('used_bytes'), accounted);
  const legacyAfterMigration = await runtime.dispatchFetch('https://api.test/api/streams/results/' + legacyId);
  assert.equal(await legacyAfterMigration.text(), legacy);
  console.log('Native D1 BLOB storage, accounting and gzip/identity HTTP delivery passed.');
} finally { await runtime.dispose(); }
