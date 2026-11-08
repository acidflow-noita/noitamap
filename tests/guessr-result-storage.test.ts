import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { gameDatabase } from './helpers/guessr-database';
import { acceptsGzip, encodeStoredResult, storedResultResponse, STREAM_RESULT_OVERHEAD_BYTES } from '../workers/noitamap-guessr/src/result-storage';
import type { StreamPublishedResult } from '../src/guessr/stream-types';

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach(close => close()));
function result(count = 1000): StreamPublishedResult {
  return { schema: 1, format: 'compact-scores-v1', id: crypto.randomUUID(), version: 'fixture', createdAt: 1, finishedAt: 2,
    host: { id: '1', name: 'Streamer', login: 'streamer' },
    rounds: Array.from({ length: 10 }, (_, i) => ({ id: String(i), answer: { x: i, y: i }, name: 'Fixture', difficultyTier: 'normal' })),
    players: Array.from({ length: count }, (_, i) => ({ id: String(i + 1), login: 'player_' + i, name: '視聴者 ' + i, color: '#123456',
      score: 50000, rank: 1, rounds: Array.from({ length: 10 }, () => [1000, 4000] as [number, number]) })) };
}

describe('immutable result storage', () => {
  it('round-trips every score and Unicode name through compressed and identity responses', async () => {
    const value = result(), serialized = JSON.stringify(value), encoded = await encodeStoredResult(value, serialized);
    expect(encoded.gzip).not.toBeNull();
    expect(encoded.bytes).toBeLessThan(new TextEncoder().encode(serialized).byteLength / 2);
    const stored = { result_json: encoded.json, result_gzip: [...new Uint8Array(encoded.gzip!)] };
    expect(JSON.parse(encoded.json)).toMatchObject({ host: { login: value.host.login }, playerCount: 1000, finishedAt: value.finishedAt });
    const compressed = storedResultResponse(stored, new Request('https://result.test', { headers: { 'Accept-Encoding': 'gzip' } }));
    expect(compressed.headers.get('Content-Encoding')).toBe('gzip');
    expect(JSON.parse(await new Response(compressed.body!.pipeThrough(new DecompressionStream('gzip'))).text())).toEqual(value);
    const identity = storedResultResponse(stored, new Request('https://result.test', { headers: { 'Accept-Encoding': 'gzip;q=0' } }));
    expect(identity.headers.get('Content-Encoding')).toBeNull(); expect(await identity.json()).toEqual(value);
    expect(identity.headers.get('Cache-Control')).toContain('immutable');
  });
  it('preserves exact legacy bytes and does not compress when the storage representation would grow', async () => {
    const text = '{ "old": "結果" }\n';
    expect(await storedResultResponse({ result_json: text, result_gzip: null }, new Request('https://result.test')).text()).toBe(text);
    expect(await encodeStoredResult(result(0), '{}')).toEqual({ json: '{}', gzip: null, bytes: 2 });
  });
  it.each([['gzip', true], ['br, gzip;q=0.5', true], ['gzip;q=0, *;q=1', false], ['identity', false], [null, false], ['*;q=0.8', true], ['gzip;q=invalid', false]] as const)
    ('honours Accept-Encoding %s', (header, expected) => expect(acceptsGzip(header)).toBe(expected));
  it('adds accounting without rewriting legacy results and preserves their immutability', async () => {
    const f = gameDatabase(); cleanups.push(f.close);
    f.sqlite.exec(readFileSync('workers/noitamap-guessr/migrations/0002_stream_results.sql', 'utf8'));
    const original = JSON.stringify(result(1)), bytes = new TextEncoder().encode(original).byteLength;
    f.sqlite.prepare('INSERT INTO stream_results VALUES(?,?,?,?,?,?,?)').run('legacy', 'owner', '2026-01-01', 1, bytes, 'digest', original);
    const before = f.sqlite.prepare('SELECT * FROM stream_results').get();
    f.sqlite.exec(readFileSync('workers/noitamap-guessr/migrations/0006_stream_storage.sql', 'utf8'));
    expect(f.sqlite.prepare('SELECT * FROM stream_results').get()).toEqual({ ...before, result_gzip: null });
    expect(f.sqlite.prepare('SELECT used_bytes,games FROM stream_result_storage').get()).toEqual({ used_bytes: bytes + STREAM_RESULT_OVERHEAD_BYTES, games: 1 });
    expect(() => f.sqlite.prepare('UPDATE stream_results SET result_json=? WHERE id=?').run('{}', 'legacy')).toThrow('immutable');
    f.sqlite.prepare('DELETE FROM stream_results WHERE id=?').run('legacy');
    expect(f.sqlite.prepare('SELECT used_bytes,games FROM stream_result_storage').get()).toEqual({ used_bytes: 0, games: 0 });
  });
});
