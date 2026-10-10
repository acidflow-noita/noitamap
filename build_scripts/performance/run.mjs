#!/usr/bin/env node
import { chromium, firefox } from 'playwright';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { resolve, join, extname } from 'node:path';
import { compareRuns, markdownSummary } from './compare.mjs';

const options = Object.fromEntries(process.argv.slice(2).map(arg => { const [key, ...value] = arg.replace(/^--/, '').split('='); return [key, value.join('=')]; }));
const config = JSON.parse(await readFile(new URL('./config.json', import.meta.url), 'utf8'));
const variants = JSON.parse(await readFile(resolve(options.versions || 'performance-versions.json'), 'utf8'));
const kind = options.browser || 'chromium', out = resolve(options.out || `performance-results/${kind}`);
const presentation = options.terrain || 'gpu';
if (!['gpu', 'worker'].includes(presentation)) throw Error('terrain must be gpu or worker');
const expectedBackend = presentation === 'gpu' ? 'main-gpu' : 'worker';
if (!['chromium', 'firefox'].includes(kind) || !variants.some(v => v.label === 'candidate')) throw Error('Invalid browser/version configuration');
config.repeats = Number(options.repeats || config.repeats);
config.handoffs = options.handoffs !== 'false';
if (!Number.isInteger(config.repeats) || config.repeats < 1 || config.repeats > 9) throw Error('repeats must be 1..9');
await mkdir(out, { recursive: true });
let root;
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.csv': 'text/csv', '.dzi': 'application/xml' };
const server = createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (pathname === '/__performance_probe') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Public asset check</title>'); return; }
    const path = resolve(root, '.' + pathname);
    if (path !== root && !path.startsWith(root + '/')) throw Error('Invalid path');
    const file = (await stat(path)).isDirectory() ? join(path, 'index.html') : path;
    res.setHeader('Content-Type', mime[extname(file)] || 'application/octet-stream');
    if (pathname.startsWith('/build/') || pathname.startsWith('/game-assets/')) res.setHeader('Cache-Control', 'public,max-age=31536000,immutable');
    res.end(await readFile(file));
  } catch { res.writeHead(404); res.end('Not found'); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const browserType = kind === 'chromium' ? chromium : firefox;
const launch = () => browserType.launch({
  headless: kind === 'chromium' || options.headless === 'true',
  ...(process.env.PERF_BROWSER_EXECUTABLE ? { executablePath: process.env.PERF_BROWSER_EXECUTABLE } : {}),
  ...(process.env.PERF_BROWSER_CHANNEL ? { channel: process.env.PERF_BROWSER_CHANNEL } : {}),
  ...(kind === 'chromium' ? { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--host-resolver-rules=MAP www.googletagmanager.com ~NOTFOUND,MAP static.cloudflareinsights.com ~NOTFOUND'] } : {}),
});
const analytics = url => /https:\/\/(?:www\.googletagmanager\.com|static\.cloudflareinsights\.com)\//.test(url);
const runs = [];
let daily;
try {
  // Freeze one actual baked identity for both versions. An unpublished/mixed
  // Daily is a failed precondition, never a "baked" run which generated live.
  if (options.baked !== 'false') {
    const browser = await launch();
    try {
      const page = await browser.newPage(); await page.goto(origin + '/__performance_probe');
      daily = await page.evaluate(async () => {
        const get = async url => { const r = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(15000) }); if (!r.ok) throw Error(`${r.status}: ${url}`); return r; };
        const seed = Number((await (await get('https://daily-seed.acidflow.stream/current_seed.txt')).text()).trim());
        const manifests = await Promise.all(['left', 'middle', 'right'].map(async world => (await get(`https://daily-${world}.acidflow.stream/manifest.json`)).json()));
        if (!Number.isInteger(seed) || !manifests.every(m => m.seed === seed && m.baked === true && m.complete === true)) throw Error('Daily pointer and complete baked manifests do not match');
        const descriptors = await Promise.all(['left', 'middle', 'right'].map(async world => {
          const url = `https://daily-${world}.acidflow.stream/map.dzi`, response = await get(url);
          const json = await response.json(), image = json?.Image;
          if (![image?.Size?.Width, image?.Size?.Height, image?.TileSize].every(n => Number.isInteger(Number(n)) && Number(n) > 0)
            || !['webp', 'png', 'jpg', 'jpeg'].includes(image?.Format)) throw Error(`Invalid JSON DZI: ${url}`);
          return { url, contentType: response.headers.get('content-type'), json };
        }));
        return { seed, manifests, descriptors };
      });
      await writeFile(join(out, 'daily.json'), JSON.stringify(daily, null, 2));
    } finally { await browser.close(); }
  }
  for (let trial = 0; trial < config.repeats; trial++) {
    // Rotate starting versions: every version sees the first-run position.
    const ordered = variants.map((_, i) => variants[(i + trial) % variants.length]);
    for (const variant of ordered) for (const scenario of daily ? ['direct', 'baked'] : ['direct']) {
      root = resolve(variant.root);
      const result = { variant: variant.label, commit: variant.commit, trial: trial + 1, scenario, presentation, phases: [], logs: [], errors: [], browserDiagnostics: [], requestErrors: [], cancelledRequests: [], valid: false };
      const file = join(out, `${variant.label}-${scenario}-${trial + 1}.json`);
      const browser = await launch();
      const watchdog = setTimeout(() => { result.failure = 'Trial exceeded five minutes'; void browser.close(); }, 300000);
      result.browser = `${kind} ${browser.version()}`;
      const context = await browser.newContext({ viewport: config.viewport, deviceScaleFactor: 1 });
      context.setDefaultTimeout(15000);
      context.setDefaultNavigationTimeout(45000);
      await context.addInitScript(() => {
        const probe = window.__mapPerformance = { documentId: Math.random().toString(36), logs: [], frames: [], tasks: [], start: 0 };
        let previous = performance.now();
        requestAnimationFrame(function tick(t) { probe.frames.push({ start: previous, end: t, ms: t - previous }); previous = t; requestAnimationFrame(tick); });
        if (PerformanceObserver.supportedEntryTypes.includes('longtask')) new PerformanceObserver(list => {
          for (const item of list.getEntries()) probe.tasks.push({ start: item.startTime, duration: item.duration });
        }).observe({ type: 'longtask', buffered: true });
        for (const level of ['log', 'info', 'warn', 'error']) {
          const original = console[level];
          console[level] = function(...args) {
            if (typeof args[0] === 'string' && /DynamicMap|Instant terrain|TileCache/.test(args[0])) probe.logs.push({ time: performance.now(), text: args[0] });
            original.apply(this, args);
          };
        }
      });
      const watch = page => {
        page.on('pageerror', error => {
          const text = String(error), location = text.match(/^XML Parsing Error: not well-formed\nLocation: (https:\/\/[^\n]+\/map\.dzi)\n/);
          // Firefox BiDi reports its automatic XHR XML probe of these valid
          // JSON DZIs as a pageerror. Preserve the diagnostic separately;
          // only preflight-validated URLs qualify. Broken bakes/assets and
          // actual JavaScript errors still fail the run.
          if (location && daily?.descriptors.some(d => d.url === location[1])) result.browserDiagnostics.push(text);
          else result.errors.push(text);
        });
        page.on('console', message => { if (/DynamicMap|Instant terrain|TileCache/.test(message.text())) result.logs.push(message.text()); });
        page.on('requestfailed', request => {
          if (analytics(request.url())) return;
          const error = request.failure()?.errorText || 'unknown';
          // Seed changes and closing a document deliberately abort stale work.
          (/ABORT/i.test(error) ? result.cancelledRequests : result.requestErrors).push(`${error}: ${request.url()}`);
        });
        page.on('response', response => { if (response.status() >= 400 && !analytics(response.url())) result.requestErrors.push(`${response.status()}: ${response.url()}`); });
      };
      let page = await context.newPage(); watch(page);
      const camera = config.camera;
      const url = seed => `${origin}/?m=dy&se=${seed}&x=${camera.x}&y=${camera.y}&z=${camera.z}&lng=en&terrain-presentation=${presentation}`;
      const begin = () => page.evaluate(() => {
        const p = window.__mapPerformance; p.start = performance.now(); p.logs = []; p.frames = []; p.tasks = [];
      });
      const ready = async seed => page.waitForFunction(seed => {
        const h = window.__noitamap, generation = window.noitamap?.getGeneration?.();
        return h?.getSeedParams().seed === seed && generation?.seed === seed
          && !document.querySelector('#dynamicGenerateButton .spinner-border')
          && !document.getElementById('map-loading-strip')?.classList.contains('visible');
      }, seed, { timeout: 120000, polling: 50 });
      const snapshot = () => page.evaluate(() => {
        const p = window.__mapPerformance, h = window.__noitamap, viewer = h.osd.viewer ?? h.osd;
        const sources = viewer.world._items.map(i => i.source);
        const terrain = sources.filter(s => s.__instantViewport).map(s => JSON.parse(JSON.stringify(s.instantStats)));
        const generation = window.noitamap.getGeneration();
        return { documentId: p.documentId, durationMs: performance.now() - p.start, seed: generation.seed, baked: h.isBakedSeed(), terrain,
          // A stable semantic state check, independent of console wording.
          poiCount: Object.values(generation.poisByPW).reduce((n, list) => n + list.length, 0),
          bakedSources: sources.filter(s => /(?:daily|previous-daily)-(?:left|middle|right)\./.test(String(s.tilesUrl ?? ''))).map(s => s.tilesUrl),
          maxFrameGapMs: Math.max(0, ...p.frames.map(f => f.end - Math.max(f.start, p.start))),
          maxLongTaskMs: PerformanceObserver.supportedEntryTypes.includes('longtask')
            ? Math.max(0, ...p.tasks.map(t => t.start + t.duration - Math.max(t.start, p.start))) : null,
          logs: p.logs, url: location.href, camera: { center: viewer.viewport.getCenter(true), zoom: viewer.viewport.getZoom(true) } };
      });
      const record = async (label, seed, baked = false, started = undefined) => {
        await ready(seed); const state = await snapshot();
        if (started !== undefined) state.durationMs = Date.now() - started;
        if (state.poiCount < 1000) throw Error('Incomplete POI data');
        if (baked) {
          if (!state.baked || state.terrain.length || state.bakedSources.length !== 3) throw Error('Expected three baked worlds and no live terrain');
        } else if (state.baked || state.terrain[0]?.backend !== expectedBackend) throw Error('Unexpected renderer/fallback');
        result.phases.push({ label, ...state });
        await writeFile(file, JSON.stringify(result, null, 2));
        console.log(JSON.stringify({ browser: kind, variant: variant.label, scenario, trial: trial + 1, phase: label, ms: Math.round(state.durationMs) }));
        return state;
      };
      const changeSeed = async (label, seed) => { await begin(); await page.evaluate(seed => window.__noitamap.setSeedParams(seed), seed); return record(label, seed); };
      const handoff = async (label, seed, x, u, p, positionOnly = false) => {
        const original = await snapshot(); await begin();
        const started = Date.now(), duplicate = await context.newPage();
        watch(duplicate);
        const closedDuringRead = async error => {
          if (duplicate.isClosed()) return 'closed';
          if (!/closed|no such frame|Browsing Context.*not found/i.test(String(error))) throw error;
          // Firefox BiDi can report the removed frame before its close event.
          await duplicate.waitForEvent('close', { timeout: 1000 }).catch(() => {
            if (!duplicate.isClosed()) throw error;
          });
          return 'closed';
        };
        const target = new URL(url(seed));
        for (const [key, value] of Object.entries({ ...config.modCamera, x, u, p, src: 'mod' })) target.searchParams.set(key, String(value));
        await duplicate.goto(target.href, { waitUntil: 'domcontentloaded' }).catch(closedDuringRead);
        // Playwright's independently-created tabs are not always script-
        // closable. Close the acknowledged placeholder before timing terrain,
        // otherwise the destination is backgrounded and its rAF is throttled.
        let usedNewTab = false;
        if (!duplicate.isClosed()) {
          const response = await duplicate.waitForFunction(() => document.getElementById('nm-close-btn') ? 'accepted' : window.__noitamap ? 'fallback' : false,
            undefined, { timeout: 15000 }).then(handle => handle.jsonValue()).catch(closedDuringRead);
          if (response !== 'closed' && !duplicate.isClosed()) {
            usedNewTab = response === 'fallback';
            if (usedNewTab) {
              if (variant.label === 'candidate') throw Error('A ready map existed but mod launch started another document');
              // Legacy revisions can miss discovery and open the new tab.
              // Measure the resulting usable map, and record that path.
              await page.close(); page = duplicate;
            } else await duplicate.close();
          }
        }
        await page.bringToFront();
        await page.waitForFunction(({ seed, x, u, p }) => {
          const params = new URLSearchParams(location.search), h = window.__noitamap;
          return h?.getSeedParams().seed === seed && params.get('u') === u && params.get('p') === p
            && Math.abs(h.osd.viewport.getCenter(true).x - x) < 1;
        }, { seed, x, u, p }, { timeout: 120000 });
        const state = await record(label, seed, false, started);
        result.phases.at(-1).handoff = usedNewTab ? 'new-tab' : 'existing-tab';
        if (variant.label === 'candidate' && (state.documentId !== original.documentId || (positionOnly
          && state.logs.some(l => l.text.startsWith('[DynamicMap] Generating') || l.text.startsWith('[DynamicMap] Rendering')))))
          throw Error('Mod launch lost the warm document or a position-only update rebuilt terrain');
      };
      try {
        await page.goto(url(scenario === 'baked' ? daily.seed : config.seed), { waitUntil: 'domcontentloaded' });
        if (scenario === 'baked') {
          await record('baked-start', daily.seed, true);
          await changeSeed('first-dynamic', config.seed);
        } else {
          await record('cold-start', config.seed);
          await changeSeed('warm-new-seed', config.nextSeed);
          await changeSeed('cached-return', config.seed);
          await page.reload({ waitUntil: 'domcontentloaded' });
          const reload = await record('cached-reload', config.seed);
          if (reload.logs.some(l => l.text.startsWith('[DynamicMap] Generating seed '))) throw Error('Cached reload regenerated the primary map');
          // A real URL navigation, independent of in-page seed changes.
          await page.goto(url(config.seed).replace(`x=${camera.x}&`, `x=${camera.x + 1}&`), { waitUntil: 'domcontentloaded' });
          const navigated = await record('cached-url-navigation', config.seed);
          if (navigated.logs.some(l => l.text.startsWith('[DynamicMap] Generating seed '))) throw Error('Cached URL navigation regenerated the primary map');
          if (config.handoffs) {
            const modSeed = config.nextSeed + 1;
            await handoff('mod-new-seed', modSeed, config.modCamera.x + 2, 'AQAAAAA', '1.AAAAAAAAAAAAAA');
            await handoff('mod-position-only', modSeed, config.modCamera.x + 3, 'AQAAAAA', '1.AAAAAAAAAAAAAA', true);
            await handoff('mod-unlocks', modSeed, config.modCamera.x + 4, 'AgAAAAA', '1.AAAAAAAAAAAAAA');
            await handoff('mod-pillars', modSeed, config.modCamera.x + 5, 'AgAAAAA', '1.AgAAAAAAAAAAAA');
          }
        }
        await page.evaluate(camera => {
          const h = window.__noitamap, v = h.osd.viewer ?? h.osd;
          v.viewport.panTo({ x: camera.x, y: camera.y }, true);
          v.viewport.zoomTo(2 ** (-camera.z / 100), undefined, true);
          return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        }, config.navigationCamera);
        await begin();
        console.log(`${variant.label}/${scenario}: navigation check`);
        // Input-driven navigation after readiness; frame gaps expose stalls.
        const box = await page.evaluate(() => { const b = window.__noitamap.osdElement.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; });
        const x = box.x + box.width / 2, y = box.y + box.height / 2;
        await page.mouse.move(x, y); await page.mouse.down();
        for (let step = 1; step <= 4; step++) await page.mouse.move(x + step * 20, y, { steps: 1 });
        await page.mouse.up();
        for (const delta of [-120, 120]) {
          await page.mouse.wheel(0, delta);
          await page.waitForFunction(() => {
            const h = window.__noitamap, v = (h.osd.viewer ?? h.osd).viewport;
            return Math.abs(v.getZoom(true) / v.getZoom() - 1) < 0.0001
              && v.getCenter(true).distanceTo(v.getCenter()) < 0.1;
          }, undefined, { polling: 'raf', timeout: 15000 });
        }
        console.log(`${variant.label}/${scenario}: waiting for navigation frames`);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const navigation = await snapshot(); result.navigation = navigation;
        result.phases.push({ label: 'navigation-frame-gap', ...navigation, durationMs: navigation.maxFrameGapMs });
        console.log(`${variant.label}/${scenario}: navigation complete; screenshot and graphics probe`);
        if (variant.label === 'candidate' && trial === 0)
          await page.screenshot({ path: join(out, `${variant.label}-${scenario}-${trial + 1}.png`), timeout: 15000 });
        result.backend = navigation.terrain[0]?.backend;
        // Probe after retiring the workload document: an extra context must
        // not compete with its terrain textures or warm the cold measurement.
        await page.close();
        const probe = await context.newPage();
        result.graphics = await probe.evaluate(() => {
          const gl = document.createElement('canvas').getContext('webgl2'); if (!gl) return { webgl2: false };
          const debug = gl.getExtension('WEBGL_debug_renderer_info'), pixel = new Uint8Array(4);
          gl.clearColor(1, 0, 1, 1); gl.clear(gl.COLOR_BUFFER_BIT); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
          return { webgl2: true, renderer: gl.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER), pixel: [...pixel], error: gl.getError() };
        });
        if (!result.graphics.webgl2 || result.graphics.error || result.graphics.pixel.join() !== '255,0,255,255') throw Error('Graphics probe failed');
        if (result.errors.length || result.requestErrors.length) throw Error('Browser or required asset errors; see report');
        if (result.logs.some(l => /Pipeline failed|Using approximate terrain|worker timed out|backend.*failed/i.test(l))) throw Error('Terrain failed or fell back');
        result.valid = true;
      } catch (error) {
        result.failure = String(error); result.stack = error.stack; console.error(`${variant.label}/${scenario}: ${result.failure}`);
        await page.screenshot({ path: join(out, `${variant.label}-${scenario}-${trial + 1}-failed.png`), timeout: 10000 }).catch(() => {});
      }
      finally { clearTimeout(watchdog); runs.push(result); await writeFile(file, JSON.stringify(result, null, 2)); await browser.close(); }
    }
  }
  const comparison = compareRuns(runs, config);
  await writeFile(join(out, 'results.json'), JSON.stringify({ config, variants, daily, comparison, runs }, null, 2));
  const summary = markdownSummary(comparison, runs);
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) await writeFile(process.env.GITHUB_STEP_SUMMARY, summary, { flag: 'a' });
  for (const row of comparison.timingRegressions) for (const r of row.regressions)
    console.log(`::warning title=Map performance::${row.scenario}/${row.phase} vs ${r.baseline}: +${Math.round(r.deltaMs)}ms, ${(r.relative * 100).toFixed(1)}%`);
  if (!comparison.comparable || (config.enforceTiming && comparison.timingRegressions.length)) process.exitCode = 1;
} finally { await new Promise(done => server.close(done)); }
