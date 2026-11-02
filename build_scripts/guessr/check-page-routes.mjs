// Cloudflare's actual asset router, exercised over HTTP without a browser.
// Requires the existing dev dependencies in workers/noitamap-guessr.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(new URL('../../workers/noitamap-guessr/package.json', import.meta.url));
const { Miniflare, convertV4MiniflareOptions } = require('miniflare');
const directory = await mkdtemp(join(tmpdir(), 'noitaguessr-routing-'));
let runtime;
try {
  await mkdir(join(directory, 'guess'));
  await writeFile(join(directory, 'index.html'), '<title>Noita Map</title>');
  await writeFile(join(directory, 'guess/index.html'), '<title>NoitaGuessr</title>');
  await writeFile(join(directory, 'guess/twitch-callback.html'), '<title>Twitch callback</title>');
  await writeFile(join(directory, '_redirects'), await readFile(new URL('../../public/_redirects', import.meta.url)));
  runtime = new Miniflare(convertV4MiniflareOptions({
    compatibilityDate: '2026-10-08', modules: true,
    script: 'export default {fetch(){return new Response("Unexpected Worker invocation",{status:500})}}',
    assets: { directory, assetConfig: { not_found_handling: 'single-page-application' } },
  }));
  const pages = ['/', '/guess/', '/guess/demo', '/guess/demo/', '/guess/daily/', '/guess/history/',
    '/guess/join/', '/guess/stream/', '/guess/stream/wuote/', '/guess/stream/dunkorslam/?auth_resume=example',
    '/guess/results/11111111-1111-4111-8111-111111111111/'];
  for (const page of pages) {
    const response = await runtime.dispatchFetch('https://example.com' + page);
    assert.equal(response.status, 200, page);
    assert.equal(await response.text(), page === '/' ? '<title>Noita Map</title>' : '<title>NoitaGuessr</title>', page);
  }
  const callback = await runtime.dispatchFetch('https://example.com/guess/twitch-callback.html', { redirect: 'manual' });
  assert.equal(callback.status, 307);
  const result = await runtime.dispatchFetch(new URL(callback.headers.get('location'), 'https://example.com'));
  assert.equal(await result.text(), '<title>Twitch callback</title>');
  console.log(`Passed ${pages.length} page routes and the OAuth callback; no user Worker executed.`);
} finally {
  await runtime?.dispose();
  await rm(directory, { recursive: true, force: true });
}
