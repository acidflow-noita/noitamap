import { installTelescopeShim } from './telescope-dom-shim';
import { installFetchInterceptor } from './telescope-data-bridge';
import { createNativeSceneWorkerRenderer, type NativeSceneRenderInput } from './native-scene-worker-core';

// CPU-only material painting must also work where OffscreenCanvas/WebGL are
// unavailable. Shared full-pixel assets use the existing immutable fetch path.
if (typeof window === 'undefined') (globalThis as any).window = self;
if (typeof document === 'undefined') (globalThis as any).document = {
  createElement: () => ({ style: {}, appendChild() {}, setAttribute() {}, remove() {} }),
  getElementById: () => null,
  body: { appendChild() {} },
};
installTelescopeShim({ clearSpawnPixels: true, recolorMaterials: true });
installFetchInterceptor(true);
const render = createNativeSceneWorkerRenderer(async () => {
  const { updateSettings } = await import('noita-telescope-full-pixels/settings.js');
  updateSettings({ clearSpawnPixels: true, recolorMaterials: true, enableEdgeNoise: true,
    fixHolyMountainEdgeNoise: true, enableStaticPixelScenes: 'all', skipCosmeticScenes: false });
  const { createTerrainScenePainter } = await import('./terrain-scenes');
  return createTerrainScenePainter();
});
let queue = Promise.resolve();
self.onmessage = ({ data }: MessageEvent<{ id: number; input: NativeSceneRenderInput }>) => {
  const work = queue.then(async () => {
    try {
      const result = await render(data.input);
      self.postMessage({ id: data.id, ...result }, { transfer: [result.png.buffer] });
    } catch (error) {
      self.postMessage({ id: data.id, error: error instanceof Error ? error.message : String(error) });
    }
  });
  queue = work.catch(() => {});
};
