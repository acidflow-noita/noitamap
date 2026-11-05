// Run with: node --import tsx build_scripts/benchmark-liquid-refraction.mjs
// glFinish measures submitted work through completion, never just enqueue time.
// No browser is launched. Bitmap readback below is a native-fixture adapter,
// measured separately from the production snapshot's canvas-copy submission.
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createCanvas } from '@napi-rs/canvas';
import { LiquidRenderer } from '../src/liquids/renderer.mjs';
import { LiquidSnapshot } from '../src/liquids/snapshot.ts';
import { decodeLiquidMask } from '../src/liquids/mask-codec.ts';
import { LiquidMaskIndex } from '../src/liquids/mask-index.ts';
import { liquidFixture, nativeLiquidGL } from '../tests/helpers/liquid-refraction-native.mjs';

const native = nativeLiquidGL();
const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1)];
const measure = action => {
  const cpu = process.cpuUsage(), start = performance.now();
  if (action() !== true) throw new Error('Synchronized benchmark submission was refused');
  const submitMS = performance.now() - start;
  native.gl.finish();
  const completeMS = performance.now() - start, used = process.cpuUsage(cpu);
  return { submitMS, completeMS, processCpuMS: (used.user + used.system) / 1000 };
};
const summarize = values => ({ medianMS: percentile(values, 0.5), p95MS: percentile(values, 0.95) });
const maskStart = performance.now();
const maskBytes = gunzipSync(readFileSync(new URL('../src/liquids/assets/static-mask.bin.gz', import.meta.url)));
const index = new LiquidMaskIndex(decodeLiquidMask(maskBytes));
const basin = { x: 585, y: 1009, width: 367, height: 95 }, basinPixels = new Uint8Array(367 * 95);
index.paint(basinPixels, basin);
const staticMaskSetupMS = performance.now() - maskStart;
const cases = [
  { name: 'Captured Holy Mountain oil basin, 2x zoom', width: 734, height: 190,
    options: { screenToWorld: [.5, 0, 0, .5, basin.x, basin.y], maskX: basin.x, maskY: basin.y,
      maskWidth: basin.width, maskHeight: basin.height,
      maskAt: (x, y) => basinPixels[(y - basin.y) * basin.width + x - basin.x] ?? 0 } },
  { name: 'Medium full-liquid view', width: 1024, height: 768 },
  { name: '1080p full-liquid view', width: 1920, height: 1080 },
  { name: '1080p sparse liquid across the full view', width: 1920, height: 1080,
    options: { maskAt: (x, y) => x % 100 < 20 && y % 100 < 50 ? 255 : 0 } },
  { name: '4K high-DPI view, bounded output', width: 2048, height: 1152, reduced: true,
    physicalWidth: 7680, physicalHeight: 4320,
    options: { screenToWorld: [.5, 0, 0, .5, 0, 0], maskWidth: 1024, maskHeight: 576 } },
  { name: 'Maximum permitted output, full liquid', width: 2048, height: 2048, reduced: true,
    physicalWidth: 4096, physicalHeight: 4096,
    options: { screenToWorld: [.5, 0, 0, .5, 0, 0], maskWidth: 1024, maskHeight: 1024 } },
];
const results = [];
try {
  for (const scenario of cases) {
    const { width, height, reduced = false, physicalWidth = width, physicalHeight = height } = scenario;
    const source = { ...liquidFixture(width, height, scenario.options), reduced };
    const init = performance.now(), renderer = new LiquidRenderer(new native.Canvas());
    const initializeMS = performance.now() - init;
    try {
      const firstUpload = measure(() => renderer.setSource(source));
      const uploads = [];
      for (let i = 0; i < 8; i++) uploads.push(measure(() => renderer.setSource(source)));
      for (let i = 0; i < 10; i++) measure(() => renderer.render(i / 30));
      const before = native.counts(), frames = [];
      for (let i = 0; i < 90; i++) frames.push(measure(() => renderer.render((i + 10) / 30)));
      const after = native.counts();
      if (after.uploads !== before.uploads || after.allocations !== before.allocations)
        throw new Error('Steady-state rendering uploaded or allocated texture data');
      if (after.draws - before.draws !== frames.length || after.maxLiveSyncs !== 1)
        throw new Error('Benchmark lost submitted frames or exceeded the GPU fence bound');
      // Exercise the actual capture class, with native canvas as the map raster.
      // The raster is prepainted outside timing. No browser ImageBitmap API is
      // claimed: the adapter explicitly copies pixels to the native GL upload.
      const map = createCanvas(physicalWidth, physicalHeight), paint = map.getContext('2d');
      const texture = createCanvas(32, 32), patternContext = texture.getContext('2d');
      patternContext.fillStyle = '#185785'; patternContext.fillRect(0, 0, 32, 32);
      patternContext.fillStyle = '#23405e'; patternContext.fillRect(5, 7, 11, 16);
      paint.fillStyle = paint.createPattern(texture, 'repeat'); paint.fillRect(0, 0, physicalWidth, physicalHeight);
      let copyMS = 0, bitmapReadbackMS = 0;
      const snapshot = new LiquidSnapshot(() => {
        const canvas = createCanvas(1, 1), context = canvas.getContext('2d'), draw = context.drawImage.bind(context);
        context.drawImage = (...args) => { const start = performance.now(); draw(...args); copyMS = performance.now() - start; };
        return canvas;
      }, async canvas => {
        const start = performance.now();
        const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        bitmapReadbackMS = performance.now() - start;
        return { width: canvas.width, height: canvas.height, data, close() {} };
      });
      const copies = [], readbacks = [], captureUploads = [], preparation = [];
      try {
        for (let i = 0; i < 9; i++) {
          const start = performance.now();
          const bitmap = await snapshot.capture(map, 0, 0, physicalWidth, physicalHeight, width, height);
          const upload = measure(() => renderer.setSource({ ...source, color: bitmap }));
          bitmap.close();
          if (i) { copies.push(copyMS); readbacks.push(bitmapReadbackMS); captureUploads.push(upload.completeMS); preparation.push(performance.now() - start); }
        }
      } finally { snapshot.destroy(); map.width = map.height = texture.width = texture.height = 1; }
      results.push({ name: scenario.name, width, height, physicalWidth, physicalHeight, reduced,
        pixels: width * height, maskPixels: source.mask.length,
        liquidCoverage: source.mask.reduce((n, value) => n + Number(!!value), 0) / source.mask.length,
        initializeMS, firstUpload, reusedTextureUpload: summarize(uploads.map(n => n.completeMS)),
        render: summarize(frames.map(n => n.completeMS)), submit: summarize(frames.map(n => n.submitMS)),
        processCpu: summarize(frames.map(n => n.processCpuMS)), renderSamples: frames.length,
        snapshotCopySubmission: summarize(copies), nativeBitmapReadback: summarize(readbacks),
        snapshotUpload: summarize(captureUploads), combinedNativePreparation: summarize(preparation),
        perFrameTextureUploads: 0, perFrameTextureAllocations: 0,
        syncObjectsCreatedPerFrame: (after.syncsCreated - before.syncsCreated) / frames.length,
        maximumOutstandingSyncs: after.maxLiveSyncs,
        textureBytes: renderer.stats().textureBytes, estimatedGPUBytes: renderer.stats().estimatedGPUBytes,
        scratchBytes: width * height * 4 });
      console.error(`[Liquid benchmark] ${scenario.name}: median ${results.at(-1).render.medianMS.toFixed(2)} ms, p95 ${results.at(-1).render.p95MS.toFixed(2)} ms`);
    } finally { renderer.dispose(); }
    const resources = native.counts();
    if (resources.liveTextures || resources.livePrograms || resources.liveSyncs || resources.liveVertexArrays)
      throw new Error('Renderer resources survived teardown');
  }
  console.log(JSON.stringify({ measuredAt: new Date().toISOString(), renderer: native.renderer,
    note: 'Native GLES with glFinish and frozen inputs, not browser FPS. Only the first scenario uses captured material geometry; colors are a synthetic opaque pattern. Process CPU includes driver threads and can exceed elapsed time. Native canvas can defer copy execution until bitmap readback; copy submission alone is not its completed cost. Combined native preparation includes copy, native bitmap readback and upload, and is not a browser ImageBitmap measurement. Memory is tracked texture storage plus estimated double-buffered presentation and a separate scratch surface, not total driver/process memory. No bitmap/canvas copy or uploads occur during steady animation.',
    staticMaskSetupMS, staticMaskDecodedBytes: maskBytes.length, results }, null, 2));
} finally { native.dispose(); }
