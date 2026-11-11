import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
let worker: { fetch(...args: unknown[]): Promise<Response>; scheduled(...args: unknown[]): Promise<void> };
beforeAll(async () => {
  const result = await build({ entryPoints: ['workers/daily-seed-updater/src/index.ts'], bundle: true, write: false,
    format: 'iife', globalName: 'SeedTest', platform: 'neutral', target: 'es2022' });
  worker = new Function(result.outputFiles[0].text + '\nreturn SeedTest.default;')();
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it.each(['GET', 'POST', 'OPTIONS'])('never starts privileged work over HTTP %s', async method => {
  const get = vi.fn(), network = vi.fn(); vi.stubGlobal('fetch', network);
  const response = await worker.fetch(new Request('https://updater.test/update', { method }), { CF_API_TOKEN: { get } }, {});
  expect(response.status).toBe(404); expect(get).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled();
});
it('does not deploy, read secrets or trigger a bake when the published seed already matches', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const get = vi.fn(), network = vi.fn(async (input: string) => new Response(input.includes('takapuoli') ? 'daily;1234' : '1234'));
  vi.stubGlobal('fetch', network);
  await worker.scheduled({}, { CF_API_TOKEN: { get }, CF_ACCOUNT_ID: { get } }, {});
  expect(network).toHaveBeenCalledTimes(2); expect(get).not.toHaveBeenCalled();
});
it('keeps upstream errors and tokens out of failure output', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    if (input.includes('takapuoli')) return new Response('daily;1234');
    if (input.includes('current_seed')) return new Response('1233');
    return new Response('private-upload-token-and-injected-log-data', { status: 403 });
  }));
  const env = { CF_API_TOKEN: { get: async () => 'test-only-token' }, CF_ACCOUNT_ID: { get: async () => 'a'.repeat(32) }, SEED_WORKER_NAME: 'daily-seed-serve' };
  await expect(worker.scheduled({}, env, {})).rejects.toThrow('Asset upload session failed (HTTP 403).');
});
