import { createPlaneOwnership } from '../../src/telescope/terrain-policy';
import { createTerrainViewportCompositor } from '../../src/telescope/terrain-viewport-compositor';

/** The scene PNG is mostly transparent: its real biome's EDR must survive
 * viewport ownership clipping underneath it. Compare to upstream shader
 * output, not a synthetic colored canvas, across all three parallel worlds. */
export function verifyAuthoredRoomFills(generation: any, resources: any, config: any) {
  const pixels: Uint32Array = generation.biomeData.pixels;
  const main = createPlaneOwnership(generation.tileLayers, pixels, pixels, config, 70);
  const empty = { width: 70, owners: new Int16Array(70 * 48).fill(-1) };
  const compositor = createTerrainViewportCompositor({ owners: [empty, main, empty], masks: [], center: 35 });
  const samples = [];
  try {
    for (const biome of ['solid_wall_hidden_cavern', ...Array.from({ length: 6 }, (_, i) => `friend_${i + 1}`)]) {
      const cell = pixels.findIndex(color => (color & 0xffffff) === (config[biome].color & 0xffffff));
      if (cell < 0) throw new Error(`Missing real room biome cell: ${biome}`);
      for (const pw of [-1, 0, 1]) {
        const x = (cell % 70) * 512 - 17920 + 128 + pw * 35840;
        const y = Math.floor(cell / 70) * 512 - 7168 + 128;
        resources.setPlane(0);
        const image = resources.render({ x, y, width: 64, height: 64, scale: 1,
          camX: x + 32 + 17920, camY: y + 32 + 7168, camZ: 1,
          pw: 0, pwVertical: 0, edgeNoise: true, materialTextures: true, engineTerrain: true });
        const reference = new Uint8ClampedArray(image.__nativeGlesPixels);
        const actual = compositor.render(resources, { x, y, width: 64, height: 64, scale: 1,
          pixelWidth: 64, pixelHeight: 64 }).getContext('2d')!.getImageData(0, 0, 64, 64).data;
        let mismatchedBytes = 0, nonAir = 0;
        for (let i = 0; i < reference.length; i++) if (actual[i] !== reference[i]) mismatchedBytes++;
        for (let i = 3; i < reference.length; i += 4) if (reference[i]) nonAir++;
        let edgeMismatchedBytes = 0, edgeComparedPixels = 0;
        // Animated cameras intersect the actual fill cell's top/left and
        // bottom/right boundaries at fractional display positions. The oracle
        // is an unmodified GPU frame masked independently by world pixel
        // centers, never Canvas's antialiased rectangular clipping.
        for (const [frame, scale] of [.61, 1.37, 3.19, 4.71].entries()) {
          const edgeX = x - 128 - 29.19 + frame * .17;
          const edgeY = y - 128 - 31.37 + frame * .23;
          resources.setPlane(0);
          const edgeImage = resources.render({ x: edgeX, y: edgeY, width: 128, height: 128, scale,
            camX: edgeX + 64 * scale + 17920, camY: edgeY + 64 * scale + 7168, camZ: 1 / scale,
            pw: 0, pwVertical: 0, edgeNoise: true, materialTextures: true, engineTerrain: true });
          const expected = new Uint8ClampedArray(edgeImage.__nativeGlesPixels);
          for (let py = 0; py < 128; py++) for (let px = 0; px < 128; px++) {
            if (main.at(edgeX + (px + .5) * scale, edgeY + (py + .5) * scale) >= 0) continue;
            expected.fill(0, (py * 128 + px) * 4, (py * 128 + px + 1) * 4);
          }
          const output = compositor.render(resources, { x: edgeX, y: edgeY, width: 128 * scale,
            height: 128 * scale, scale, pixelWidth: 128, pixelHeight: 128 })
            .getContext('2d')!.getImageData(0, 0, 128, 128).data;
          for (let i = 0; i < expected.length; i++) if (output[i] !== expected[i]) edgeMismatchedBytes++;
          edgeComparedPixels += 128 * 128;
        }
        samples.push({ biome, pw, x, y, comparedPixels: 64 * 64, nonAir, mismatchedBytes,
          edgeComparedPixels, edgeMismatchedBytes });
      }
    }
  } finally { compositor.dispose(); }
  return samples;
}
