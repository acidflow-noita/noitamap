import { parentPort, workerData as threadData } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import koffi from 'koffi';
import { createNativeGLES } from './native-gles.mjs';
import { installNativeTerrainEnvironment } from './native-terrain-environment.mjs';
const host = process;
const workerData = threadData ?? await new Promise(resolve => host.once('message', resolve));
const channel = parentPort ?? { postMessage: data => host.send(data), close: () => host.disconnect() };
let graphics, environment, result;
try {
  graphics = createNativeGLES({ softwareOnly: true });
  environment = installNativeTerrainEnvironment({ ...workerData, fullPixels: true, fixedDate: Date.UTC(2026, 9, 14, 12),
    workerScript: new URL('./native-terrain-worker.mjs', import.meta.url) });
  globalThis.location.search = '?terrain=gpu&terrain-presentation=gpu&terrain-renderer=native';
  globalThis.__profileNativeWorkers = workerData.workers;
  globalThis.__profileEarlyTerrain = workerData.earlyTerrain;
  Object.defineProperty(globalThis, 'navigator', { value: { hardwareConcurrency: 8, userAgent: 'Native presentation profile' }, configurable: true });
  globalThis.WebGL2RenderingContext = class {};
  globalThis.OpenSeadragon = { pixelDensityRatio: 1, TileSource: class {
      constructor(options) { Object.assign(this, options); }
      getLevelScale(level) { return 2 ** (level - this.maxLevel); }
      getNumTiles(level) { const scale = this.getLevelScale(level); return { x: Math.ceil(this.width * scale / this.tileSize), y: Math.ceil(this.height * scale / this.tileSize) }; }
      getClosestLevel() { let level; for (level = this.minLevel + 1; level <= this.maxLevel; level++) { const size = this.getNumTiles(level); if (size.x > 1 || size.y > 1) break; } return level - 1; }
      tileExists(level, x, y) { const size = this.getNumTiles(level); return level >= this.minLevel && level <= this.maxLevel && x >= 0 && y >= 0 && x < size.x && y < size.y; }
    },
    Point: class { constructor(x, y) { Object.assign(this, { x, y }); } },
    Rect: class { constructor(x, y, width, height) { Object.assign(this, { x, y, width, height }); } } };
  let workers = 0;
  const BrowserWorker = globalThis.Worker;
  globalThis.Worker = class extends BrowserWorker { constructor(...args) { super(...args); workers++; } };
  const lib = koffi.load('libGLESv2.so.2'), fence = lib.func('void *glFenceSync(uint condition, uint flags)'),
    wait = lib.func('uint glClientWaitSync(void *sync, uint flags, uint64 timeout)'), remove = lib.func('void glDeleteSync(void *sync)'),
    flush = lib.func('void glFlush()');
  const originalCreate = document.createElement.bind(document);
  document.createElement = tag => {
    const element = tag === 'canvas' ? graphics.createCanvas() : originalCreate(tag);
    element.style ??= {}; element.dataset ??= {}; element.remove ??= () => {};
    element.classList ??= { add() {}, remove() {}, toggle() {} };
    element.setAttribute ??= () => {}; element.removeAttribute ??= () => {};
    if (tag === 'canvas') {
      const get = element.getContext.bind(element);
      element.getContext = (kind, ...args) => {
        const gl = get(kind, ...args);
        if (kind === 'webgl2' && !gl.__presentationProfile) {
          const parameter = gl.getParameter;
          Object.assign(gl, { RENDERER: 0x1f01, SYNC_GPU_COMMANDS_COMPLETE: 0x9117, ALREADY_SIGNALED: 0x911a,
            CONDITION_SATISFIED: 0x911c, WAIT_FAILED: 0x911d, fenceSync: fence, clientWaitSync: wait, deleteSync: remove,
            flush, isContextLost: () => false, __presentationProfile: true,
            getParameter: name => name === 0x1f01 ? graphics.info.renderer : parameter(name) });
        }
        return gl;
      };
    }
    return element;
  };
  const started = performance.now(), api = await import(pathToFileURL(workerData.bundle + '/profile.js'));
  result = await api.profileMapPresentation({ importMs: performance.now() - started, seeds: workerData.seeds,
    memory: () => host.memoryUsage(), workerCount: () => workers, waitImages: () => environment.waitImages(),
    fingerprint: bytes => createHash('sha256').update(bytes).digest('hex'),
    progress: progress => channel.postMessage({ progress }) });
  result.graphics = graphics.info; result.diagnostics = environment.diagnostics;
} catch (error) { result = { error: error.stack }; }
finally { graphics?.dispose(); environment?.close(); }
channel.postMessage(result); channel.close();
