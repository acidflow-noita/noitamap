import { createPlaneOwnership } from '../../src/telescope/terrain-policy';
import { prepareTerrainPlane } from '../../src/telescope/terrain-planes';
import { createTerrainViewportCompositor, type TerrainViewportPlan } from '../../src/telescope/terrain-viewport-compositor';
import { createRetainedViewportRenderer } from '../../src/telescope/retained-viewport-renderer';
import { RetainedTerrain } from '../../src/telescope/retained-terrain';

/** Actual shader pixels, native cooking, mip reduction and a new close camera.
 * This catches screen-sized overview pixels becoming permanent native detail
 * after mobile-sized retention eviction, including the square alpha edges. */
export async function verifyTempleZoomRetention(generation: any, resources: any, config: any) {
  const owners = await Promise.all(([-1, 0, 1] as const).map(async plane => {
    const data = await prepareTerrainPlane(generation, plane);
    return createPlaneOwnership(data.tileLayers, generation.biomeData.pixels,
      data.biomeData.pixels, config, 70);
  }));
  const compositor = createTerrainViewportCompositor({ owners, masks: [], center: 35 });
  const samples = [];
  try {
    for (const biome of ['biome_potion_mimics', 'biome_darkness']) {
      const layer = generation.tileLayers.find((layer: any) => layer.biomeName === biome);
      if (!layer?.buffer) throw new Error(`Missing island geometry: ${biome}`);
      for (const plane of [-1, 1]) {
        const x = layer.minX * 512 - 17920, y = layer.minY * 512 - 7168 + plane * 24576;
        const lifetime = new AbortController();
        let delayStorage = false;
        const pendingReads: Array<() => void> = [];
        const retained = new RetainedTerrain({
          async read() {
            if (delayStorage) await new Promise<void>(resolve => pendingReads.push(resolve));
            return undefined;
          },
          async write() {},
        }, 1024 * 1024);
        try {
          const region = { x, y, width: 2048, height: 2048 };
          const retention = retained.region(`${biome}/${plane}`, region.width, region.height);
          const plan = (dx: number, dy: number, width: number, height: number, scale: number): TerrainViewportPlan => ({
            x: x + dx, y: y + dy, width, height, scale,
            pixelWidth: width / scale, pixelHeight: height / scale,
          });
          const native = compositor.render(resources, plan(0, 0, 512, 512, 1)).getContext('2d')!;
          await retention.record(0, 0, native);
          const display = createRetainedViewportRenderer({
            regions: [{ region, retention }], signal: lifetime.signal,
            complete: () => false, refresh() {},
            renderer: { async renderViewport(view) {
              return createImageBitmap(compositor.render(resources, view));
            } },
          });
          const overview = await display.render(plan(-64, -64, 1792, 1792, 4), lifetime.signal) as HTMLCanvasElement;
          overview.width = overview.height = 0;
          await retained.flush();
          const pressure = document.createElement('canvas'); pressure.width = 512; pressure.height = 513;
          const page = retained.install('pressure', pressure.getContext('2d')!, new Uint8Array([1]), 1, 1, false);
          retained.release(page);
          if (retained.stats.pages) throw new Error('Native island pages were not evicted');
          delayStorage = true;
          const close = plan(16, 16, 512, 512, 1);
          const canvas = await display.render(close, lifetime.signal) as HTMLCanvasElement;
          const actual = canvas.getContext('2d')!.getImageData(0, 0, 512, 512).data;
          const reference = compositor.render(resources, close).getContext('2d')!.getImageData(0, 0, 512, 512).data;
          let mismatchedBytes = 0;
          for (let i = 0; i < reference.length; i++) if (actual[i] !== reference[i]) mismatchedBytes++;
          let edgeMismatchedBytes = 0, edgeComparedPixels = 0;
          for (const [frame, scale] of [.61, 1.37, 3.19, 4.71].entries()) {
            const edge = { x: x - 29.19 + frame * .17, y: y - 31.37 + frame * .23,
              width: 128 * scale, height: 128 * scale, scale, pixelWidth: 128, pixelHeight: 128 };
            resources.setPlane(plane);
            const image = resources.render({ ...edge, width: 128, height: 128,
              camX: edge.x + 64 * scale + 17920, camY: edge.y + 64 * scale + 7168,
              camZ: 1 / scale, pw: 0, pwVertical: 0,
              edgeNoise: true, materialTextures: true, engineTerrain: true });
            const expected = new Uint8ClampedArray(image.__nativeGlesPixels);
            for (let py = 0; py < 128; py++) for (let px = 0; px < 128; px++) {
              const wx = edge.x + (px + .5) * scale;
              const wy = edge.y + (py + .5) * scale - plane * 24576;
              if (owners[plane + 1].at(wx, wy) >= 0) continue;
              expected.fill(0, (py * 128 + px) * 4, (py * 128 + px + 1) * 4);
            }
            const output = compositor.render(resources, edge).getContext('2d')!
              .getImageData(0, 0, 128, 128).data;
            for (let i = 0; i < expected.length; i++) if (output[i] !== expected[i]) edgeMismatchedBytes++;
            edgeComparedPixels += 128 * 128;
          }
          samples.push({ biome, plane, comparedPixels: 512 * 512, mismatchedBytes,
            edgeComparedPixels, edgeMismatchedBytes });
          canvas.width = canvas.height = 0;
        } finally {
          lifetime.abort();
          for (const finish of pendingReads) finish();
          retained.dispose();
        }
      }
    }
  } finally { compositor.dispose(); }
  return samples;
}
