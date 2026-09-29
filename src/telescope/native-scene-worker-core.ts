import { encode } from 'fast-png';
import { renderNativeSceneBitmap } from './native-scene-bitmap';
import { createTerrainScenePainter, type ScenePainter, type TerrainScene, type TerrainSceneSource } from './terrain-scenes';
import type { TerrainTexture } from './terrain-backgrounds';

export interface NativeSceneRenderInput {
  scene: TerrainScene;
  source: TerrainSceneSource;
  worldSize: number;
  backdrop?: TerrainTexture;
  output?: 'pixels';
  /** Already composed live pixels, supplied only for deferred persistence. */
  pixels?: Uint8ClampedArray<ArrayBuffer>;
}
export interface NativeSceneEncoded {
  png?: Uint8Array<ArrayBuffer>;
  pixels?: Uint8ClampedArray<ArrayBuffer>;
  width: number;
  height: number;
}

/** Live composition returns pixels directly. PNG encoding is reserved for
 * persistence, after the visible scene pages have finished. */
export function createNativeSceneWorkerRenderer(getPainter: () => Promise<ScenePainter> = createTerrainScenePainter) {
  let painter: Promise<ScenePainter> | undefined;
  return async (input: NativeSceneRenderInput): Promise<NativeSceneEncoded> => {
    const { scene, source, worldSize, backdrop } = input;
    if (!Number.isSafeInteger(scene.width) || !Number.isSafeInteger(scene.height)
      || scene.width < 1 || scene.height < 1 || scene.width !== source.width || scene.height !== source.height
      || source.data.byteLength !== scene.width * scene.height * 4
      || ![scene.x, scene.y, worldSize].every(Number.isFinite) || worldSize <= 0)
      throw new Error('Invalid native scene input');
    for (const image of [source.visualArt, source.backgroundArt, backdrop]) if (image && (
      !Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height)
      || image.width < 1 || image.height < 1 || image.data.byteLength !== image.width * image.height * 4
    )) throw new Error('Invalid native scene artwork');
    if (input.pixels && input.pixels.byteLength !== scene.width * scene.height * 4)
      throw new Error('Invalid composed scene pixels');
    const pixels = input.pixels ?? renderNativeSceneBitmap(scene, source,
      await (painter ??= getPainter().catch(error => { painter = undefined; throw error; })), worldSize, backdrop);
    if (input.output === 'pixels') return { pixels, width: scene.width, height: scene.height };
    const png = encode({ data: pixels, width: scene.width, height: scene.height, channels: 4 }) as Uint8Array<ArrayBuffer>;
    return { png, width: scene.width, height: scene.height };
  };
}
