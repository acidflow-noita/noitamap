import { createHash } from 'node:crypto';

const seedURL = 'https://daily-seed.acidflow.stream/current_seed.txt';
const previousURL = 'https://daily-seed.acidflow.stream/previous_seed.txt';
const assetHosts = ['left', 'middle', 'right'].map(world => `daily-${world}.acidflow.stream`);
const metadataHosts = [...assetHosts, ...assetHosts.map(host => 'previous-' + host)];
export const fixturePath = '/__daily_fixture__/';
const normalized = href => { const url = new URL(href); return url.origin + url.pathname; };
const headersForReplay = headers => Object.fromEntries(Object.entries(headers).filter(([name]) =>
  !['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'set-cookie'].includes(name.toLowerCase())));

/** Capture real published bytes outside timings, then replay them for every
 * version/profile. An uncaptured request fails instead of hitting a new Daily
 * halfway through a comparison or inventing a synthetic bake. */
export function createDailyReplay(seed, previousSeed) {
  if (![seed, previousSeed].every(n => Number.isInteger(n) && n > 0 && n <= 0xffffffff))
    throw Error('Daily fixture requires valid captured seed identities');
  const assets = new Map();
  const pointer = value => ({ status: 200, headers: { 'content-type': 'text/plain', 'access-control-allow-origin': '*' }, body: Buffer.from(String(value)) });
  assets.set(seedURL, pointer(seed));
  assets.set(previousURL, pointer(previousSeed));
  return {
    assets,
    capture(url, response) {
      const key = normalized(url), parsed = new URL(key);
      if (!metadataHosts.includes(parsed.hostname)) return;
      if (response.status !== 200) throw Error(`Baked fixture HTTP ${response.status}: ${key}`);
      const value = { status: 200, headers: headersForReplay(response.headers), body: Buffer.from(response.body) };
      const old = assets.get(key);
      if (old && !old.body.equals(value.body)) throw Error(`Baked fixture changed while capturing: ${key}`);
      assets.set(key, value);
    },
    response(url) {
      const key = normalized(url), value = assets.get(key);
      if (!value) throw Error(`Uncaptured baked fixture asset: ${key}`);
      return value;
    },
    manifest() {
      return { seed, previousSeed, scope: 'Published baked startup at the configured viewport; frozen seed pointers and exact baked response bodies.',
        assets: [...assets].map(([url, value]) => ({ url, bytes: value.body.length,
          sha256: createHash('sha256').update(value.body).digest('hex') })) };
    },
  };
}

/** Rewrite only the public Daily transports to the local snapshot. Using
 * Playwright routing here would disable the browser's entire HTTP cache and
 * invalidate the reload measurements. The production bundles stay unchanged. */
export function installDailyTransport({ origin, path }) {
  const remap = value => {
    try {
      const url = new URL(String(value), location.href);
      if (!/^(?:daily-seed|(?:previous-)?daily-(?:left|middle|right))\.acidflow\.stream$/.test(url.hostname)) return value;
      return origin + path + url.hostname + url.pathname + url.search;
    } catch { return value; }
  };
  const fetchOriginal = window.fetch;
  window.fetch = (input, init) => {
    if (input instanceof Request) {
      const mapped = remap(input.url);
      return fetchOriginal.call(window, mapped === input.url ? input : new Request(mapped, input), init);
    }
    return fetchOriginal.call(window, remap(input), init);
  };
  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) { return open.call(this, method, remap(url), ...rest); };
  const src = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
  Object.defineProperty(HTMLImageElement.prototype, 'src', { ...src, set(value) { src.set.call(this, remap(value)); } });
}

export async function captureDailyFixture(browser, origin, daily, config) {
  const replay = createDailyReplay(daily.seed, daily.previousSeed), errors = [], pending = [], inFlight = new Set();
  const context = await browser.newContext({ viewport: config.viewport, deviceScaleFactor: 1 });
  try {
    // Freeze date detection before booting the actual baked route. The live
    // capture still fetches every manifest, generation file, DZI and tile.
    await context.route('https://daily-seed.acidflow.stream/**', route => route.fulfill(replay.response(route.request().url())));
    const page = await context.newPage();
    page.on('request', request => { if (metadataHosts.includes(new URL(request.url()).hostname)) inFlight.add(request); });
    page.on('requestfinished', request => inFlight.delete(request));
    page.on('requestfailed', request => {
      if (inFlight.delete(request)) errors.push(`${request.failure()?.errorText}: ${request.url()}`);
    });
    page.on('response', response => {
      if (!metadataHosts.includes(new URL(response.url()).hostname)) return;
      pending.push(Promise.all([response.body(), response.allHeaders()]).then(([body, headers]) =>
        replay.capture(response.url(), { status: response.status(), body, headers })).catch(error => errors.push(String(error))));
    });
    const { x, y, z } = config.camera;
    await page.goto(`${origin}/?m=dy&se=${daily.seed}&ds=1&x=${x}&y=${y}&z=${z}&lng=en`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(seed => {
      const h = window.__noitamap, gen = window.noitamap?.getGeneration?.(), v = h?.osd?.viewer ?? h?.osd;
      if (!h?.isBakedSeed() || gen?.seed !== seed || !v?.world
        || document.querySelector('#dynamicGenerateButton .spinner-border')
        || document.getElementById('map-loading-strip')?.classList.contains('visible')) return false;
      const baked = v.world._items.filter(item => /daily-(left|middle|right)\./.test(String(item.source?.tilesUrl)));
      return baked.length === 3 && !v.isAnimating?.() && baked.every(item => item.getFullyLoaded());
    }, daily.seed, { timeout: 60000 });
    if (inFlight.size) throw Error('Baked fixture still has unfinished requests');
    await Promise.all(pending);
    if (errors.length) throw Error(errors.join('\n'));
    for (const prefix of ['daily', 'previous-daily']) for (const [index, world] of ['left', 'middle', 'right'].entries()) {
      const url = `https://${prefix}-${world}.acidflow.stream/manifest.json`;
      const before = (prefix === 'daily' ? daily.manifests : daily.previousManifests)[index];
      const captured = prefix === 'daily' ? JSON.parse(replay.response(url).body.toString()) : before;
      const after = await page.evaluate(async url => {
        const r = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(15000) });
        if (!r.ok) throw Error(`Fixture verification HTTP ${r.status}: ${url}`);
        return r.json();
      }, url);
      if (![captured, after].every(m => m.seed === before.seed && m.renderId === before.renderId && m.generatedAt === before.generatedAt))
        throw Error('Published bake changed during fixture capture');
      if (prefix === 'daily') {
        replay.response(`https://daily-${world}.acidflow.stream/map.dzi`);
        replay.response(`https://daily-${world}.acidflow.stream/generation.json`);
      }
    }
    await Promise.all(pending);
    if (errors.length) throw Error(errors.join('\n'));
    return replay;
  } finally { await context.close(); }
}
