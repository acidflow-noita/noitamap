import { build } from 'vite';
import { fork } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir, cpus } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2), value = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const output = resolve(value('--out', 'task/native-engine/presentation-profile.json'));
const order = value('--order', '1,3,3,1').split(',').map(Number), seeds = value('--seeds', '618,11033,786433191').split(',').map(Number);
const early = value('--early', order.map(() => 'auto').join(',')).split(',');
if (order.some(n => ![1, 2, 3].includes(n)) || seeds.some(n => !Number.isInteger(n) || n < 0 || n > 0xffffffff)) throw Error('Invalid worker order or seeds');
if (early.length !== order.length || early.some(mode => !['auto', 'on', 'off'].includes(mode))) throw Error('--early must specify auto/on/off for each run');
const bundle = await mkdtemp(resolve(tmpdir(), 'noitamap-presentation-profile-'));
try {
  let injected = false;
  const phaseFunctions = {
    'src/telescope/telescope-osd-bridge.ts': ['instantSceneMasks', 'buildSceneBitmaps', 'addPixelScenes', 'prepareInstantTerrainResources'],
    'src/telescope/instant-terrain-backend.ts': ['prepareInstantTerrain'],
  };
  await build({ configFile: resolve(root, 'vite.config.ts'), logLevel: 'error', publicDir: false,
    plugins: [{ name: 'profile-only-native-worker-count', enforce: 'pre', transform(code, id) {
      if (id === resolve(root, 'src/telescope/telescope-adapter.ts')) {
        const needle = 'new NativeWorldPool()';
        if (code.split(needle).length !== 3) throw Error('Review changed native pool initialization');
        const gate = 'nativeClient.workerCountFor(opts.parallelWorlds) === 1';
        if (!code.includes(gate)) throw Error('Review changed terrain preparation policy');
        injected = true; return code.replaceAll(needle, 'new NativeWorldPool(undefined, (globalThis as any).__profileNativeWorkers)')
          .replace(gate, `((globalThis as any).__profileEarlyTerrain ?? (${gate}))`);
      }
      if (id === resolve(root, 'src/native-map/client.ts')) {
        const needle = 'this.call("generate", request, signal, onTerrainReady)';
        if (!code.includes(needle)) throw Error('Review changed native terrain streaming call');
        return code.replace(needle, 'this.call("generate", request, signal, (globalThis as any).__profileEarlyTerrain === false ? undefined : onTerrainReady)');
      }
      for (const [file, functions] of Object.entries(phaseFunctions)) if (id === resolve(root, file)) {
        for (const name of functions) if (!code.includes(`function ${name}(`)) throw Error(`Review changed profile phase: ${name}`);
        return code + `\nfunction __mapProfileCall(original: any, name: string) {
          return async function(this: any, ...args: any[]) {
            const log = (globalThis as any).__mapPresentationStages, start = performance.now();
            try { return await original.apply(this, args); }
            finally { log?.push({ name, start, end: performance.now() }); }
          };
        }\n` + functions.map(name => `${name} = __mapProfileCall(${name}, ${JSON.stringify(name)});`).join('\n');
      }
    } }], build: { outDir: bundle, rollupOptions: { input: resolve(root, 'build_scripts/map-presentation-fixture.ts'),
      preserveEntrySignatures: 'strict', output: { entryFileNames: 'profile.js', manualChunks: () => undefined } } } });
  if (!injected) throw Error('Worker-count comparison not installed');
  const runs = [];
  for (const [index, workers] of order.entries()) {
    const result = await new Promise((done, reject) => {
      // A real process gives Mesa its own environment and fresh driver state.
      // Worker-thread process.env copies do not isolate native library caches.
      const worker = fork(fileURLToPath(new URL('./map-presentation-profile-worker.mjs', import.meta.url)), [], {
        env: { ...process.env, MESA_SHADER_CACHE_DISABLE: 'true' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      worker.send({ root, bundle, workers, seeds, earlyTerrain: early[index] === 'auto' ? undefined : early[index] === 'on' });
      let report, logs = '';
      for (const stream of [worker.stdout, worker.stderr]) stream.on('data', b => logs = (logs + b).slice(-16000));
      const timer = setTimeout(() => { worker.kill(); reject(Error('Presentation profile timeout\n' + logs)); }, 120000);
      worker.on('message', data => { if (data.progress) console.log(`[${workers} workers, early ${early[index]}] ${data.progress}`); else report = data; });
      worker.on('error', error => { clearTimeout(timer); reject(Error(error.stack + '\n' + logs)); });
      worker.on('exit', code => { clearTimeout(timer); if (code || !report || report.error) reject(Error((report?.error ?? `Worker exit ${code}`) + '\n' + logs)); else done(report); });
    });
    runs.push({ workers, earlyTerrain: early[index], ...result });
    if (result.diagnostics.length) throw Error(JSON.stringify(result.diagnostics));
  }
  for (let i = 0; i < seeds.length; i++) if (new Set(runs.map(run => run.samples[i].pixelHash)).size !== 1) throw Error(`Viewport pixel mismatch for seed ${seeds[i]}`);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify({ measuredAt: new Date().toISOString(), host: { cpu: cpus()[0]?.model, node: process.version }, runs }, null, 2) + '\n');
  console.log(JSON.stringify({ output, runs: runs.map(run => ({ workers: run.workers, earlyTerrain: run.earlyTerrain, samples: run.samples.map(s => ({ seed: s.seed,
    firstPaintMs: Math.round(s.firstPaintMs), completeMs: Math.round(s.completeMs), generationMs: Math.round(s.generationMs) })) })) }));
} finally { await rm(bundle, { recursive: true, force: true }); }
