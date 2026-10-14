import { generateDynamicMap, initTelescope, prewarmParallelWorlds, releaseParallelWorlds } from '../src/telescope/telescope-adapter';
import { prewarmInstantTerrain, releaseInstantTerrainBackend } from '../src/telescope/instant-terrain-backend';
import { prewarmMapPresentation, prepareInstantTerrainResources, ensurePersistentBiomeBackgrounds, renderGenerationResult, clearDynamicOverlays } from '../src/telescope/telescope-osd-bridge';
import { clearInstantTerrain } from '../src/telescope/instant-terrain';
import { setFullPixelTerrainForBake } from '../src/renderer_settings';
import { setPortalGPUEnabled } from '../src/portals';

function events() {
  const handlers = new Map<string, Set<(event: any) => void>>();
  return {
    addHandler(name: string, fn: (event: any) => void) { if (!handlers.has(name)) handlers.set(name, new Set()); handlers.get(name)!.add(fn); },
    removeHandler(name: string, fn: (event: any) => void) { handlers.get(name)?.delete(fn); },
    raiseEvent(name: string, event: any = {}) { for (const fn of [...(handlers.get(name) ?? [])]) fn(event); },
  };
}

/** Fixed camera and ordered CanvasDrawer adapter. Uses real production direct
 * layers; excludes OSD's DOM, tile scheduling, CSS and browser presentation. */
function viewerFixture(width: number, height: number) {
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  const context = canvas.getContext('2d')!;
  const camera = { x: -235 - width * 1.5, y: 3581 - height * 1.5, width: width * 3, height: height * 3 };
  const bounds = { ...camera, getBoundingBox() { return this; } };
  const items: any[] = [], overlays: any[] = [];
  let drawQueued: ReturnType<typeof setTimeout> | undefined, closed = false;
  const viewport = {
    getBounds: () => bounds,
    getCenter: () => ({ x: camera.x + camera.width / 2, y: camera.y + camera.height / 2 }),
    getContainerSize: () => ({ x: width, y: height }), getRotation: () => 0, getFlip: () => false,
    deltaPixelsFromPointsNoRotate: (p: any) => ({ x: p.x / 3, y: p.y / 3 }),
    pixelFromPoint: (p: any) => ({ x: (p.x - camera.x) / 3, y: (p.y - camera.y) / 3 }),
    pointFromPixel: (p: any) => ({ x: camera.x + p.x * 3, y: camera.y + p.y * 3 }),
    getZoom: () => 1 / 3,
  };
  const drawer = { context, viewport, getType: () => 'canvas',
    _drawTiles(item: any) { throw new Error(`Profile cannot paint layer: ${JSON.stringify({
      keys: Object.keys(item.source), bounds: item.getBounds(), origin: item.imageToViewportCoordinates(0, 0),
      size: [item.source.width, item.source.height], direct: typeof item.source.__drawViewport,
    })}`); } };
  const world = { ...events(), getItemCount: () => items.length, getItemAt: (i: number) => items[i],
    removeItem(item: any) { const i = items.indexOf(item); if (i >= 0) { items.splice(i, 1); world.raiseEvent('remove-item', { item }); } },
    setItemIndex(item: any, index: number) { const i = items.indexOf(item); if (i >= 0) items.splice(i, 1); items.splice(index, 0, item); },
  };
  const viewer: any = { ...events(), world, viewport, drawer, canvas, container: document.createElement('div'),
    isAnimating: () => false,
    forceRedraw() { if (!closed && drawQueued === undefined) drawQueued = setTimeout(() => { drawQueued = undefined; draw(); }, 0); },
    addTiledImage(options: any) {
      if (!options.tileSource || typeof options.tileSource === 'string') throw new Error('Unexpected remote layer in native profile');
      const source = options.tileSource, scale = options.width / source.width;
      const item = { source, opacity: 1, compositeOperation: 'source-over', getFlip: () => false,
        setDrawn() {}, _updateLevelsForViewport() {},
        getBounds: () => ({ x: options.x, y: options.y, width: options.width, height: source.height * scale }),
        imageToViewportCoordinates: (x: number, y: number) => ({ x: options.x + x * scale, y: options.y + y * scale }),
        viewportToImageCoordinates: (x: number, y: number) => ({ x: (x - options.x) / scale, y: (y - options.y) / scale }),
      };
      items.splice(options.index ?? items.length, 0, item); world.raiseEvent('add-item', { item });
      options.success?.({ item }); viewer.forceRedraw();
    },
    addOverlay(options: any) { overlays.push(options); },
    removeOverlay(element: any) { const i = overlays.findIndex(o => o.element === element); if (i >= 0) overlays.splice(i, 1); },
  };
  function draw() {
    if (closed) return;
    context.clearRect(0, 0, width, height);
    for (const item of [...items]) drawer._drawTiles(item);
    for (const { element, location } of overlays) {
      if (!element.width || !element.height) continue;
      const p = viewport.pixelFromPoint(location);
      context.drawImage(element, p.x, p.y, location.width / 3, location.height / 3);
    }
  }
  return { viewer, draw, canvas, items,
    close() { closed = true; clearTimeout(drawQueued); viewer.raiseEvent('before-destroy'); },
  };
}

export async function profileMapPresentation(native: { importMs: number; fingerprint(value: unknown): string; seeds: number[];
  memory(): unknown; workerCount(): number; waitImages(): Promise<void>; progress(message: string): void }) {
  setFullPixelTerrainForBake(false); // Live HD route; the offline bake uses a different presenter.
  setPortalGPUEnabled(false); // Animated overlays have no fixed pixel identity.
  const display = viewerFixture(1280, 720), samples: any[] = [];
  try {
    for (const seed of native.seeds) {
      const started = performance.now();
      const phases: Array<{ name: string; start: number; end: number }> = [];
      (globalThis as any).__mapPresentationStages = phases;
      let resources: Promise<void> | undefined, firstPaintMs: number | undefined;
      // Same independent startup work as the live, non-baked map route.
      prewarmInstantTerrain(); prewarmParallelWorlds();
      const presentation = prewarmMapPresentation();
      const background = ensurePersistentBiomeBackgrounds(display.viewer);
      await initTelescope();
      const assetsMs = performance.now() - started, generationStarted = performance.now();
      const result = await generateDynamicMap({ seed, parallelWorlds: [-1, 0, 1], unlocks: null,
        onTerrainReady(terrain) {
          resources = prepareInstantTerrainResources(terrain); void resources.catch(() => {});
        } });
      const generationMs = performance.now() - generationStarted;
      await background;
      const presentationStarted = performance.now();
      await renderGenerationResult(display.viewer, result, null, false, () => { firstPaintMs = performance.now() - started; },
        undefined, null, false, false, false, started);
      await Promise.all([presentation, resources, native.waitImages()]);
      display.draw();
      const completeMs = performance.now() - started;
      if (firstPaintMs === undefined) throw new Error('No real first-paint notification');
      const terrain = display.items.find(i => i.source.__instantViewport)?.source;
      if (terrain?.instantStats?.backend !== 'main-gpu') throw new Error('Profile did not use the native direct GPU path');
      const pixels = display.canvas.getContext('2d')!.getImageData(0, 0, 1280, 720).data;
      let visible = 0; for (let i = 3; i < pixels.length; i += 4) if (pixels[i]) visible++;
      if (visible < 10000) throw new Error('Profile rendered a blank viewport');
      samples.push({ seed, assetsMs, generationMs, presentationMs: completeMs - (presentationStarted - started),
        firstPaintMs, completeMs, shaderMs: terrain.instantStats.shaderWarmupMs, resourceMs: terrain.instantStats.resourceMs,
        visible, pixelHash: native.fingerprint(pixels), memory: native.memory(), workers: native.workerCount(),
        phases: phases.map(p => ({ name: p.name, startMs: p.start - started, endMs: p.end - started, ms: p.end - p.start })),
        layers: display.items.map(i => ({ width: i.source.width, height: i.source.height, direct: typeof i.source.__drawViewport === 'function' })) });
      native.progress(`seed ${seed}: ${Math.round(firstPaintMs)}ms first paint, ${Math.round(completeMs)}ms presentation complete`);
    }
    return { importMs: native.importMs, samples,
      scope: 'Live generation, startup, actual native GLES terrain, original backgrounds, scene and marker direct layers. Fixed-camera CanvasDrawer adapter. Excludes browser/DOM/CDN/IndexedDB, animation and OSD scheduling; GPU readback is included by the native harness. Not all-nine cooking.' };
  } finally { display.close(); clearInstantTerrain(); clearDynamicOverlays(display.viewer); releaseInstantTerrainBackend(); releaseParallelWorlds(); }
}
