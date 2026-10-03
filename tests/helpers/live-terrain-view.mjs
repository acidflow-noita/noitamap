import { parentPort, workerData } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { installNativeTerrainEnvironment } from '../../build_scripts/native-terrain-environment.mjs';
import { createNativeGLES } from '../../build_scripts/native-gles.mjs';
const gpu = workerData.cpu ? null : createNativeGLES({ softwareOnly: true });
const env = installNativeTerrainEnvironment({ ...workerData, eagerTerrainResourceWorker: true,
  workerScript: new URL('../../build_scripts/native-terrain-worker.mjs', import.meta.url) });
const nativeCreate = document.createElement.bind(document);
let refusedContexts = 0;
document.createElement = tag => {
  if (tag !== 'canvas' || !workerData.cpu) return tag === 'canvas' ? gpu.createCanvas() : nativeCreate(tag);
  const canvas = nativeCreate(tag), events = new EventTarget(), context = canvas.getContext.bind(canvas);
  canvas.addEventListener = events.addEventListener.bind(events);
  canvas.removeEventListener = events.removeEventListener.bind(events);
  canvas.getContext = (kind, ...args) => {
    if (kind === 'webgl2' || kind === 'webgl') { refusedContexts++; return null; }
    return context(kind, ...args);
  };
  return canvas;
};
let live, heartbeat;
const progress = setInterval(() => { if (live) console.log('Live progress', JSON.stringify({
  ready: live.view?.ready, pending: live.view?.pending(), sceneMissing: live.view?.scenes.missing,
  decalMissing: live.view?.decals.missingInView, failed: live.view?.failed,
  preparing: !!live.worker,
})); }, 5000);
try {
  globalThis.OpenSeadragon = (await import('openseadragon')).default;
  console.log('Importing live bundle');
  const api = await import(pathToFileURL(workerData.entry));
  console.log('Generating seed');
  api.setGLTerrain(true);
  const generation = await api.generateDynamicMap({ seed: workerData.seed, parallelWorlds: workerData.parallelWorlds });
  if (workerData.cachedLayers) {
    generation.tileLayers = generation.tileLayers.map(layer => api.restoreTileLayer(structuredClone(api.serializeTileLayer(layer))));
    for (const scenes of Object.values(generation.pixelScenesByPW)) for (const scene of scenes) {
      scene.imgElement = null; scene.imgData = null;
    }
  }
  generation.sceneData = await api.prepareTerrainSceneData(generation);
  console.log('Scene data prepared');
  if (workerData.worker) live = new api.LiveTerrainClient(generation);
  else if (!workerData.cpu && !workerData.wide) live = new api.LiveTerrainView(generation, {
    GLTerrainRenderer: api.terrain.GLTerrainRenderer,
    initMaterialAtlas: api.materialAtlas.initMaterialAtlas,
    getWorldSize: api.utils.getWorldSize, getWorldCenter: api.utils.getWorldCenter,
    GENERATOR_CONFIG: (await import(pathToFileURL(workerData.configEntry))).GENERATOR_CONFIG,
  });
  if (workerData.cpu || workerData.wide) {
    const deps = { GLTerrainRenderer: api.terrain.GLTerrainRenderer, initMaterialAtlas: api.materialAtlas.initMaterialAtlas,
      getWorldSize: api.utils.getWorldSize, getWorldCenter: api.utils.getWorldCenter,
      GENERATOR_CONFIG: (await import(pathToFileURL(workerData.configEntry))).GENERATOR_CONFIG };
    const width = workerData.wide ? 107520 : 2 ** (1369 / 100);
    let bounds = { x: workerData.wide ? -53760 : -3060 - width / 2,
      y: workerData.wide ? -30000 : 3548 - width * 9 / 32, width, height: width * 9 / 16 };
    let start = performance.now();
    let lastBeat = start, maxUiGap = 0;
    heartbeat = setInterval(() => { const now = performance.now(); maxUiGap = Math.max(maxUiGap, now - lastBeat); lastBeat = now; }, 16);
    const items = [], events = new Map(), frames = [];
    let nextFrame, failure;
    const awaitFrame = () => new Promise((resolve, reject) => { nextFrame = resolve; failure = reject; });
    window.addEventListener('fullPixelTerrainError', e => failure?.(new Error(e.detail.message)));
    const viewer = {
      world: { getItemCount: () => items.length, getIndexOfItem: item => items.indexOf(item),
        removeItem: item => items.splice(items.indexOf(item), 1) },
      viewport: { getBounds: () => ({ getBoundingBox: () => bounds }), getBoundsNoRotate: () => bounds,
        getContainerSize: () => ({ x: 1024, y: 576 }), getCenter: () => ({ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }) },
      addHandler(name, handler) { if (!events.has(name)) events.set(name, new Set()); events.get(name).add(handler); },
      removeHandler: (name, handler) => events.get(name)?.delete(handler), forceRedraw() {},
      addTiledImage(options) {
        let image;
        options.tileSource.downloadTileStart({ finish(ctx) { image = ctx.canvas; } });
        const item = { addHandler() {}, removeHandler() {}, getFullyLoaded: () => true };
        items.splice(options.index, 0, item); options.success({ item });
        // Wide view includes real vertical workers, but they must not gate the
        // main-world image. Only accept a frame for the current camera.
        if (options.y < -7168 || options.y >= 17408 || options.x !== bounds.x) return;
        const rgba = image.getContext('2d').getImageData(0, 0, image.width, image.height).data;
        const frame = { ms: performance.now() - start, colors: new Set(new Uint32Array(rgba.buffer)).size,
          hash: createHash('sha256').update(rgba).digest('hex'), visible: rgba.filter((v,i) => i % 4 === 3 && v).length };
        const resolve = nextFrame; nextFrame = undefined; resolve?.(frame);
      },
    };
    const first = awaitFrame();
    await api.addFullPixelLayers(viewer, generation, deps, () => true, () => {}, () => {});
    frames.push(await first);
    console.log('First mounted frame', JSON.stringify(frames[0]));
    if (workerData.wide) {
      start = performance.now();
      const next = awaitFrame();
      bounds = { x: -5000, y: 1000, width: 10000, height: 5625 };
      for (const handler of events.get('animation') ?? []) handler();
      frames.push(await next);
      console.log('Panned mounted frame', JSON.stringify(frames[1]));
    }
    clearInterval(heartbeat);
    api.clearGLTerrain();
    parentPort.postMessage(workerData.wide ? { wide: true, maxUiGap, frames, timings: performance.getEntriesByType('measure').map(e => [e.name, e.duration]), renderer: gpu.renderer } :
      { cpu: true, refusedContexts, overview: frames[0] });
  } else {
  const frames = [];
  for (const scale of [1, 0.25, 1]) {
    console.log('Rendering', scale);
    const start = performance.now(), drawsBefore = gpu.draws;
    const image = await live.render({ x: workerData.x, y: workerData.y, width: 128 / scale, height: 128 / scale }, scale, new AbortController().signal);
    if (!workerData.worker && !live.view.terrain.builtFromPrebuilt) throw new Error('TerrainView discarded the worker-built host policy table');
    const rgba = image.getContext('2d').getImageData(0, 0, image.width, image.height).data;
    frames.push({ scale, draws: gpu.draws - drawsBefore, ms: performance.now() - start, hash: createHash('sha256').update(rgba).digest('hex'),
      colors: new Set(new Uint32Array(rgba.buffer)).size, visible: rgba.filter((v,i) => i % 4 === 3 && v).length });
  }
  let overview;
  if (workerData.seed === 92) {
    // URL z=1369 is OSD zoom 2^-13.69, i.e. this many world pixels across.
    const width = 2 ** (1369 / 100), scale = 1024 / width;
    const start = performance.now();
    const image = await live.render({ x: -3060 - width / 2, y: 3548 - width * 9 / 32,
      width, height: width * 9 / 16 }, scale, new AbortController().signal);
    const rgba = image.getContext('2d').getImageData(0, 0, image.width, image.height).data;
    overview = { ms: performance.now() - start, colors: new Set(new Uint32Array(rgba.buffer)).size,
      visible: rgba.filter((v,i) => i % 4 === 3 && v).length };
  }
  if (!workerData.worker) {
  const mine = generation.tileLayers.find(layer => layer.biomeName.startsWith('coalmine') && layer.validChunks?.size);
  const chunks = [...mine.validChunks], [cx, cy] = chunks[Math.floor(chunks.length / 2)].split(',').map(Number);
  const raw = live.view.render({ width: 128, height: 128, camX: cx * 512 + 192, camY: cy * 512 + 192,
    camZ: 1, detailZoom: Infinity, materialTextures: true, engineTerrain: true, scenes: false, edgeDecals: false });
  const cells = raw.canvas.getContext('2d').getImageData(0, 0, 128, 128).data;
  if (cells.filter((v,i) => i % 4 === 3 && v).length < 100) throw new Error('GPU terrain cells are blank beneath the host background');
  }
  parentPort.postMessage({ frames, overview, draws: gpu.draws, renderer: gpu.renderer });
  }
} catch (error) { parentPort.postMessage({ error: error.stack }); }
finally { clearInterval(heartbeat); clearInterval(progress); live?.dispose(); await new Promise(r => setTimeout(r, 20)); env.close(); gpu?.dispose(); }
