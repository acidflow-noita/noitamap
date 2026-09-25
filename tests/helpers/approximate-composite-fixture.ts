import { generateFixture as generateSeed } from './generate-worker-fixture';
import { ApproximateCompositeReuse } from '../../src/telescope/approximate-composite-reuse';
import { rgbaToPngBlob, decodePngToRgba } from '../../src/telescope/png-decode';
import { STATIC_TERRAIN_BIOMES } from '../../src/telescope/terrain-policy';

/** Actual shipped Wang inputs, native Skia canvases and the production PNG
 * encoder. No browser, synthetic pixels, network, or performance assertion. */
export async function generateFixture(_fullPixels: boolean, seed: number) {
  const generated = await generateSeed(false, seed, true);
  // @ts-ignore — Telescope exports JavaScript.
  const { createTileOverlaysCheap } = await import('noita-telescope/image_processing.js');
  const layers = generated.tileLayers!;
  const worldWidth = 70 * 512;
  const worlds = [0, 1, -1];
  const planes = [0, -1, 1];
  const references = new Map<number, { data: Uint8ClampedArray; width: number; height: number; minX: number; minY: number; osdWidth: number }>();

  const run = async (shared: boolean) => {
    const cache = new ApproximateCompositeReuse(worldWidth, shared);
    let renderMs = 0, encodeMs = 0, readPixelsMs = 0, renders = 0, encodes = 0;
    let encodedBytes = 0, comparedPixels = 0, firstCompositeMs = 0;
    const started = performance.now();
    for (const pw of worlds) for (const plane of planes) {
      let composite = cache.get(pw, plane);
      if (!composite) {
        let start = performance.now();
        const overlays = createTileOverlaysCheap(generated.biomeData, layers, pw, plane, false, 'normal');
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        const valid: { overlay: OffscreenCanvas; x: number; y: number }[] = [];
        for (let i = 0; i < layers.length; i++) {
          const layer = layers[i], overlay = overlays[i];
          if (!overlay || STATIC_TERRAIN_BIOMES.has(layer.biomeName)) continue;
          const x = -worldWidth / 2 + pw * worldWidth + layer.correctedX;
          const y = -14 * 512 + layer.correctedY + plane * 24576;
          minX = Math.min(minX, x); minY = Math.min(minY, y);
          maxX = Math.max(maxX, x + overlay.width * 10); maxY = Math.max(maxY, y + overlay.height * 10);
          valid.push({ overlay, x, y });
        }
        const width = Math.ceil((maxX - minX) / 10), height = Math.ceil((maxY - minY) / 10);
        const canvas = new OffscreenCanvas(width, height), context = canvas.getContext('2d')!;
        for (const { overlay, x, y } of valid) context.drawImage(overlay, Math.round((x - minX) / 10), Math.round((y - minY) / 10));
        renderMs += performance.now() - start; renders++;
        start = performance.now();
        const pixels = context.getImageData(0, 0, width, height).data;
        readPixelsMs += performance.now() - start;
        start = performance.now();
        const blob = await rgbaToPngBlob(pixels, width, height);
        encodeMs += performance.now() - start; encodes++; encodedBytes += blob.size;
        composite = { blob, minX, minY, osdWidth: width * 10 };
        cache.remember(pw, plane, composite);
        if (!firstCompositeMs) firstCompositeMs = performance.now() - started;
      }
      const decoded = decodePngToRgba(await composite.blob.arrayBuffer());
      const existing = references.get(plane);
      if (!existing) references.set(plane, { ...decoded, ...composite, minX: composite.minX - pw * worldWidth });
      else {
        if (decoded.width !== existing.width || decoded.height !== existing.height ||
          composite.minX !== existing.minX + pw * worldWidth || composite.minY !== existing.minY || composite.osdWidth !== existing.osdWidth)
          throw new Error(`Composite geometry changed: ${seed}/${pw}/${plane}`);
        for (let i = 0; i < decoded.data.length; i++) {
          if (decoded.data[i] !== existing.data[i]) throw new Error(`Decoded pixel mismatch: ${seed}/${pw}/${plane} byte ${i}`);
        }
        comparedPixels += decoded.width * decoded.height;
      }
    }
    return { renderMs, readPixelsMs, encodeMs, computeMs: renderMs + readPixelsMs + encodeMs, firstCompositeMs,
      renders, encodes, encodedBytes, comparedPixels };
  };
  // Alternating order across seeds reduces one-sided warmup advantage.
  if (seed % 2) {
    const shared = await run(true), reference = await run(false);
    return { seed, reference, shared };
  }
  const reference = await run(false), shared = await run(true);
  return { seed, reference, shared };
}
