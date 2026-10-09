/** Native scheduling check, not browser/network/GPU benchmarking.
 * Run: node --import tsx build_scripts/measure-daily-asset-worker.mjs
 * Requires current prepared scenes (npm run prepare-telescope-scenes).
 * Builds the real asset worker and feeds it shipped files through fetch and
 * CacheStorage adapters while sampling the parent thread's event loop. */
import { build } from 'vite';
import { Worker } from 'node:worker_threads';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataArchivesPlugin } from './vite-data-archives.ts';
import { telescopeScenesPlugin } from './vite-telescope-scenes.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = await mkdtemp(resolve(tmpdir(), 'noitamap-daily-worker-'));
try {
  await build({
    root, configFile: false, publicDir: false, logLevel: 'error',
    plugins: [dataArchivesPlugin(root), telescopeScenesPlugin(root)],
    build: { outDir: output, emptyOutDir: true, minify: false, target: 'esnext',
      rolldownOptions: { input: resolve(root, 'src/telescope/daily-asset-worker.ts'),
        output: { entryFileNames: 'asset-worker.mjs', codeSplitting: false } },
    },
  });
  const source = `
    const { parentPort, workerData } = await import('node:worker_threads');
    const { readFile } = await import('node:fs/promises');
    const { pathToFileURL } = await import('node:url');
    globalThis.self = globalThis;
    globalThis.location = new URL('https://map.test/assets/worker.mjs');
    globalThis.postMessage = message => parentPort.postMessage(message);
    const disk = new Map();
    const key = request => typeof request === 'string' ? request : request.url;
    globalThis.caches = { open: async name => {
      if (!disk.has(name)) disk.set(name, new Map());
      const entries = disk.get(name);
      return {
        match: async request => entries.get(key(request))?.clone(),
        put: async (request, response) => { entries.set(key(request), response.clone()); },
        delete: async request => entries.delete(key(request)),
      };
    }};
    const nativeFetch = fetch;
    globalThis.fetch = async input => {
      const url = new URL(typeof input === 'string' ? input : input.url);
      if (url.protocol === 'data:') return nativeFetch(input);
      const path = decodeURIComponent(url.pathname);
      let data;
      try { data = await readFile(workerData.output + path); }
      catch { data = await readFile(workerData.root + '/public' + path); }
      return new Response(data, { headers: { 'Content-Length': String(data.byteLength) } });
    };
    await import(pathToFileURL(workerData.output + '/asset-worker.mjs').href);
    self.onmessage({ data: { baseUrl: 'https://map.test/', fullPixels: true } });
  `;
  const delay = monitorEventLoopDelay({ resolution: 10 });
  delay.enable();
  let ticks = 0, maxGap = 0, last = performance.now();
  const interval = setInterval(() => {
    const now = performance.now(); maxGap = Math.max(maxGap, now - last); last = now; ticks++;
  }, 10);
  const began = performance.now(), stages = [];
  const worker = new Worker(source, { eval: true, type: 'module', workerData: { root, output } });
  try {
    const done = await new Promise((resolve, reject) => {
      worker.on('error', reject);
      worker.on('message', message => {
        if (message.type === 'failure') console.error(message);
        if (message.type === 'stage' && message.state === 'finished') stages.push(message);
        if (message.type === 'done') resolve(message);
      });
    });
    console.log(JSON.stringify({ ...done, wallMs: performance.now() - began, heartbeatTicks: ticks,
      maxHeartbeatGapMs: maxGap, eventLoopP99Ms: delay.percentile(99) / 1e6, stages,
      environment: 'Native Node worker; real shipped assets; local fetch and in-memory CacheStorage; not browser/network/GPU performance',
    }, null, 2));
    if (done.failures) process.exitCode = 1;
  } finally {
    clearInterval(interval); delay.disable(); await worker.terminate();
  }
} finally { await rm(output, { recursive: true, force: true }); }
