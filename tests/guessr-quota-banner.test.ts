// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => {
  sessionStorage.clear();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.resetModules();
});
it('shows the affected service and the local reset time, expires at reset, and ignores ordinary short limits', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-26T23:59:00Z'));
  const { gameFetch } = await import('../src/guessr/quota-state');
  const { createQuotaBanner } = await import('../src/guessr/quota-banner');
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  const bar = createQuotaBanner();
  for (const scope of ['', 'host-games']) {
    fetcher.mockResolvedValueOnce(
      new Response('{}', { status: 429, headers: { 'X-Guessr-Daily-Quota': scope, 'Retry-After': '60' } })
    );
    await gameFetch('http://localhost/api/streams/sessions');
    expect(bar.hidden).toBe(true);
  }
  const reset = Date.parse('2026-11-27T00:00:00Z');
  fetcher.mockResolvedValueOnce(
    new Response('{}', {
      status: 429,
      headers: { 'X-Guessr-Daily-Quota': 'starts', 'X-Guessr-Reset-At': String(reset) },
    })
  );
  await gameFetch('http://localhost/api/streams/sessions');
  expect(bar.hidden).toBe(false);
  expect(bar.textContent).toContain('New games are paused to let active games finish.');
  expect(bar.textContent).toContain('Limits reset in 60 seconds (at ');
  expect(bar.querySelector('time')?.dateTime).toBe('2026-11-27T00:00:00.000Z');
  await vi.advanceTimersByTimeAsync(1000);
  expect(bar.textContent).toContain('59 seconds');
  await vi.advanceTimersByTimeAsync(59001);
  expect(bar.hidden).toBe(true);
});
it('gives a local time before the date and distinguishes a quota reset from an availability check', async () => {
  const { quotaTiming } = await import('../src/guessr/messages');
  const now = new Date(2026, 10, 26, 16, 45),
    later = new Date(2026, 10, 26, 19, 0);
  const message = quotaTiming(later.getTime(), false, now.getTime());
  expect(message).toMatch(/^Limits reset in 2 hours(?:,| and)? 15 minutes \(at 7:00\sPM .+ on Nov 26\)\.$/);
  expect(quotaTiming(later.getTime(), true, now.getTime())).toMatch(/^Next availability check in /);
  expect(quotaTiming(new Date(2027, 0, 1).getTime(), false, new Date(2026, 11, 31, 22).getTime())).toContain(
    'Jan 1, 2027'
  );
});
it('recognizes an explicit Cloudflare daily limit while preserving the original response for its caller', async () => {
  const { currentQuota, gameFetch } = await import('../src/guessr/quota-state');
  const content = '<html>Error 1027</html>';
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(content, { status: 503, headers: { 'Content-Type': 'text/html' } }))
  );
  const response = await gameFetch('http://localhost/api/daily');
  expect(await response.text()).toBe(content);
  expect(currentQuota()).toEqual({ scope: 'worker', resetAt: (Math.floor(Date.now() / 86400000) + 1) * 86400000 });
});

it('reads the closed sign before a new start and lets an existing game submit without hitting the start gate', async () => {
  vi.stubEnv('VITE_GUESSR_AVAILABILITY_URL', 'https://status.test/availability.json');
  vi.stubEnv('VITE_GUESSR_API_URL', 'https://game.test');
  try {
    const now = Date.now(),
      retryAt = (Math.floor(now / 86400000) + 1) * 86400000;
    const fetcher = vi.fn(async (url: RequestInfo | URL) =>
      String(url).includes('status.test')
        ? Response.json({ state: 'paused', retryAt, validUntil: retryAt })
        : Response.json({ ok: true })
    );
    vi.stubGlobal('fetch', fetcher);
    const { gameFetch } = await import('../src/guessr/quota-state');
    expect((await gameFetch('https://game.test/api/streams/sessions', { method: 'POST' })).status).toBe(429);
    expect(fetcher.mock.calls.map(c => String(c[0]))).toEqual(['https://status.test/availability.json']);
    expect((await gameFetch('https://game.test/api/attempts/old/guess', { method: 'POST' })).ok).toBe(true);
    expect(fetcher.mock.calls).toHaveLength(2);
  } finally {
    vi.unstubAllEnvs();
  }
});
