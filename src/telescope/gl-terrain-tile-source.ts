/**
 * gl-terrain-tile-source.ts
 *
 * OpenSeadragon TileSource backed by the render-perf WebGL2 terrain renderer
 * (lib/noita-telescope-vm/js/gl/terrain_renderer.js).
 *
 * WHY A TILE SOURCE AND NOT A COMPOSITE
 * The existing biome path (telescope-osd-bridge addBiomeLayersProgressively)
 * rasterises each parallel world into ONE canvas at 1 canvas px = 10 game px and
 * adds it with buildPyramid:false. Final-pixel rendering means 1 canvas px = 1
 * game px, which for a single world is ~35840 px wide -- far past any canvas
 * limit. So the only shape that works is on-demand tiles, which is also what
 * OSD wants anyway.
 *
 * WHY THE UPSTREAM ZOOM GATE IS NOT COPIED
 * Upstream disables the per-cell material-texture pass below camera zoom 0.5
 * (js/app.js:63 MATERIAL_DETAIL_MIN_ZOOM, applied at js/app.js:2649-2650),
 * because the shader point-samples the world -- `ivec2 w = u_originInt +
 * ivec2(floor(off))` at js/gl/shaders.js:906-908 -- with no mip or averaging, so
 * at scale < 1 the material texels alias into pseudo-random speckle instead of
 * downsampling.
 *
 * That gate lives entirely in the CALLER, so we neither copy it nor patch the
 * shader: we pass materialTextures unconditionally and fix the actual problem by
 * SUPERSAMPLING. A tile whose pixels each cover N world px is rendered at N x
 * tile size and box-filtered down, so every output pixel is the true average of
 * the real full-resolution pixels. Measured on seed 786433191: upstream's gated
 * output is flat colour (all material detail gone), naive un-gating produces
 * harsh speckle, and supersample+filter keeps the detail as coherent texture.
 *
 * Consequence: final pixels are never discarded at any zoom -- coarse levels are
 * filtered, not substituted, so content does not change as you zoom.
 */

import { getGLTerrainSupersampleCap, isGLTerrainEnabled } from "../renderer_settings";

declare const OpenSeadragon: any;

/** OSD units are game pixels on the dynamic map (osdWidth = compositeW * 10 and
 *  a composite px is 10 game px), so a tile edge of 512 is 512 game px at 1:1. */
const TILE_SIZE = 512;

/** Hard ceiling on a single supersampled render's edge, in pixels. 2048 keeps a
 *  tile at 4 megapixels worst case (S=4 for a 512px tile), which stays
 *  responsive on the main thread; 4096 measurably stalled the page at deep
 *  zoom-out during testing. */
const MAX_RENDER_EDGE = 2048;

/** Upstream constants, mirrored rather than imported so this module does not
 *  depend on which telescope fork is aliased (both define them identically):
 *  js/constants.js CHUNK_SIZE / WORLD_CHUNK_CENTER_Y. */
const CHUNK_SIZE = 512;
const WORLD_CHUNK_CENTER_Y = 14;

/**
 * Upstream's half-tile visual offset (constants.js VISUAL_TILE_OFFSET_X/Y = -5,
 * TILE_SIZE = 10).
 *
 * Upstream applies it when it draws a layer (app.js drawImage at
 * layer.correctedX + ... + VISUAL_TILE_OFFSET_X) and the GL path bakes the same
 * -5 into every region anchor (gl/indirection.js buildRegionTable
 * worldOriginX/worldOriginY, and VIS_X / VIS_Y in gl/shaders.js).
 *
 * noitamap's CPU composite path does NOT apply it — it places each overlay at
 * plain `correctedX - worldCenter*512` / `anchorY + correctedY`, and every other
 * noitamap coordinate (pixel scenes, POI markers, the static base map) is in that
 * same unshifted space. So the shader's world for a given anchor sits 5 px from
 * where noitamap expects it, and the terrain came out half a tile off against
 * everything else.
 *
 * Compensating here rather than in the fork keeps lib/noita-telescope-vm pristine.
 */
const VISUAL_TILE_OFFSET_X = -5;
const VISUAL_TILE_OFFSET_Y = -5;

let sourceCounter = 0;

export interface GLTerrainDeps {
  /** GLTerrainRenderer class from the aliased telescope fork. */
  GLTerrainRenderer: any;
  /** getWorldCenter(isNGP, gameMode) from telescope utils. */
  getWorldCenter: (isNGP: boolean, gameMode?: string) => number;
  /** GENERATOR_CONFIG, required by buildEngineResources when engineTerrain is on. */
  GENERATOR_CONFIG: any;
}

export interface GLTerrainGeneration {
  tileLayers: any[];
  biomeData: any;
  isNGP: boolean;
  gameMode?: string;
  seed: number;
}

/** One renderer per page: it owns a WebGL2 context, and contexts are scarce. */
let renderer: any = null;
let resourceKey: string | null = null;
let lastFailure: string | null = null;

function generationKey(g: GLTerrainGeneration): string {
  return `${g.seed}|${g.isNGP ? 1 : 0}|${g.gameMode ?? "normal"}|${g.tileLayers.length}`;
}

/**
 * Build (or reuse) the GPU resources for a generation. Cheap to call repeatedly:
 * it no-ops when the generation is unchanged. Returns false when GL is
 * unavailable, so callers can fall back to the CPU composite path.
 */
export function ensureGLTerrain(deps: GLTerrainDeps, gen: GLTerrainGeneration): boolean {
  if (!isGLTerrainEnabled()) return false;
  if (lastFailure) return false;
  if (!gen.tileLayers?.length || !gen.biomeData) return false;

  if (!renderer) {
    try {
      renderer = new deps.GLTerrainRenderer();
    } catch (e) {
      lastFailure = `construct failed: ${e}`;
      console.warn("[GLTerrain]", lastFailure);
      return false;
    }
  }

  const key = generationKey(gen);
  if (resourceKey === key && renderer.ready) return true;

  const t0 = performance.now();
  let ok = false;
  try {
    ok = renderer.ensureResources(gen.tileLayers, gen.biomeData, {
      isNGP: gen.isNGP,
      gameMode: gen.gameMode ?? "normal",
      // Colour-only settings; changing these is a 1 KiB LUT re-upload upstream,
      // not an atlas rebuild.
      lut: { recolorMaterials: true, clearSpawnPixels: true },
      engineTerrain: true,
      seed: gen.seed,
      generatorConfig: deps.GENERATOR_CONFIG,
    });
  } catch (e) {
    lastFailure = `ensureResources threw: ${e}`;
    console.warn("[GLTerrain]", lastFailure);
    return false;
  }

  if (!ok) {
    lastFailure = renderer.failed || "ensureResources returned false";
    console.warn("[GLTerrain] unavailable:", lastFailure);
    return false;
  }

  resourceKey = key;
  console.log(
    `[GLTerrain] resources ready in ${Math.round(performance.now() - t0)}ms`,
    renderer.stats ? JSON.stringify(renderer.stats) : "",
  );
  return true;
}

/** Drop GPU resources (seed switch / leaving the dynamic map). */
export function clearGLTerrain(): void {
  try {
    renderer?.invalidate?.();
  } catch {
    /* nothing useful to do */
  }
  resourceKey = null;
}

/** Which vertical planes the GL pass covers. Upstream hard-codes pwY === 0 in
 *  both rendersWorld() and a shader early-out: heaven and hell replace the biome
 *  map with a row-0 / row-47 broadcast, which the chunk-indirection design would
 *  smear one region across. Those planes stay on the CPU composite path. */
export function glCoversVerticalPlane(pwVertical: number): boolean {
  if (!renderer) return false;
  try {
    return !!renderer.rendersWorld(pwVertical);
  } catch {
    return false;
  }
}

export interface GLTerrainSourceOpts {
  deps: GLTerrainDeps;
  gen: GLTerrainGeneration;
  /** Horizontal parallel world index (-1, 0, +1, ...). */
  pw: number;
  /** Top-left of the region in OSD/world units (game pixels). */
  worldX: number;
  worldY: number;
  /** Region size in OSD/world units (game pixels). */
  worldW: number;
  worldH: number;
}

/**
 * A pyramidal OSD TileSource whose tiles are rendered on demand by the GPU.
 *
 * Level maxLevel is 1 tile px = 1 world px. Each coarser level doubles the world
 * pixels per tile pixel, and those levels supersample so no detail is lost.
 */
export function createGLTerrainTileSource(opts: GLTerrainSourceOpts): any {
  const { deps, gen, pw, worldX, worldY, worldW, worldH } = opts;

  const maxLevel = Math.max(0, Math.ceil(Math.log2(Math.max(worldW, worldH))));
  const source = new OpenSeadragon.TileSource({
    width: worldW,
    height: worldH,
    tileSize: TILE_SIZE,
    minLevel: 0,
    maxLevel,
  });

  const id = ++sourceCounter;
  source.__glTerrain = true;

  // The renderer's camera is expressed in canvas space, so invert it. From
  // terrain_renderer.js:288-292 the shader origin is
  //   originX = camX - (width/2)/camZ - centerPx + pw*CHUNK_SIZE*mapWidth
  //   originY = camY - (height/2)/camZ - WORLD_CHUNK_CENTER_Y*CHUNK_SIZE
  // and pw is applied inside the renderer, so camX/camY are the world-space
  // centre of the target rect with the two constant offsets added back.
  const centerPx = CHUNK_SIZE * deps.getWorldCenter(gen.isNGP, gen.gameMode ?? "normal");
  const originYOffset = WORLD_CHUNK_CENTER_Y * CHUNK_SIZE;

  /** World rect covered by a tile, in OSD/world units. */
  function tileWorldRect(level: number, tx: number, ty: number) {
    const scale = Math.pow(2, maxLevel - level); // world px per tile px
    const w = TILE_SIZE * scale;
    return { wx: worldX + tx * w, wy: worldY + ty * w, ww: w, wh: w, scale };
  }

  source.getTileUrl = function (level: number, x: number, y: number) {
    return `gl-terrain://${id}/${level}/${x}/${y}`;
  };

  // The GL output is genuinely transparent: air is discarded and liquids
  // composite at their material's XML alpha (shaders.js:126-129, :1029-1032), so
  // the background stack and the static base map show through underneath.
  source.hasTransparency = function () {
    return true;
  };

  source.downloadTileStart = function (context: any) {
    const tile = context.tile;
    const { wx, wy, ww, wh, scale } = tileWorldRect(tile.level, tile.x, tile.y);

    const out = document.createElement("canvas");
    out.width = TILE_SIZE;
    out.height = TILE_SIZE;

    const finish = () => queueMicrotask(() => context.finish(out, null, "image"));

    if (!renderer?.ready) {
      finish();
      return;
    }

    // Supersample only when a tile pixel covers more than one world pixel.
    // Zoomed in past 1:1 the shader is already exact and nearest-neighbour is
    // what pixel art wants, so S stays 1 there.
    //
    // Bounded by RENDER SIZE, not just the factor: at a deep zoom-out `scale`
    // grows without limit, and S = scale would ask for a 4096x4096 (or larger)
    // GPU render per tile. Rendering is synchronous on the main thread (the
    // renderer bails with 'no DOM' in a worker), so a viewport full of those
    // stalls the page hard enough to miss frames entirely. Capping the render
    // edge keeps per-tile cost flat as you zoom out; the averaging quality lost
    // past that point is not perceptible because the detail is already far
    // below one screen pixel.
    const cap = getGLTerrainSupersampleCap();
    const sizeCap = Math.max(1, Math.floor(MAX_RENDER_EDGE / TILE_SIZE));
    const S = scale > 1 ? Math.max(1, Math.min(cap, sizeCap, Math.round(scale))) : 1;
    const renderW = TILE_SIZE * S;
    const renderH = TILE_SIZE * S;

    // camX/camY are the world centre of the rect and are independent of S:
    // (renderW/2) / camZ == ww/2 for any S.
    const camZ = S / scale;
    // + VISUAL_TILE_OFFSET puts the shader's world where noitamap's CPU
    // composite convention expects it (see the constant's note).
    const camX = wx + ww / 2 + centerPx + VISUAL_TILE_OFFSET_X;
    const camY = wy + wh / 2 + originYOffset + VISUAL_TILE_OFFSET_Y;

    let glCanvas: HTMLCanvasElement | null = null;
    try {
      glCanvas = renderer.render({
        width: renderW,
        height: renderH,
        camX,
        camY,
        camZ,
        pw,
        pwVertical: 0,
        edgeNoise: true,
        // Never gated on zoom -- see the header. Supersampling, not disabling,
        // is what keeps this from aliasing.
        materialTextures: true,
        engineTerrain: true,
      });
    } catch (e) {
      console.warn("[GLTerrain] render threw:", e);
    }

    if (!glCanvas) {
      finish();
      return;
    }

    const ctx = out.getContext("2d")!;
    if (S === 1) {
      // 1:1 -- keep it exact, no resampling of any kind.
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(glCanvas, 0, 0);
    } else {
      // Box-filter the supersampled render down. The browser's high-quality
      // downscale path is a mip-chain reduction, which is the averaging we want
      // and is GPU-side; a JS getImageData loop over renderW*renderH would be
      // tens of MB per tile.
      ctx.imageSmoothingEnabled = true;
      (ctx as any).imageSmoothingQuality = "high";
      ctx.drawImage(glCanvas, 0, 0, renderW, renderH, 0, 0, TILE_SIZE, TILE_SIZE);
    }

    // Deferred for the same reason marker-tile-source.ts defers: calling finish
    // synchronously makes OSD set coverage for a tile before its level's
    // coverage has been reset, which pops background tiles to low-res.
    finish();
  };

  source.downloadTileAbort = function () {
    // Rendering is synchronous; nothing to cancel.
  };

  console.log(
    `[GLTerrain] tile source #${id} pw=${pw} ${worldW}x${worldH} maxLevel=${maxLevel} at (${worldX},${worldY})`,
  );
  return source;
}
