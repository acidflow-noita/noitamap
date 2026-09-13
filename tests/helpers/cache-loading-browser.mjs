/** Real browser regression for the persistent 33% cache-upgrade stall.
 * Run against a built local map (vite preview), never a personal browser profile.
 * No baking, publication or Pro credentials are involved. */
import assert from 'node:assert/strict';
import {chromium, firefox} from 'playwright';
import {mkdir, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';

const base = process.env.MAP_TEST_URL || 'http://127.0.0.1:4173';
const kinds = (process.env.MAP_TEST_BROWSERS || 'chromium,firefox').split(',');
const modes = (process.env.MAP_TEST_CASES || 'healthy,blocked-upgrade,blocked-transaction,denied,daily,mod-handoff,tab-replacement').split(',');
const seed = Number(process.env.MAP_TEST_SEED || '786433191');
const secondSeed = seed === 306813029 ? 786433191 : 306813029;
// Mod-style bitfields: sea_lava unlocked, no pillar achievements.
const modUnlocks = Buffer.from([1, 0, 0, 0, 0]).toString('base64url');
const modPillars = `1.${Buffer.alloc(10).toString('base64url')}`;
const output = resolve(process.env.MAP_TEST_OUTPUT || '/tmp/noitamap-cache-loading');
await mkdir(output, {recursive: true});
const results = [];

async function holdCache(context, mode) {
  if (!mode.startsWith('blocked-')) return null;
  const page = await context.newPage();
  await page.route('**/__cache_holder', route => route.fulfill({contentType: 'text/html', body: '<!doctype html><title>cache regression holder</title>'}));
  await page.goto(`${base}/__cache_holder`);
  await page.evaluate(mode => new Promise((resolve, reject) => {
    const request = indexedDB.open('noitamap-telescope', mode === 'blocked-upgrade' ? 11 : 12);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore('generations', {keyPath: 'cacheKey'});
      db.createObjectStore('biome_renders', {keyPath: 'renderKey'}).createIndex('cacheKey', 'cacheKey');
      db.createObjectStore('pixel_scene_bitmaps', {keyPath: 'key'});
    };
    request.onerror = () => reject(request.error?.message);
    request.onsuccess = () => {
      const db = request.result;
      window.__heldCache = db;
      db.onversionchange = () => {window.__upgradeRequested = true;};
      if (mode === 'blocked-transaction') {
        const tx = db.transaction(['generations', 'biome_renders', 'pixel_scene_bitmaps'], 'readwrite');
        window.__heldTransaction = tx;
        window.__keepTransaction = true;
        const store = tx.objectStore('generations');
        const keepAlive = () => {
          if (window.__keepTransaction) store.get('__cache_test_keepalive').onsuccess = keepAlive;
        };
        keepAlive();
      }
      resolve();
    };
  }), mode);
  return page;
}

async function waitForMap(page, expectedSeed) {
  await page.waitForFunction(seed => {
    const result = window.noitamap?.getGeneration();
    return window.__cacheTestComplete && result && (seed == null || result.seed === seed);
  }, expectedSeed, {timeout: 90000});
  await page.waitForFunction(() => !document.getElementById('map-loading-strip')?.classList.contains('visible'), null, {timeout: 5000});
  return page.evaluate(async () => {
    const result = window.noitamap.getGeneration();
    const positions = Object.entries(result.poisByPW).flatMap(([pw, pois]) =>
      pois.map(p => JSON.stringify([pw, p.type, p.x, p.y]))).sort();
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(positions.join('\n')));
    return {seed: result.seed, worlds: result.parallelWorlds, pois: positions.length,
      fingerprint: [...new Uint8Array(digest)].map(v => v.toString(16).padStart(2, '0')).join(''),
      cacheVersion: localStorage.getItem('noitamap-telescope-version')};
  });
}

for (const kind of kinds) {
  const browser = await ({chromium, firefox}[kind]).launch({headless: true});
  let baseline;
  try {
    for (const mode of modes) {
      const context = await browser.newContext({viewport: {width: 1440, height: 1000}, locale: 'en-US'});
      const start = Date.now(), messages = [], errors = [];
      let activeDocumentStart = 0;
      try {
        await context.addInitScript(() => {
          window.__cacheTestComplete = false;
          window.addEventListener('itemsGenerationProgress', e => {
            if (e.detail?.percentage >= 100) window.__cacheTestComplete = true;
          });
        });
        if (mode === 'denied') await context.addInitScript(() => {
          indexedDB.open = () => {throw new DOMException('Storage disabled for regression test', 'SecurityError');};
        });
        const holder = await holdCache(context, mode);
        let page = await context.newPage();
        const capture = target => {
          target.on('domcontentloaded', () => {if (target === page) activeDocumentStart = messages.length;});
          target.on('console', message => {
            if (target !== page) return; // intentionally closed old tab is not the surviving map
            const text = message.text();
            if (/Telescope|TileCache|DynamicMap|DataArchive/.test(text)) messages.push({ms: Date.now() - start, text});
          });
          target.on('pageerror', error => {if (target === page) errors.push(String(error.stack || error));});
        };
        capture(page);
        await page.goto(mode === 'daily' ? `${base}/?m=dy&ds=1` : `${base}/?m=dy&se=${seed}`, {waitUntil: 'domcontentloaded'});
        const handoff = mode === 'mod-handoff' || mode === 'tab-replacement';
        if (handoff) {
          // Start the handoff while the old page is still initializing/generating.
          await page.waitForFunction(() => document.getElementById('map-loading-status')?.textContent === '33%', null, {timeout: 30000});
          const oldPage = page;
          const launched = await context.newPage();
          const modUrl = `${base}/?m=dy&se=${secondSeed}&u=${modUnlocks}&p=${modPillars}&src=mod`;
          if (mode === 'tab-replacement') {
            // Simulate a launcher closing the old page after opening the new tab,
            // but before that new tab's coordinator starts. Do not disable the
            // coordinator or strip the mod's URL parameters for this test.
            let release, requested;
            const released = new Promise(resolve => {release = resolve;});
            const mainRequested = new Promise(resolve => {requested = resolve;});
            await launched.route(/\/(?:assets\/main-[^/?]+\.js|src\/main\.ts)(?:\?|$)/, async route => {
              requested(); await released; await route.continue();
            });
            page = launched;
            capture(page);
            const navigation = launched.goto(modUrl, {waitUntil: 'domcontentloaded'});
            await Promise.race([mainRequested, new Promise((_, reject) => setTimeout(() => reject(new Error('New tab did not request its entry module')), 15000))]);
            await oldPage.close();
            release();
            await navigation;
          } else {
            // Current map policy: existing tab accepts the URL/reloads; the
            // new duplicate closes or shows its manual-close placeholder.
            await launched.goto(modUrl, {waitUntil: 'domcontentloaded'}).catch(error => {
              if (!launched.isClosed()) throw error;
            });
            await oldPage.waitForURL(url => url.searchParams.get('se') === String(secondSeed) && !url.searchParams.has('src'), {timeout: 15000});
            if (!launched.isClosed()) {
              await launched.waitForFunction(() => document.body?.textContent.includes('Updated existing Noitamap tab'), null, {timeout: 5000})
                .catch(error => {if (!launched.isClosed()) throw error;});
            }
          }
        }
        const cold = await waitForMap(page, mode === 'daily' ? null : handoff ? secondSeed : seed);
        assert.deepEqual(cold.worlds, [-1, 0, 1], `${kind}/${mode}: all worlds required`);
        assert.ok(cold.pois > 1000, `${kind}/${mode}: must finish real generation/POI hydration`);
        const result = {browser: kind, case: mode, readyMs: Date.now() - start, ...cold};
        if (mode === 'healthy') {
          baseline = cold;
          assert.ok(cold.cacheVersion, 'successful invalidation must record the library version');
          const reloadStart = Date.now();
          await page.reload({waitUntil: 'domcontentloaded'});
          const warm = await waitForMap(page, seed);
          assert.equal(warm.fingerprint, cold.fingerprint, 'cached generation preserves all POI positions/types');
          assert.ok(messages.some(m => /Cache check:.*\(HIT\)/.test(m.text)), 'reload must exercise the real cache-hit path');
          result.warmMs = Date.now() - reloadStart;
          await page.evaluate(() => {window.__cacheTestComplete = false;});
          const switchStart = Date.now();
          await page.locator('#dynamicSeedInput').fill(String(secondSeed));
          await page.locator('#dynamicSeedInput').press('Enter');
          const switched = await waitForMap(page, secondSeed);
          result.seedSwitchMs = Date.now() - switchStart;
          result.switchedSeed = switched.seed;
        } else if (mode !== 'daily' && !handoff) {
          if (baseline) assert.equal(cold.fingerprint, baseline.fingerprint, `${mode}: cache failure must not change generated data`);
          assert.equal(cold.cacheVersion, null, 'failed invalidation must not be recorded as successful');
          assert.equal(messages.filter(m => /continuing without the disk cache/.test(m.text)).length, 1,
            'one actionable storage warning, not one warning per scene');
        }
        if (handoff) {
          const finalUrl = new URL(page.url());
          assert.equal(finalUrl.searchParams.get('u'), modUnlocks, 'handoff preserves the mod unlock bitfield');
          assert.equal(finalUrl.searchParams.get('p'), modPillars, 'handoff preserves the mod pillar bitfield');
          assert.equal(finalUrl.searchParams.has('src'), false, 'completed handoff removes its one-shot marker');
          assert.deepEqual(await page.evaluate(() => window.__getUnlocks()), ['sea_lava']);
        }
        // Crucially, the holder stays open throughout map generation. Passing
        // because the test released the blocker early would hide the regression.
        if (holder && mode === 'blocked-upgrade') {
          assert.equal(await holder.evaluate(() => window.__upgradeRequested), true);
        }
        if (holder && mode === 'blocked-transaction') {
          assert.equal(await holder.evaluate(() => window.__keepTransaction), true);
        }
        if (mode === 'daily') {
          assert.ok(messages.some(m => /Baked generation.json hit/.test(m.text)), 'daily must exercise the baked fast path');
          await page.waitForTimeout(3000);
          assert.equal(await page.locator('#map-loading-strip').evaluate(el => el.classList.contains('visible')), false,
            'background archive loading must not resurrect the loading strip');
        }
        assert.deepEqual(errors, [], `${kind}/${mode}: no uncaught page errors`);
        // Firefox reports aborted fetches from the deliberately replaced old
        // document. Retain those in the diagnostic log, but judge the new map's
        // pipeline separately; readiness/data assertions above cannot be bypassed.
        const activeMessages = handoff ? messages.slice(activeDocumentStart) : messages;
        assert.ok(!activeMessages.some(m => /Pipeline failed|Dynamic map.*failed/.test(m.text)), `${kind}/${mode}: no failed map pipeline`);
        results.push(result);
        console.log(JSON.stringify(result));
        await writeFile(resolve(output, `${kind}-${mode}.json`), JSON.stringify({result, messages, errors}, null, 2));
      } catch (error) {
        await writeFile(resolve(output, `${kind}-${mode}-failure.json`), JSON.stringify({messages, errors, failure: String(error.stack || error)}, null, 2));
        throw error;
      } finally {await context.close();}
    }
  } finally {await browser.close();}
}
await writeFile(resolve(output, 'results.json'), JSON.stringify(results, null, 2));
