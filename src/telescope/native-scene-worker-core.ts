import { encode } from 'fast-png';
import { renderNativeSceneBitmap } from './native-scene-bitmap';
import { createTerrainScenePainter, type ScenePainter, type TerrainScene, type TerrainSceneSource } from './terrain-scenes';
import type { TerrainTexture } from './terrain-backgrounds';

export interface NativeSceneRenderInput {
  scene: TerrainScene;
  source: TerrainSceneSource;
  worldSize: number;
  backdrop?: TerrainTexture;
}
export interface NativeSceneEncoded {
  png: Uint8Array<ArrayBuffer>;
  width: number;
  height: number;
}

/** Pure material composition and PNG encoding. The worker owns every large
 * intermediate; no canvas, GPU context or browser image decoder is needed. */
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
    const paint = await (painter ??= getPainter().catch(error => { painter = undefined; throw error; }));
    const pixels = renderNativeSceneBitmap(scene, source, paint, worldSize, backdrop);
    const png = encode({ data: pixels, width: scene.width, height: scene.height, channels: 4 }) as Uint8Array<ArrayBuffer>;
    return { png, width: scene.width, height: scene.height };
  };
}
