import { installFetchInterceptor } from './telescope-data-bridge';

// TerrainView needs canvas creation, but no browser document or UI. Install the
// worker environment before importing modules that load assets at top level.
if (typeof window === 'undefined') (globalThis as any).window = self;
if (typeof document === 'undefined') (globalThis as any).document = {
  createElement: (tag: string) => {
    if (tag === 'canvas') return new OffscreenCanvas(1, 1);
    return { style: {}, appendChild() {}, setAttribute() {}, remove() {} };
  },
  getElementById: () => null,
  body: { appendChild() {} },
};
installFetchInterceptor(true);

const port = self as unknown as DedicatedWorkerGlobalScope;
const jobs = new Map<number, AbortController>();
try {
  const [{ LiveTerrainView }, { LiveTerrainUnavailable }, terrain, atlas, utils, config, scenes] = await Promise.all([
    import('./live-terrain-view'), import('./live-terrain-error'),
    import('noita-telescope-full-pixels/gl/terrain_renderer.js'),
    import('noita-telescope-full-pixels/gl/material_atlas.js'),
    import('noita-telescope-full-pixels/utils.js'),
    import('noita-telescope-full-pixels/generator_config.js'),
    import('noita-telescope-full-pixels/pixel_scene_generation.js'),
  ]);
  // The adapter initialized this on the page. This worker has a separate module
  // instance; an empty table would silently omit every scene and its decals.
  await scenes.loadPixelSceneData();
  let renderer: InstanceType<typeof LiveTerrainView> | undefined;
  const deps = { GLTerrainRenderer: terrain.GLTerrainRenderer, initMaterialAtlas: atlas.initMaterialAtlas,
    getWorldSize: utils.getWorldSize, getWorldCenter: utils.getWorldCenter, GENERATOR_CONFIG: config.GENERATOR_CONFIG };
  self.onmessage = async ({ data }) => {
    if (data.type === 'cancel') { jobs.get(data.id)?.abort(); return; }
    try {
      if (data.type === 'init') { renderer = new LiveTerrainView(data.generation, deps); return; }
      if (data.type !== 'render') return;
      if (!renderer) throw new Error('Terrain renderer was not initialized');
      const controller = new AbortController(); jobs.set(data.id, controller);
      const send = (canvas: HTMLCanvasElement, done = false) => {
        if (controller.signal.aborted) return;
        const offscreen = canvas as unknown as OffscreenCanvas;
        if (typeof offscreen.transferToImageBitmap === 'function') {
          // Transferring clears the source. Keep the renderer's completed-frame
          // cache intact for exact zoom/pan revisits.
          const copy = new OffscreenCanvas(canvas.width, canvas.height);
          copy.getContext('2d')!.drawImage(canvas, 0, 0);
          const bitmap = copy.transferToImageBitmap();
          port.postMessage({ type: 'frame', id: data.id, done, width: bitmap.width, height: bitmap.height, bitmap }, [bitmap]);
        } else {
          // Native raster harness; browsers transfer the screen image above.
          const pixels = new Uint8ClampedArray(canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data);
          port.postMessage({ type: 'frame', id: data.id, done, width: canvas.width, height: canvas.height, pixels: pixels.buffer }, [pixels.buffer]);
        }
      };
      const frame = await renderer.render(data.bounds, data.scale, controller.signal, data.progressive ? send : undefined);
      send(frame, true);
    } catch (error) {
      if (!jobs.get(data.id)?.signal.aborted)
        port.postMessage({ type: data.type === 'init' ? 'fatal' : 'error', id: data.id, error: String(error), unavailable: error instanceof LiveTerrainUnavailable });
    } finally { jobs.delete(data.id); }
  };
  port.postMessage({ type: 'ready' });
} catch (error) { port.postMessage({ type: 'fatal', error: String(error) }); }
