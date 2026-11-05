// Frozen-input native GLES measurements. glFinish isolates actual GPU work;
// Mesa software timings are not a claim about browser FPS or hardware GPUs.
import { LiquidRenderer } from '../src/liquids/renderer.mjs';
import { liquidFixture, nativeLiquidGL } from '../tests/helpers/liquid-refraction-native.mjs';

const native = nativeLiquidGL();
const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1)];
const measure = action => {
  const start = performance.now();
  if (action() !== true) throw new Error('Synchronized benchmark submission was refused');
  native.gl.finish(); return performance.now() - start;
};
const results = [];
try {
  for (const [width, height] of [[256, 256], [1024, 768], [1920, 1080]]) {
    // Full liquid coverage measures the expensive path at realistic patch
    // sizes. Fixture generation and shader compilation are outside frame time.
    const source = liquidFixture(width, height);
    const init = performance.now(), renderer = new LiquidRenderer(new native.Canvas());
    const initializeMS = performance.now() - init;
    try {
      const firstUploadMS = measure(() => renderer.setSource(source));
      const uploads = [];
      for (let i = 0; i < 8; i++) uploads.push(measure(() => renderer.setSource(source)));
      for (let i = 0; i < 10; i++) measure(() => renderer.render(i / 60));
      const before = native.counts(), frames = [];
      for (let i = 0; i < 60; i++) frames.push(measure(() => renderer.render((i + 10) / 60)));
      const after = native.counts();
      if (after.uploads !== before.uploads || after.allocations !== before.allocations)
        throw new Error('Steady-state rendering uploaded or allocated texture data');
      if (after.draws - before.draws !== frames.length || after.maxLiveSyncs !== 1)
        throw new Error('Benchmark lost submitted frames or exceeded the GPU fence bound');
      results.push({ width, height, pixels: width * height, maskPixels: source.mask.length,
        liquidCoverage: 1, initializeMS, firstUploadMS,
        reusedTextureUploadMedianMS: percentile(uploads, 0.5), reusedTextureUploadP95MS: percentile(uploads, 0.95),
        renderMedianMS: percentile(frames, 0.5), renderP95MS: percentile(frames, 0.95), renderSamples: frames.length,
        perFrameTextureUploads: 0, perFrameTextureAllocations: 0,
        syncObjectsCreatedPerFrame: (after.syncsCreated - before.syncsCreated) / frames.length,
        maximumOutstandingSyncs: after.maxLiveSyncs,
        textureBytes: renderer.stats().textureBytes, estimatedGPUBytes: renderer.stats().estimatedGPUBytes });
    } finally { renderer.dispose(); }
  }
  console.log(JSON.stringify({ renderer: native.renderer,
    note: 'Software GLES with glFinish and frozen inputs; upload and rendering measured separately, not browser FPS. Zero reallocations refers to textures/buffers; one transient GPU sync is created per submitted frame.', results }, null, 2));
} finally { native.dispose(); }
