// Native GLES measurement, deliberately no browser and no hardware-FPS claim.
import fs from 'node:fs';
import { nativeSunGL } from '../tests/helpers/native-sun-gl.mjs';
import { SunRenderer, SUN_SIZE } from '../src/portals/suns/renderer.mjs';

const native = nativeSunGL(); globalThis.OffscreenCanvas = native.Canvas;
const bytes = fs.readFileSync(new URL('../src/portals/suns/effects.bin', import.meta.url));
const renderer = new SunRenderer(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), 618);
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
try {
  const start = performance.now();
  renderer.render('dark_sun', 261, 37764, 0, SUN_SIZE); native.gl.finish();
  const firstFrameMS = performance.now() - start;
  const samples = { lit: [], unlit: [] };
  for (let i = 0; i < 50; i++) {
    // Alternate order to reduce warm-up and clock-speed bias. Identical frozen
    // particles/glow isolate the lighting toggle from changes in scene content.
    for (const lighting of i % 2 ? [true, false] : [false, true]) {
      renderer.options.lighting = lighting;
      const begin = performance.now();
      renderer.render('dark_sun', 261, 37764, 0, SUN_SIZE); native.gl.finish();
      if (i >= 10) samples[lighting ? 'lit' : 'unlit'].push(performance.now() - begin);
    }
  }
  console.log(JSON.stringify({ renderer: native.renderer, pixels: SUN_SIZE ** 2, firstFrameMS,
    litMedianMS: median(samples.lit), unlitMedianMS: median(samples.unlit),
    ...renderer.stats(), note: 'Software GLES, frozen particles; isolates composition cost, not browser FPS.' }, null, 2));
} finally { renderer.dispose(); native.dispose(); }
