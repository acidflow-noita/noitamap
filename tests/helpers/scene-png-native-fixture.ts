import {
  generateDynamicMap,
  releaseParallelWorlds,
} from "../../src/telescope/telescope-adapter";
import { setFullPixelTerrainForBake } from "../../src/renderer_settings";
import {
  ScenePngEncodingQueue,
  finishSceneBitmap,
} from "../../src/telescope/scene-png-queue";
import { decodePngToRgba } from "../../src/telescope/png-decode";
import * as bridge from "../../src/telescope/telescope-osd-bridge";

const pixels = (bitmap: ImageBitmap) =>
  new Uint8ClampedArray(
    (bitmap as any)
      .getContext("2d")
      .getImageData(0, 0, bitmap.width, bitmap.height).data,
  );
const difference = (
  a: Uint8Array | Uint8ClampedArray,
  b: Uint8Array | Uint8ClampedArray,
) => {
  if (a.length !== b.length) throw new Error("Scene pixel dimensions changed");
  let count = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) count++;
  return count;
};

export async function run() {
  setFullPixelTerrainForBake(true);
  const queue = new ScenePngEncodingQueue(),
    batch = queue.batch();
  const samples: any[] = [];
  const deferred = async (
    name: string,
    reference: { bitmap: ImageBitmap; blob: Blob },
    build: (defer: (canvas: OffscreenCanvas) => void) => Promise<any>,
  ) => {
    let save!: (blob: Blob) => void;
    const released = { width: [] as number[], height: [] as number[] };
    const persisted = new Promise<Blob>((resolve) => {
      save = resolve;
    });
    const actual = await build((canvas) => {
      // Native Canvas maps zero dimensions to its default size. Observe the
      // release writes while encoding the original canvas; browser zero
      // dimensions are exercised by the queue's ownership tests.
      const owned = {
        get width() {
          return canvas.width;
        },
        set width(value: number) {
          released.width.push(value);
          canvas.width = value;
        },
        get height() {
          return canvas.height;
        },
        set height(value: number) {
          released.height.push(value);
          canvas.height = value;
        },
        convertToBlob: (options: ImageEncodeOptions) =>
          canvas.convertToBlob(options),
      };
      if (!batch.enqueue(owned, (blob) => save(blob)))
        throw new Error("Native parity scene exceeded queue budget");
    });
    if (actual.blob !== null)
      throw new Error("Deferred compositor returned an eagerly encoded PNG");
    const before = pixels(reference.bitmap),
      after = pixels(actual.bitmap);
    const displayDifferences = difference(before, after);
    batch.afterPaint();
    const blob = await persisted;
    const oldPNG = decodePngToRgba(await reference.blob.arrayBuffer()),
      newPNG = decodePngToRgba(await blob.arrayBuffer());
    const persistedDifferences = difference(oldPNG.data, newPNG.data);
    await new Promise((resolve) => setTimeout(resolve, 0));
    samples.push({
      name,
      bytes: before.byteLength,
      displayDifferences,
      persistedDifferences,
      sourceReleased:
        released.width.length === 1 &&
        released.width[0] === 0 &&
        released.height.length === 1 &&
        released.height[0] === 0,
      remaining: queue.stats,
    });
    reference.bitmap.close();
    actual.bitmap.close();
  };
  try {
    // Independent reference: the exact old finishing sequence, including PNG
    // encoding from the original canvas rather than from its display snapshot.
    const canvas = () => {
      const source = new OffscreenCanvas(37, 29),
        context = source.getContext("2d")!;
      const image = context.createImageData(37, 29);
      for (let i = 0; i < image.data.length; i += 4)
        image.data.set(
          [
            (i * 13) & 255,
            (i * 23 + 17) & 255,
            (i * 37 + 31) & 255,
            [0, 1, 17, 127, 128, 254, 255][(i / 4) % 7],
          ],
          i,
        );
      context.putImageData(image, 0, 0);
      return source;
    };
    const original = canvas();
    const reference = {
      bitmap: await createImageBitmap(original),
      blob: await original.convertToBlob({ type: "image/png" }),
    };
    original.width = original.height = 0;
    await deferred("alpha-and-color-reference", reference, (defer) =>
      finishSceneBitmap(canvas(), defer),
    );

    const gen = await generateDynamicMap({
      seed: 11033,
      parallelWorlds: [-1, 0, 1],
      unlocks: null,
    });
    const { scenes, index } = await (bridge as any).__encodingSceneInputs(gen);
    const composite = (bridge as any).__encodingComposite;
    const wanted = [
      "coalmine/oiltank_4",
      "snowcastle/bedroom",
      "vault/lab_puzzle",
      "general/cavern",
      "general/watercave_layout_",
      "noitamap/captured-gold-room-v1",
    ];
    for (const key of wanted) {
      const scene = scenes.find(
        (value: any) =>
          value.key === key || (key.endsWith("_") && value.key.startsWith(key)),
      );
      if (!scene) throw new Error("Native scene missing: " + key);
      const reference = await composite(scene.key, scene, index, gen.seed);
      if (!reference?.blob)
        throw new Error("Inline scene did not encode: " + key);
      await deferred(scene.key, reference, (defer) =>
        composite(scene.key, scene, index, gen.seed, defer),
      );
    }
    return {
      samples,
      queue: queue.stats,
      diagnosticsScope:
        "Native Canvas pixels and PNG bytes decoded independently; no browser/GPU or presentation timing claim.",
    };
  } finally {
    batch.cancel();
    releaseParallelWorlds();
  }
}
