import { describe, expect, it } from 'vitest';
import { inspectDaily, dailyPreflightSummary, performanceExitCode } from '../build_scripts/performance/daily-preflight.mjs';
import { createDailyReplay } from '../build_scripts/performance/daily-fixture.mjs';

const middle = 'https://daily-middle.acidflow.stream/manifest.json';
function response(url: string) {
  const body = url.endsWith('previous_seed.txt') ? '1001996113\n' : url.endsWith('.txt') ? '1957021613\n' : url.endsWith('.dzi')
    ? JSON.stringify({ Image: { Size: { Width: 35840, Height: 73728 }, TileSize: 512, Format: 'webp' } })
    : JSON.stringify({ seed: url.includes('previous-daily-') ? 1001996113 : 1957021613, baked: true, complete: true });
  return { status: 200, headers: { 'content-type': 'application/json' }, body };
}

describe('performance prerequisite reporting', () => {
  it('captures a complete published bake and its actual descriptors', async () => {
    const result = await inspectDaily(async (url: string) => response(url));
    expect(result.status).toBe('ready');
    expect(result.daily?.seed).toBe(1957021613);
    expect(result.daily?.manifests).toHaveLength(3);
    expect(result.daily?.descriptors).toHaveLength(3);
    expect(result.requests).toHaveLength(11);
  });
  it('records the CI 403 with diagnostics, collects other worlds, and never turns missing coverage green', async () => {
    const result = await inspectDaily(async (url: string) => url === middle
      ? { status: 403, headers: { 'cf-ray': 'test-ray', 'cf-mitigated': 'challenge', 'set-cookie': 'do not save' }, body: 'Access denied' }
      : response(url));
    expect(result.status).toBe('failed');
    expect(result.failure).toContain(`HTTP 403: ${middle}`);
    expect(result.requests).toHaveLength(8);
    expect(result.requests.find((r: any) => r.url === middle)).toMatchObject({ status: 403,
      headers: { 'cf-ray': 'test-ray', 'cf-mitigated': 'challenge' }, bodyExcerpt: 'Access denied' });
    expect(JSON.stringify(result)).not.toContain('do not save');
    expect(dailyPreflightSummary(result)).toContain('Dynamic-only results follow; this workflow still fails');
    expect(performanceExitCode({ comparable: true, timingRegressions: [] }, { enforceTiming: false }, result)).toBe(1);
  });
  it.each(['publication mismatch', 'invalid DZI', 'network error'])('reports %s as unavailable evidence', async failure => {
    const result = await inspectDaily(async (url: string) => {
      if (failure === 'network error' && url === middle) throw Error('Fetch failed');
      const r = response(url);
      if (failure === 'publication mismatch' && url === middle) r.body = JSON.stringify({ seed: 1, baked: true, complete: true });
      if (failure === 'invalid DZI' && url.endsWith('/map.dzi')) r.body = '{}';
      return r;
    });
    expect(result.status).toBe('failed');
    expect(result.daily).toBeUndefined();
    expect(result.requests.length).toBeGreaterThanOrEqual(4);
  });
  it('keeps timing warnings separate from correctness and prerequisite failures', () => {
    const comparison = { comparable: true, timingRegressions: [{}] };
    expect(performanceExitCode(comparison, { enforceTiming: false }, { status: 'ready' })).toBe(0);
    expect(performanceExitCode(comparison, { enforceTiming: true }, { status: 'ready' })).toBe(1);
    expect(performanceExitCode({ ...comparison, comparable: false }, { enforceTiming: false }, { status: 'ready' })).toBe(1);
  });
  it('selects an actual complete bake while the midnight seed pointer is ahead', async () => {
    const result = await inspectDaily(async (url: string) => {
      const r = response(url);
      if (url.endsWith('current_seed.txt')) r.body = '1957021614';
      return r;
    });
    expect(result.status).toBe('ready');
    expect(result.daily).toMatchObject({ seed: 1957021613, currentSeed: 1957021614 });
    expect(dailyPreflightSummary(result)).toContain('differ from published bakes');
    expect(dailyPreflightSummary(result)).toContain('exclude its CDN transfer latency');
  });
  it('freezes real baked bytes and refuses missing or changing assets', () => {
    const replay = createDailyReplay(42, 41), url = 'https://daily-middle.acidflow.stream/map_files/10/0_0.webp';
    replay.capture(url, { status: 200, headers: { 'content-type': 'image/webp', 'content-encoding': 'gzip',
      'cache-control': 'public,max-age=31536000,immutable' }, body: Buffer.from([1, 2, 3]) });
    const captured = replay.response(url + '?cache=second-run');
    expect([...captured.body]).toEqual([1, 2, 3]);
    expect(captured.headers['content-encoding']).toBeUndefined();
    expect(captured.headers['cache-control']).toContain('immutable');
    expect(replay.response('https://daily-seed.acidflow.stream/current_seed.txt').body.toString()).toBe('42');
    expect(() => replay.response('https://daily-left.acidflow.stream/map.dzi')).toThrow('Uncaptured');
    expect(() => replay.capture(url, { status: 200, headers: {}, body: Buffer.from([4]) })).toThrow('changed while capturing');
    expect(() => replay.capture(url, { status: 403, headers: {}, body: Buffer.from('denied') })).toThrow('HTTP 403');
  });
});
