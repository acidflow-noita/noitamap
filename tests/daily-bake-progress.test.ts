import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { localBakeTime, parseBakeProgress, scheduledBakeReadyAt } from '../src/telescope/daily-bake-progress';

const now = Date.parse('2026-10-30T00:08:00Z');
const report = { seed: 123, phase: 'running', requestedAt: '2026-10-30T00:01:00Z',
  startedAt: '2026-10-30T00:02:00Z', updatedAt: '2026-10-30T00:02:00Z',
  expectedReadyAt: '2026-10-30T00:17:00Z', expiresAt: '2026-10-30T01:07:00Z' };
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('visitor bake status', () => {
  it('formats the same UTC deadline in local zones, including DST and the previous local day', () => {
    const summer = '2026-07-10T00:16:00Z', winter = '2026-01-10T00:16:00Z';
    expect(localBakeTime(summer, 'en-GB', 'Europe/Berlin')).toContain('02:16');
    expect(localBakeTime(winter, 'en-GB', 'Europe/Berlin')).toContain('01:16');
    const newYork = localBakeTime(summer, 'en-GB', 'America/New_York');
    expect(newYork).toContain('9 Jul'); expect(newYork).toContain('20:16');
    expect(localBakeTime(summer, 'en-GB', 'Asia/Tokyo')).toContain('09:16');
    expect(localBakeTime(summer, 'en-GB')).toBe(localBakeTime(summer, 'en-GB', Intl.DateTimeFormat().resolvedOptions().timeZone));
    expect(() => localBakeTime(summer, 'br')).not.toThrow();
  });

  it('keeps the fallback estimate aligned with the actual configured UTC cron', () => {
    const config = readFileSync(new URL('../workers/daily-seed-updater/wrangler.jsonc', import.meta.url), 'utf8');
    expect(config).toContain('"1 0 * * *"');
    expect(scheduledBakeReadyAt('daily', now)).toBe('2026-10-30T00:16:00.000Z');
    expect(scheduledBakeReadyAt('previous-daily', now)).toBe('2026-10-29T00:16:00.000Z');
  });

  it('accepts only bounded, fresh reports and drops all CI details', () => {
    const rows = parseBakeProgress({ schemaVersion: 1, entries: [{ ...report,
      pipelineUrl: 'https://private.invalid', error: 'internal logs', token: 'secret',
    }] }, now);
    expect(rows).toEqual([report]);
    expect(parseBakeProgress({ schemaVersion: 1, entries: [{ ...report, expiresAt: '2026-10-29T00:00:00Z' }] }, now)).toEqual([]);
    expect(parseBakeProgress({ schemaVersion: 1, entries: [{ ...report, phase: 'made-up' }] }, now)).toEqual([]);
    expect(parseBakeProgress({ schemaVersion: 1, entries: [{ ...report, startedAt: '2027-01-01T00:00:00Z' }] }, now)).toEqual([]);
    expect(parseBakeProgress({ schemaVersion: 1, entries: [{ ...report, seed: -1 }] }, now)).toEqual([]);
  });

  it('coalesces reads without polling and never overrides a verified bake with a failed job report', async () => {
    vi.resetModules(); vi.useFakeTimers(); vi.setSystemTime(now);
    const fetcher = vi.fn(async () => Response.json({ schemaVersion: 1, entries: [{ ...report, phase: 'failed' }] }));
    vi.stubGlobal('fetch', fetcher);
    const status = await import('../src/telescope/daily-bake-status');
    status.beginDailyBakeCheck('daily', 123)('unavailable');
    await Promise.all([status.refreshDailyBakeProgress(), status.refreshDailyBakeProgress()]);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(status.getDailyBakeProgress(123)?.phase).toBe('failed');
    expect(status.getDailyBakeProgress(999)).toBeNull();
    status.beginDailyBakeCheck('daily', 123)('ready');
    expect(status.getDailyBakeStatus('daily', 123)).toBe('ready');
    vi.advanceTimersByTime(60 * 60_000);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(status.getDailyBakeProgress(123)).toBeNull();
  });

  it('treats an unreachable feed as unknown rather than a failed job', async () => {
    vi.resetModules();
    vi.stubGlobal('fetch', vi.fn(async () => { throw Error('offline'); }));
    const status = await import('../src/telescope/daily-bake-status');
    await status.refreshDailyBakeProgress();
    expect(status.getDailyBakeProgress(123)).toBeNull();
  });
});
