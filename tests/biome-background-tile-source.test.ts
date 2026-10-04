// @vitest-environment jsdom
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { readFileSync } from "node:fs";
import { decode } from "fast-png";
import { createBiomeBackgroundTiles, type BiomeBackgroundRegion } from "../src/telescope/biome-background-tile-source";
import { installViewportLayerDrawing } from "../src/telescope/instant-terrain-viewport";
import { createSourceFile, isFunctionDeclaration, isImportDeclaration, ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import { alignTerrainTileEdges } from "../src/osd-pixel-rendering";
import { BIOME_BACKGROUND_MAP, STATIC_TERRAIN_BIOMES, CARVED_ROOM_BIOMES, WORLD_HEIGHT, WORLD_TOP,
  createBackgroundOwnership, createTerrainOwnership } from "../src/telescope/terrain-policy";
import { GENERATOR_CONFIG } from '../lib/noita-telescope-vm/js/generator_config.js';
import { decodePngToRgba } from '../src/telescope/png-decode';
import boundaries from "../src/data/biome_boundries_py.json";

// Use the production attachment lifecycle with real OSD and decoded textures.
// The asset loader's Vite-only imports are unused in this native fixture.
const layerSource = createSourceFile('biome-background-layer.ts',
  readFileSync('src/telescope/biome-background-layer.ts', 'utf8'), ScriptTarget.Latest);
const layerCode = transpileModule(layerSource.statements.filter(statement => !isImportDeclaration(statement))
  .map(statement => statement.getText(layerSource)).join('\n'), {
  compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.CommonJS },
}).outputText;
const { attachBiomeBackgroundLayer, clearBiomeBackgroundLayers, biomeBackgroundGeometry } = new Function(
  'exports', 'installViewportLayerDrawing', 'BIOME_BACKGROUND_MAP', 'STATIC_TERRAIN_BIOMES', 'CARVED_ROOM_BIOMES', 'WORLD_HEIGHT',
  `${layerCode}\nreturn exports;`)({}, installViewportLayerDrawing, BIOME_BACKGROUND_MAP, STATIC_TERRAIN_BIOMES, CARVED_ROOM_BIOMES, WORLD_HEIGHT);

// Exercise the real bridge's ordering and old-item cleanup. The terrain
// renderer is a controlled readiness barrier; native OSD draws the pixels.
const bridgeSource = createSourceFile('telescope-osd-bridge.ts',
  readFileSync('src/telescope/telescope-osd-bridge.ts', 'utf8'), ScriptTarget.Latest);
const bridgeFunctions = new Set(['isDynamicSeedItem', 'addBiomeBgToOSD', 'renderGenerationResult']);
const bridgeCode = transpileModule(bridgeSource.statements.filter(statement =>
  isFunctionDeclaration(statement) && bridgeFunctions.has(statement.name?.text ?? ''))
  .map(statement => statement.getText(bridgeSource)).join('\n'), {
  compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.CommonJS },
}).outputText;
const createBridge = new Function('exports', 'attachBiomeBackgroundLayer', '_bgLayer', `
  let _bgEpoch = 0, currentGenerationId = 0;
  const dynamicTiledImages = new Set();
  let dynamicOverlayElements = [], dynamicBlobUrls = [], activeOrbTargets = [];
  const isGLTerrainEnabled = () => false, isInstantTerrainEnabled = () => false, isLightMode = () => false;
  const clearPortalAnimations = () => {}, clearInstantTerrain = () => {}, clearTerrainPngEncoders = () => {};
  let finish;
  const addBiomeLayersProgressively = (_viewer, _result, _generation, firstPaint) => new Promise(resolve => {
    finish = () => {
      firstPaint();
      // End after the production handoff; unrelated POI preparation is outside this fixture.
      currentGenerationId++;
      resolve();
    };
  });
  ${bridgeCode}
  return { render: renderGenerationResult, finish: () => finish() };
`);

let OSD: any, texture: any, original: Uint8ClampedArray;
beforeAll(async () => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
    return createCanvas(this.width || 1, this.height || 1).getContext("2d") as any;
  });
  OSD = (await import("openseadragon")).default;
  vi.stubGlobal("OpenSeadragon", OSD);
  OSD.pixelDensityRatio = 1;
  const createElement = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation(((name: string, options?: ElementCreationOptions) =>
    name === "canvas" ? createCanvas(1, 1) : createElement(name, options)) as any);
  const bytes = readFileSync("public/biome_bg/background_wandcave.png");
  const decoded = decode(bytes);
  expect(decoded.channels).toBe(1);
  expect(decoded.palette).toBeDefined();
  original = new Uint8ClampedArray(decoded.width * decoded.height * 4);
  for (let i = 0; i < decoded.data.length; i++) original.set(decoded.palette![decoded.data[i]], i * 4);
  const image = await loadImage(bytes);
  texture = createCanvas(image.width, image.height);
  texture.getContext("2d").drawImage(image, 0, 0);
  expect(Buffer.from(texture.getContext("2d").getImageData(0, 0, image.width, image.height).data)
    .equals(Buffer.from(original))).toBe(true);
  texture.close = vi.fn();
});
afterAll(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const rect = (x: number, y: number, w: number, h: number) =>
  [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
const originX = -17793, originY = -7131, phaseX = -17920, phaseY = -7168;

function fixture(options: { width?: number; height?: number; regions?: BiomeBackgroundRegion[]; maxCacheBytes?: number } = {}) {
  const width = options.width ?? 513, height = options.height ?? 259;
  const textures = new Map<string, ImageBitmap>([["wandcave", texture]]);
  const pack = createBiomeBackgroundTiles({
    regions: options.regions ?? [{ rings: [rect(originX, originY, width, height)], textureKey: "wandcave" }],
    textures, originX, originY, width, height, phaseX, phaseY, maxCacheBytes: options.maxCacheBytes,
  });
  const loader = new OSD.ImageLoader({ jobLimit: 8, timeout: 3000 });
  function source(offset = 0) {
    const s = pack.createSource(offset);
    let lastJob: any;
    const start = s.downloadTileStart;
    s.downloadTileStart = (job: any) => { lastJob = job; start(job); };
    function request(level: number, x = 0, y = 0) {
      let resolve!: () => void;
      const done = new Promise<void>(r => { resolve = r; });
      const callback = vi.fn((..._args: any[]) => resolve());
      loader.addJob({ source: s, src: s.getTileUrl(level, x, y), tile: { level, x, y }, callback });
      return { callback, job: lastJob, done };
    }
    async function read(level = s.maxLevel, x = 0, y = 0) {
      const req = request(level, x, y); await req.done;
      expect(req.callback).toHaveBeenCalledOnce();
      expect(req.callback.mock.calls[0][1]).toBeNull();
      return req.callback.mock.calls[0][0];
    }
    return { source: s, read, request };
  }
  return { pack, source, textures, loader, width, height };
}

function pixelCheck(ctx: any, left: number, top: number, offset = 0, owns = (_x: number, _y: number) => true) {
  const actual = ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height).data;
  const mod = (v: number, size: number) => ((v % size) + size) % size;
  let mismatch = "";
  outer: for (let y = 0; y < ctx.canvas.height; y++) for (let x = 0; x < ctx.canvas.width; x++) {
    const worldX = originX + left + x, worldY = originY + top + y;
    const tx = mod(worldX + offset - phaseX, texture.width), ty = mod(worldY - phaseY, texture.height);
    for (let c = 0; c < 4; c++) {
      const expected = owns(left + x, top + y) ? original[(ty * texture.width + tx) * 4 + c] : 0;
      const value = actual[(y * ctx.canvas.width + x) * 4 + c];
      if (value !== expected) { mismatch = `${left + x},${top + y} channel ${c}: ${value} != ${expected}`; break outer; }
    }
  }
  expect(mismatch).toBe("");
}

describe("native biome backgrounds through installed OSD and native canvas", () => {
  it.each([-35840, 0, 35840])("keeps native PW %s backgrounds through startup and seed handoffs without tile requests", async offset => {
    const f = fixture();
    const canvas = createCanvas(256, 192), items: any[] = [];
    const viewer = new OSD.EventSource(), world = new OSD.EventSource();
    let area = new OSD.Rect(originX + offset, originY, 256, 192);
    const viewport = {
      getBounds: () => area, getBoundsWithMargins: () => area, getBoundsNoRotate: () => area,
      getCenter: () => area.getCenter(), getRotation: () => 0, getFlip: () => false,
      getZoom: () => 256 / area.width, getContainerSize: () => new OSD.Point(256, 192),
      deltaPixelsFromPointsNoRotate: (p: any) => p.times(256 / area.width),
      pixelFromPoint: (p: any) => p.minus(area.getTopLeft()).times(256 / area.width),
      pixelFromPointNoRotate: (p: any) => p.minus(area.getTopLeft()).times(256 / area.width),
      viewportToViewerElementRectangle: (r: any) => new OSD.Rect((r.x - area.x) * 256 / area.width,
        (r.y - area.y) * 256 / area.width, r.width * 256 / area.width, r.height * 256 / area.width),
    };
    Object.assign(world, {
      getItemCount: () => items.length, getItemAt: (i: number) => items[i], ensureTilesUpToDate() {},
      removeItem(item: any) {
        const index = items.indexOf(item);
        if (index < 0) return;
        items.splice(index, 1); item.destroy(); world.raiseEvent('remove-item', { item });
      },
    });
    Object.assign(viewer, { world, viewport, isAnimating: () => false, isDestroyed: () => false,
      tileCache: new OSD.TileCache({ maxImageCacheCount: 20 }), tileRetryMax: 0, forceRedraw: vi.fn() });
    const drawer = Object.create(OSD.CanvasDrawer.prototype);
    Object.assign(drawer, { viewer, viewport, _renderingTarget: canvas, context: canvas.getContext('2d'),
      sketchCanvas: null, sketchContext: null, _imageSmoothingEnabled: false, options: { usePrivateCache: false } });
    viewer.drawer = drawer;
    const originalDraw = drawer._drawTiles, loader = new OSD.ImageLoader({ jobLimit: 2 });
    const download = vi.spyOn(loader, 'addJob');
    viewer.addTiledImage = (options: any) => {
      const item = new OSD.TiledImage({ source: options.tileSource, viewer, viewport, drawer,
        tileCache: viewer.tileCache, imageLoader: loader, x: options.x, y: options.y, width: options.width,
        immediateRender: true, maxTilesPerFrame: 1, discardLevelsBelowDownsampleRatio: 1, ajaxHeaders: {} });
      item.getDrawer = () => drawer;
      items.splice(options.index ?? items.length, 0, item);
      world.raiseEvent('add-item', { item }); options.success({ item });
    };
    try {
      // Intentionally never install a terrain layer. This is the cold-load
      // interval where backgrounds previously depended on GPU setup completing.
      const layer = { tiles: f.pack, originX, originY, width: f.width } as any;
      attachBiomeBackgroundLayer(viewer, layer, [offset], () => true, () => {});
      for (const item of items) item.update(true);
      drawer.draw(items);
      expect(download).not.toHaveBeenCalled();
      pixelCheck(drawer.context, 0, 0, offset);
      expect(f.pack.stats.rendered).toBe(0);
      expect(items[0].setDrawn()).toBe(false);
      // Home and a return to detail reuse the decoded original artwork in
      // the same draw, even though no overview/detail tiles have ever loaded.
      area = new OSD.Rect(originX + offset, originY, 1024, 768);
      items[0].update(true); drawer.draw(items);
      expect(drawer.context.getImageData(30, 30, 1, 1).data[3]).toBe(255);
      area = new OSD.Rect(originX + offset + 257, originY + 64, 256, 192);
      items[0].update(true); drawer.draw(items);
      pixelCheck(drawer.context, 257, 64, offset);
      expect(download).not.toHaveBeenCalled();

      // A finished outgoing seed stays visible until its replacement paints.
      // Reattaching the backdrop used to cover its ground terrain immediately.
      const outgoing = new OSD.TileSource({ width: f.width, height: f.height, tileSize: 1024 });
      outgoing.__drawViewport = (context: any) => {
        context.fillStyle = '#c02040'; context.fillRect(0, 0, 128, 192); return true;
      };
      installViewportLayerDrawing(viewer, outgoing);
      viewer.addTiledImage({ tileSource: outgoing, x: originX + offset, y: originY,
        width: f.width, success() {} });
      const background = items[0];
      for (let seed = 0; seed < 6; seed++) {
        attachBiomeBackgroundLayer(viewer, layer, [offset], () => true, () => {});
        for (const item of items) item.update(true);
        drawer.draw(items);
        expect([...drawer.context.getImageData(12, 12, 1, 1).data]).toEqual([192, 32, 64, 255]);
        expect(items.filter(item => item.source.__biomeBg)).toEqual([background]);
        expect(f.pack.stats.sources).toBe(1);
      }
      const old = items.pop(); old.destroy(); world.raiseEvent('remove-item', { item: old });
      drawer.draw(items);
      pixelCheck(drawer.context, 257, 64, offset);
      expect(download).not.toHaveBeenCalled();

      const bridge = createBridge({}, attachBiomeBackgroundLayer, layer);
      // Ground backgrounds must survive the real bridge's seed cleanup; a
      // baked outgoing layer must remain above them until that same handoff.
      for (const baked of [false, true]) {
        if (baked) clearBiomeBackgroundLayers(viewer);
        const source = new OSD.TileSource({ width: f.width, height: f.height, tileSize: 1024 });
        source.__bakedDzi = baked;
        source.__drawViewport = (context: any) => {
          context.fillStyle = '#c02040'; context.fillRect(0, 0, 128, 192); return true;
        };
        installViewportLayerDrawing(viewer, source);
        viewer.addTiledImage({ tileSource: source, x: originX + offset, y: originY,
          width: f.width, success() {} });
        const replaced = items.at(-1);
        const paint = vi.fn(), pending = bridge.render(viewer, {}, undefined, false, paint);
        for (const item of items) item.update(true);
        drawer.draw(items);
        expect([...drawer.context.getImageData(12, 12, 1, 1).data]).toEqual([192, 32, 64, 255]);
        const backgrounds = items.filter(item => item.source.__biomeBg);
        expect(backgrounds).toHaveLength(3);
        expect(paint).not.toHaveBeenCalled();
        bridge.finish(); await pending;
        expect(paint).toHaveBeenCalledOnce();
        expect(items).not.toContain(replaced);
        expect(items.filter(item => item.source.__biomeBg)).toEqual(backgrounds);
        expect(f.pack.stats.sources).toBe(3);
        drawer.draw(items);
        pixelCheck(drawer.context, 257, 64, offset);
      }
    } finally {
      viewer.raiseEvent('before-destroy', {});
      for (const item of items) item.destroy();
      f.pack.destroy();
      download.mockRestore();
    }
    expect(drawer._drawTiles).toBe(originalDraw);
  });

  it("ships a decodable original PNG for every non-static mapped biome boundary", async () => {
    const paths = new Set(boundaries.biomes
      .filter(b => !STATIC_TERRAIN_BIOMES.has(b.filename))
      .map(b => BIOME_BACKGROUND_MAP[b.filename]).filter(Boolean));
    expect(paths.size).toBeGreaterThan(10);
    for (const path of paths) {
      const bytes = readFileSync(`public/biome_bg/${path.split("/").pop()}`);
      expect(bytes.equals(readFileSync(`lib/noita-telescope-vm/${path}`))).toBe(true);
      const decoded = await loadImage(bytes);
      expect(decoded.width).toBeGreaterThanOrEqual(96);
      expect(decoded.height).toBeGreaterThanOrEqual(96);
    }
  });

  it.each([-35840, 0, 35840])('matches baked hell background pixels and transparent borders in PW %s', async offset => {
    const geometry = biomeBackgroundGeometry(boundaries.biomes);
    const map = decode(readFileSync('lib/noita-telescope-vm/data/biome_maps/biome_map.png'));
    const pixels = new Uint32Array(map.width * map.height);
    for (let y = 0; y < map.height; y++) for (let x = 0; x < map.width; x++) {
      const i = ((map.height - 1) * map.width + x) * 3;
      pixels[y * map.width + x] = (map.data[i] << 16) | (map.data[i + 1] << 8) | map.data[i + 2];
    }
    const baked = createBackgroundOwnership(createTerrainOwnership([], pixels, {}, map.width), pixels, GENERATOR_CONFIG, 1);
    const textures = new Map<string, any>(), reference = new Map<string, ReturnType<typeof decodePngToRgba>>();
    const keys = new Set([...baked.owners].filter(id => id >= 0).map(id => BIOME_BACKGROUND_MAP[baked.names[id]]));
    for (const key of keys) {
      const bytes = readFileSync(`public/biome_bg/${key.split('/').pop()}`);
      const original = decodePngToRgba(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      // These authored textures repeat exactly after one vertical world, so
      // the common layer phase also equals the baker's plane-local phase.
      expect(WORLD_HEIGHT % original.height).toBe(0);
      // Use the baker's raw decode: the native PNG loader applies gAMA color
      // conversion to the_end.png, which is unrelated to layer coverage/phase.
      const canvas = createCanvas(original.width, original.height), context = canvas.getContext('2d');
      const image = context.createImageData(original.width, original.height);
      image.data.set(original.data); context.putImageData(image, 0, 0);
      textures.set(key, canvas); reference.set(key, original);
    }
    const pack = createBiomeBackgroundTiles({ ...geometry, textures });
    const source = pack.createSource(offset);
    const uninterrupted = createBiomeBackgroundTiles({ ...geometry, textures,
      regions: [{ textureKey: BIOME_BACKGROUND_MAP.the_end,
        rings: [rect(-4096, WORLD_TOP, 7680, 2 * WORLD_HEIGHT)] }] });
    const uninterruptedSource = uninterrupted.createSource(offset);
    const compare = (context: any, left: number, top: number) => {
      const rgba = context.getImageData(0, 0, context.canvas.width, context.canvas.height).data;
      let mismatches = 0;
      for (let y = 0; y < context.canvas.height; y++) for (let x = 0; x < context.canvas.width; x++) {
        const wx = left + x, wy = top + y, owner = baked.at(wx, wy - WORLD_HEIGHT);
        const original = owner < 0 ? undefined : reference.get(BIOME_BACKGROUND_MAP[baked.names[owner]]);
        const out = (y * context.canvas.width + x) * 4;
        if (!original) {
          if (rgba[out + 3] !== 0) mismatches++;
          continue;
        }
        const tx = ((wx + map.width * 256) % original.width + original.width) % original.width;
        const ty = ((wy - WORLD_HEIGHT - WORLD_TOP) % original.height + original.height) % original.height;
        const input = (ty * original.width + tx) * 4;
        for (let c = 0; c < 4; c++) if (rgba[out + c] !== original.data[input + c]) mismatches++;
      }
      expect(mismatches, `native hell pixels at ${left},${top}`).toBe(0);
    };
    const patches = [
      [-4103, 17408], [-160, 20116], [3577, 17408], [-16903, 17408], [-16400, 17408],
      [-160, 41984 - 129], [-160, 24033],
    ];
    try {
      for (const [x, y] of patches) {
        const left = x + offset, canvas = createCanvas(271, 263), context = canvas.getContext('2d');
        source.__drawViewport(context, {
          opacity: 1,
          imageToViewportCoordinates: (x: number, y: number) => new OSD.Point(geometry.originX + offset + x, geometry.originY + y),
        }, { pixelFromPoint: (p: any) => new OSD.Point(p.x - left, p.y - y) });
        compare(context, left, y);
      }
      // Compare the join against one uninterrupted rectangle at fractional
      // zoom. This isolates contour seams from native Canvas image-edge AA.
      for (const scale of [.625, 1.25]) {
        const canvas = createCanvas(257, 129), context = canvas.getContext('2d');
        const item = {
          opacity: 1,
          imageToViewportCoordinates: (x: number, y: number) => new OSD.Point(geometry.originX + offset + x, geometry.originY + y),
        };
        const viewport = { pixelFromPoint: (p: any) => new OSD.Point((p.x + 160 - offset) * scale, (p.y - 17387.3) * scale) };
        source.__drawViewport(context, item, viewport);
        const referenceContext = createCanvas(257, 129).getContext('2d');
        uninterruptedSource.__drawViewport(referenceContext, item, viewport);
        expect(Buffer.from(context.getImageData(0, 0, 257, 129).data)
          .equals(Buffer.from(referenceContext.getImageData(0, 0, 257, 129).data)), `join at scale ${scale}`).toBe(true);
      }
      // The non-canvas OSD route uses the same geometry and original bytes.
      const loader = new OSD.ImageLoader({ jobLimit: 2, timeout: 3000 });
      for (const x of [-4096, -160, 3584, -16896]) {
        const tile = { level: source.maxLevel,
          x: Math.floor((x - geometry.originX) / 256), y: Math.floor((20116 - geometry.originY) / 256) };
        const context: any = await new Promise((resolve, reject) => loader.addJob({
          source, tile, src: source.getTileUrl(tile.level, tile.x, tile.y),
          callback: (result: any, error: unknown) => error ? reject(error) : resolve(result),
        }));
        compare(context, geometry.originX + offset + tile.x * 256, geometry.originY + tile.y * 256);
      }
      expect(loader.jobsInProgress).toBe(0);
    } finally {
      source.destroy(); pack.destroy(); uninterruptedSource.destroy(); uninterrupted.destroy();
      for (const canvas of textures.values()) canvas.width = canvas.height = 0;
    }
  });
  it.each([-35840, 0, 35840])("matches original 96px texture bytes across adjacent and edge tiles at PW offset %s", async offset => {
    expect([texture.width, texture.height]).toEqual([96, 96]);
    const f = fixture(), { source, read } = f.source(offset);
    try {
      expect(source.maxLevel).toBe(10);
      expect(source.getLevelScale(source.maxLevel)).toBe(1);
      expect(source.getNumTiles(source.maxLevel)).toEqual(new OSD.Point(3, 2));
      expect(source.__biomeBg).toBe(true);
      expect(source.__instantTerrain).toBeUndefined();
      expect(source.hasTransparency()).toBe(true);
      for (let y = 0; y < 2; y++) for (let x = 0; x < 3; x++) {
        const ctx = await read(source.maxLevel, x, y);
        expect(ctx.canvas.width).toBe(Math.min(256, 513 - x * 256));
        expect(ctx.canvas.height).toBe(Math.min(256, 259 - y * 256));
        pixelCheck(ctx, x * 256, y * 256, offset);
      }
      expect(f.loader.jobsInProgress).toBe(0);
    } finally { f.pack.destroy(); }
  });

  it("clips all subpaths together, preserving opposite-winding holes across a tile edge", async () => {
    const outer = rect(originX, originY, 513, 259);
    const hole = rect(originX + 251, originY + 17, 12, 24).reverse();
    // A same-winding nested path remains filled under SVG's nonzero rule.
    const solid = rect(originX + 21, originY + 17, 12, 24);
    const f = fixture({ regions: [{ rings: [outer, hole, solid], textureKey: "wandcave" }] });
    const s = f.source();
    try {
      for (const x of [0, 1]) pixelCheck(await s.read(s.source.maxLevel, x), x * 256, 0, 0,
        (px, py) => !(px >= 251 && px < 263 && py >= 17 && py < 41));
    } finally { f.pack.destroy(); }
  });

  it("shares one bounded cache without aliasing different PW phases or OSD-owned canvases", async () => {
    const f = fixture({ maxCacheBytes: 2 * 256 * 256 * 4 });
    try {
      const first = f.source(), a = await first.read();
      pixelCheck(a, 0, 0);
      a.canvas.width = a.canvas.height = 1;
      const sibling = f.source();
      pixelCheck(await sibling.read(), 0, 0);
      expect(f.pack.stats).toMatchObject({ rendered: 1, hits: 1, entries: 1 });
      first.source.destroy(); sibling.source.destroy();
      pixelCheck(await f.source().read(), 0, 0);
      expect(f.pack.stats.rendered).toBe(1);
      const pw = f.source(35840);
      pixelCheck(await pw.read(), 0, 0, 35840);
      expect(f.pack.stats.rendered).toBe(2);
      await pw.read(pw.source.maxLevel, 1);
      expect(f.pack.stats.bytes).toBeLessThanOrEqual(2 * 256 * 256 * 4);
      expect(f.pack.stats.evictions).toBeGreaterThan(0);
      expect(texture.close).not.toHaveBeenCalled();
      expect(f.textures.size).toBe(1);
    } finally { f.pack.destroy(); }
  });

  it("detaches one source's pending request while its shared sibling finishes exactly once", async () => {
    const f = fixture(), first = f.source(), second = f.source();
    try {
      const a = first.request(first.source.maxLevel), b = second.request(second.source.maxLevel);
      first.source.destroy(); await Promise.all([a.done, b.done]);
      expect(a.callback).toHaveBeenCalledOnce();
      expect(a.callback.mock.calls[0][1]).toBe("Biome background layer removed");
      expect(b.callback).toHaveBeenCalledOnce();
      expect(b.callback.mock.calls[0][1]).toBeNull();
      pixelCheck(b.callback.mock.calls[0][0], 0, 0);
      expect(f.pack.stats).toMatchObject({ rendered: 1, entries: 1, sources: 1, inflight: 0 });
      expect(f.loader.jobsInProgress).toBe(0);
    } finally { f.pack.destroy(); }
  });

  it("aborts a lone request before drawing and tears down without closing input textures", async () => {
    const f = fixture(), first = f.source();
    const aborted = first.request(first.source.maxLevel);
    aborted.job.abort(); await aborted.done;
    await Promise.resolve(); await Promise.resolve();
    expect(aborted.callback).toHaveBeenCalledOnce();
    expect(aborted.callback.mock.calls[0][1]).toContain("aborted");
    expect(f.pack.stats).toMatchObject({ rendered: 0, entries: 0 });
    const ready = await first.read();
    const pending = first.request(first.source.maxLevel, 1);
    f.pack.destroy(); f.pack.destroy(); await pending.done;
    await Promise.resolve(); await Promise.resolve();
    expect(pending.callback).toHaveBeenCalledOnce();
    expect(pending.callback.mock.calls[0][1]).toBe("Biome background layer removed");
    expect(f.pack.stats).toMatchObject({ bytes: 0, entries: 0, sources: 0, inflight: 0 });
    expect(texture.close).not.toHaveBeenCalled();
    expect(f.textures.size).toBe(1);
    expect(() => f.pack.createSource()).toThrow("destroyed");
    expect(first.source.tileExists(first.source.maxLevel, 0, 0)).toBe(false);
    pixelCheck(ready, 0, 0);
  });

  it("renders a whole-map overview with tile-sized allocation and one pattern fill per region", async () => {
    const f = fixture({ width: 35840, height: 49152 }), s = f.source();
    const fill = vi.spyOn(Object.getPrototypeOf(texture.getContext("2d")), "fillRect");
    try {
      const ctx = await s.read(s.source.getClosestLevel());
      expect(ctx.canvas.width).toBeLessThanOrEqual(256);
      expect(ctx.canvas.height).toBeLessThanOrEqual(256);
      expect(f.pack.stats.bytes).toBeLessThanOrEqual(256 * 256 * 4);
      expect(f.pack.stats).toMatchObject({ rendered: 1, entries: 1, pinned: 1 });
      expect(ctx.imageSmoothingEnabled).toBe(false);
      expect(fill).toHaveBeenCalledOnce();
    } finally { fill.mockRestore(); f.pack.destroy(); }
  });

  it("projects neighboring native background tiles to the same fractional-zoom edge", () => {
    const f = fixture(), { source } = f.source();
    try {
      const item = { source, getDrawer: () => ({ getType: () => "canvas" }), getRotation: () => 0,
        viewport: { getRotation: () => 0, pixelFromPointNoRotate: (p: any) => new OSD.Point(0.37 + p.x * 597.3, 0.61 + p.y * 597.3) } };
      const tiles = [0, 1, 2].map(x => ({
        positionedBounds: source.getTileBounds(source.maxLevel, x, 0),
        position: new OSD.Point(), size: new OSD.Point(),
      }));
      for (const tile of tiles) alignTerrainTileEdges(item, tile);
      expect(tiles[0].position.x + tiles[0].size.x).toBe(tiles[1].position.x);
      expect(tiles[1].position.x + tiles[1].size.x).toBe(tiles[2].position.x);
      expect(tiles[2].position.x + tiles[2].size.x).toBe(Math.round(0.37 + 597.3));
    } finally { f.pack.destroy(); }
  });
});
