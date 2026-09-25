import { setFullPixelTerrainForBake } from '../../src/renderer_settings';
import { generateDynamicMap } from '../../src/telescope/telescope-adapter';
import { addInstantTerrain, clearInstantTerrain, INSTANT_TILE_SIZE } from '../../src/telescope/instant-terrain';
import { createTerrainOwnership, WORLD_TOP, WORLD_HEIGHT } from '../../src/telescope/terrain-policy';
import type { StaticTerrainMask } from '../../src/telescope/static-terrain-mask';

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

export async function verifyInstantTerrainRuntime(native: { draws(): number }) {
  setFullPixelTerrainForBake(true);
  const generated = await generateDynamicMap({ seed: 42, ngPlus: 0, parallelWorlds: [0], unlocks: null });
  const gen = { ...generated, parallelWorlds: [0, -1, 1] };
  const [{ GLTerrainRenderer }, { initMaterialAtlas }, { GENERATOR_CONFIG }, { getWorldSize, getWorldCenter }] = await Promise.all([
    import('noita-telescope-full-pixels/gl/terrain_renderer.js'),
    import('noita-telescope-full-pixels/gl/material_atlas.js'),
    import('noita-telescope-full-pixels/generator_config.js'),
    import('noita-telescope-full-pixels/utils.js'),
  ]);
  let uploads = 0, invalidations = 0;
  const renders: { renderer: any; view: any }[] = [];
  const deps = {
    GLTerrainRenderer: class extends GLTerrainRenderer {
      ensureResources(...args: any[]) { uploads++; return super.ensureResources(...args); }
      render(view: any) { renders.push({ renderer: this, view }); return super.render(view); }
      invalidate() { invalidations++; return super.invalidate(); }
    },
    initMaterialAtlas, GENERATOR_CONFIG, getWorldSize, getWorldCenter,
  };
  (globalThis as any).OpenSeadragon = { TileSource: class { constructor(options: any) { Object.assign(this, options); } } };
  const handlers = new Map<string, Set<(event: any) => void>>();
  const items: any[] = [];
  const viewer = {
    world: { removeItem(item: any) { const i = items.indexOf(item); if (i >= 0) items.splice(i, 1); } },
    viewport: { getCenter: () => ({ x: 0, y: 512 }) },
    addHandler(name: string, handler: (event: any) => void) { if (!handlers.has(name)) handlers.set(name, new Set()); handlers.get(name)!.add(handler); },
    removeHandler(name: string, handler: (event: any) => void) { handlers.get(name)?.delete(handler); },
    addTiledImage(options: any) {
      const item = { source: options.tileSource, region: options.tileSource.instantRegion ?? { x: options.x, y: options.y, width: options.width, height: options.tileSource.height, pw: Math.round((options.x + 17920) / 35840) } };
      items.push(item); options.success({ item });
    },
  };
  let paints = 0, failures = 0;
  const owners = createTerrainOwnership(gen.tileLayers, gen.biomeData.pixels, GENERATOR_CONFIG, 70);
  const layer = gen.tileLayers.find((entry: any) => entry.biomeName === 'coalmine' && entry.validChunks?.size) as any;
  assert(layer, 'Real generated coalmine layer missing');
  const [chunkX, chunkY] = [...layer.validChunks][Math.floor(layer.validChunks.size / 2)].split(',').map(Number);
  const probeX = (chunkX - 35) * 512 + 128, probeY = (chunkY - 14) * 512 + 128;
  function mainItem(pw: number) {
    const item = items.find(entry => entry.region.pw === pw && entry.region.y <= probeY && entry.region.y + entry.region.height > probeY);
    assert(item, `Missing main-plane source for PW ${pw}`);
    return item;
  }
  function request(item: any, tile: { level: number; x: number; y: number }) {
    let resolve!: (result: any) => void;
    const result = new Promise<any>(done => { resolve = done; });
    const context: any = { tile,
      finish(value: CanvasRenderingContext2D, _request: unknown, type: string) { resolve({ context: value, type }); },
      fail(error: unknown) { resolve({ error: String(error) }); },
    };
    item.source.downloadTileStart(context);
    return { context, result };
  }
  // Independently reconstruct the shader camera from the OSD placement. Do not
  // call instantTileView: this comparison must catch mistakes in that function.
  function viewFor(item: any, tile: { level: number; x: number; y: number }) {
    const region = item.region;
    const scale = 2 ** (item.source.maxLevel - tile.level);
    const width = Math.min(INSTANT_TILE_SIZE, Math.ceil(region.width / scale) - tile.x * INSTANT_TILE_SIZE);
    const height = Math.min(INSTANT_TILE_SIZE, Math.ceil(region.height / scale) - tile.y * INSTANT_TILE_SIZE);
    const x = region.x + tile.x * INSTANT_TILE_SIZE * scale;
    const y = region.y + tile.y * INSTANT_TILE_SIZE * scale;
    return { width, height, x, y, scale,
      camX: x + width * scale / 2 + 17920 - region.pw * 35840,
      camY: y + height * scale / 2 + 7168, camZ: 1 / scale,
      pw: region.pw, pwVertical: 0, edgeNoise: true, materialTextures: true, engineTerrain: true };
  }
  function detailTile(item: any) {
    return { level: item.source.maxLevel,
      x: Math.floor((probeX + item.region.pw * 35840 - item.region.x) / INSTANT_TILE_SIZE),
      y: Math.floor((probeY - item.region.y) / INSTANT_TILE_SIZE) };
  }
  function referenceRaster(renderer: any, view: ReturnType<typeof viewFor>, factor: number, masks: StaticTerrainMask[] = []) {
    const width = view.width * factor, height = view.height * factor, step = view.scale / factor;
    const direct = renderer.render({ ...view, width, height, camZ: 1 / step });
    const pixels = direct.getContext('2d').getImageData(0, 0, width, height);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const worldX = view.x + (x + .5) * step, worldY = view.y + (y + .5) * step;
      let erased = worldY < WORLD_TOP || worldY >= WORLD_TOP + WORLD_HEIGHT || owners.at(worldX, worldY) < 0;
      for (const mask of masks) {
        const mx = Math.floor(worldX - mask.x), my = Math.floor(worldY - mask.y);
        if (mx < 0 || my < 0 || mx >= mask.width || my >= mask.height) continue;
        const p = my * mask.width + mx;
        erased ||= !!(((mask.bits[p >> 3] ?? 0) | (mask.airBits?.[p >> 3] ?? 0)) & (1 << (p & 7)));
      }
      if (erased) pixels.data.fill(0, (y * width + x) * 4, (y * width + x + 1) * 4);
    }
    let canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    canvas.getContext('2d')!.putImageData(pixels, 0, 0);
    while (canvas.width > view.width) {
      const next = document.createElement('canvas'); next.width = canvas.width / 2; next.height = canvas.height / 2;
      const context = next.getContext('2d')!; context.imageSmoothingEnabled = true; context.imageSmoothingQuality = 'low';
      context.drawImage(canvas, 0, 0, next.width, next.height); canvas.width = canvas.height = 0; canvas = next;
    }
    return canvas.getContext('2d')!.getImageData(0, 0, view.width, view.height).data;
  }
  function imageError(actual: Uint8ClampedArray, reference: Uint8ClampedArray) {
    let error = 0;
    for (let i = 0; i < actual.length; i += 4) {
      for (let c = 0; c < 3; c++) error += Math.abs(actual[i + c] * actual[i + 3] - reference[i + c] * reference[i + 3]) / 255;
      error += Math.abs(actual[i + 3] - reference[i + 3]);
    }
    return error / actual.length;
  }
  let comparedPixels = 0;
  async function compare(item: any, tile: { level: number; x: number; y: number }, masks: StaticTerrainMask[] = []) {
    const before = native.draws();
    const rendered = await request(item, tile).result;
    assert(!rendered.error && rendered.type === 'context2d', `Actual tile failed: ${rendered.error}`);
    assert(native.draws() - before === 1, `Tile requested ${native.draws() - before} shader draws instead of one`);
    const view = viewFor(item, tile);
    const actual = rendered.context.getImageData(0, 0, view.width, view.height).data;
    const renderer = renders.at(-1)!.renderer;
    const factor = Math.min(view.scale, 4, 2 ** Math.floor(Math.log2(512 / Math.max(view.width, view.height))));
    const expected = referenceRaster(renderer, view, factor, masks);
    let visible = 0, checked = 0;
    for (let i = 0; i < actual.length; i++) {
      assert(actual[i] === expected[i],
        `Filtered pixel mismatch PW ${item.region.pw}, LOD ${tile.level}, byte ${i}: ${actual[i]} != ${expected[i]}`);
      if (i % 4 === 3) { checked++; if (actual[i]) visible++; }
    }
    assert(visible > 25, 'Terrain integration produced blank output');
    comparedPixels += checked;
    return { view, actual, checked, visible, width: view.width, height: view.height, draws: 1 };
  }
  const samples = [];
  try {
    assert(await addInstantTerrain(viewer, gen, deps, [], () => true, () => {}, () => paints++, () => failures++), 'Actual GPU setup failed');
    assert(paints === 0, 'Setup reported paint before a tile draw event');
    let maskProbe: { x: number; y: number } | undefined;
    for (const pw of [0, -1, 1]) {
      const item = mainItem(pw), tile = detailTile(item);
      const detail = await compare(item, tile);
      samples.push({ pw, kind: 'detail', width: detail.width, height: detail.height, visible: detail.visible, checked: detail.checked, draws: detail.draws });
      if (pw === 0) {
        // Place a sparse scene over actual opaque terrain, including transparent
        // interior pixels that a mistaken bounding-box erase would delete.
        for (let y = 2; y < detail.height - 2 && !maskProbe; y++) for (let x = 2; x < detail.width - 10; x++) {
          if (Array.from({ length: 8 }, (_, dx) => detail.actual[(y * detail.width + x + dx) * 4 + 3]).every(alpha => alpha === 255)) {
            maskProbe = { x: detail.view.x + x, y: detail.view.y + y }; break;
          }
        }
      }
      const overview = await compare(item, { level: item.source.maxLevel - 8, x: 0, y: 0 });
      samples.push({ pw, kind: 'overview', width: overview.width, height: overview.height, visible: overview.visible, checked: overview.checked, draws: overview.draws });
    }
    const quality = [];
    for (const scale of [2, 4, 8]) {
      const item = mainItem(0), tile = { level: item.source.maxLevel - Math.log2(scale),
        x: Math.floor((probeX - item.region.x) / (INSTANT_TILE_SIZE * scale)),
        y: Math.floor((probeY - item.region.y) / (INSTANT_TILE_SIZE * scale)) };
      const started = performance.now();
      const actual = await request(item, tile).result;
      assert(!actual.error, `Quality tile failed: ${actual.error}`);
      const tileMs = performance.now() - started;
      const view = viewFor(item, tile), renderer = renders.at(-1)!.renderer;
      const pixels = actual.context.getImageData(0, 0, view.width, view.height).data;
      const fullResolution = referenceRaster(renderer, view, scale);
      const oldPoint = referenceRaster(renderer, view, 1);
      const oldError = imageError(oldPoint, fullResolution), filteredError = imageError(pixels, fullResolution);
      assert(filteredError < oldError * .85, `Insufficient area-quality improvement at scale ${scale}: ${filteredError} vs ${oldError}`);
      quality.push({ scale, tileMs, oldMeanAbsoluteError: oldError, filteredMeanAbsoluteError: filteredError,
        reductionPercent: (1 - filteredError / oldError) * 100, fullReferencePixels: view.width * view.height * scale * scale,
        boundedSamplePixels: view.width * view.height * 4 });
    }
    // Revisit already rendered regions/levels after simulating OSD destroying
    // its copies. Real GLES must do no work and final clipped pixels must match.
    const reuseStarted = performance.now(), beforeReuse = native.draws();
    let reusedRequests = 0, reusedPixels = 0;
    for (const pw of [-1, 0, 1]) {
      const item = mainItem(pw);
      for (const tile of [detailTile(item), { level: 8, x: 0, y: 0 }]) {
        const first = await request(item, tile).result;
        assert(!first.error, `Cached tile failed: ${first.error}`);
        const width = first.context.canvas.width, height = first.context.canvas.height;
        const expected = first.context.getImageData(0, 0, width, height).data;
        first.context.canvas.width = first.context.canvas.height = 0;
        const second = await request(item, tile).result;
        assert(!second.error, `Revisited tile failed: ${second.error}`);
        const actual = second.context.getImageData(0, 0, width, height).data;
        assert(actual.every((value: number, i: number) => value === expected[i]), 'Revisited terrain pixels changed');
        reusedRequests += 2; reusedPixels += width * height;
      }
    }
    const reuse = { requests: reusedRequests, comparedPixels: reusedPixels,
      shaderDraws: native.draws() - beforeReuse, milliseconds: performance.now() - reuseStarted };
    assert(reuse.shaderDraws === 0, `Cached zoom traversal reran ${reuse.shaderDraws} GPU draws`);
    for (const handler of [...(handlers.get('tile-drawn') ?? [])]) handler({ tiledImage: mainItem(0) });
    assert(Number(paints) === 1, 'First paint was not tied to the actual terrain tile event');
    assert(failures === 0, 'Unexpected GPU fallback');
    assert(uploads === 1, 'Main-plane worlds did not share one resource upload');
    const beforeCancel = native.draws();
    const pending = request(mainItem(0), detailTile(mainItem(0)));
    clearInstantTerrain();
    assert((await pending.result).error?.includes('cancel'), 'Clearing terrain left a queued tile unsettled');
    await new Promise(resolve => setTimeout(resolve, 5));
    assert(native.draws() === beforeCancel, 'Cancelled tile still reached the GPU');
    assert((handlers.get('tile-drawn')?.size ?? 0) === 0, 'Tile draw listener leaked');
    assert(invalidations >= 1, 'Clearing terrain did not release GPU resources');
    assert(maskProbe, 'No opaque terrain available for sparse scene mask check');
    items.length = 0;
    const masks: StaticTerrainMask[] = [{ ...maskProbe, width: 8, height: 1, bits: new Uint8Array([1]), airBits: new Uint8Array([16]) }];
    assert(await addInstantTerrain(viewer, gen, deps, masks, () => true, () => {}, () => paints++, () => failures++), 'Second GPU setup failed');
    const masked = await compare(mainItem(0), detailTile(mainItem(0)), masks);
    return { seed: 42, rendererUploads: uploads, comparedPixels, samples, quality, reuse,
      maskCheckedPixels: masked.checked, sparseMaskPreserved: true, cancellationPreserved: true, firstPaintEvents: paints, failures };
  } finally { clearInstantTerrain(); }
}
