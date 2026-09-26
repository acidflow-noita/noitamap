/** Bake-only bitmap export. The browser loads this module on the first export. */
import type { GenerationResult, PixelScene, TileLayer } from './telescope-adapter';
import { buildMarkerData } from './poi-spatial-index';
import { MIMIC_SPRITES_VERSION } from './poi-mimics';
import { STATIC_TERRAIN_BIOMES as SKIP_BIOMES, BIOME_BACKGROUND_MAP } from './terrain-policy';
import { rgbaToPngBlob } from './png-decode';

export interface DecorationExportDependencies {
  buildSceneBitmaps(result: GenerationResult): Promise<{
    validScenes: PixelScene[];
    bitmapByKey: Map<string, ImageBitmap>;
  } | null>;
  sceneRenderKey(scene: Pick<PixelScene, 'key' | 'variantKey'>): string;
}

export interface BiomeRegionExportDependencies {
  biomeRenderOrder: readonly string[];
  createTileOverlays(
    biomeData: GenerationResult['biomeData'], tileLayers: TileLayer[],
    pw: number, pvt: number, isNGP: boolean
  ): (OffscreenCanvas | null)[];
}

// ─── Headless biome-region export (build-daily-seed-images.cjs) ─────────────

export interface BiomeRegionImage {
  pw: number;
  pvt: number;
  /** OSD top-left corner (seed-anchored world coords) — the x/y the live render
   *  passes to viewer.addTiledImage. Use as-is when re-loading the pyramid. */
  minX: number;
  minY: number;
  /** OSD width of the placed image (= compositeW * scale). */
  osdWidth: number;
  /** Nearest-neighbour factor OSD applies on display. The 10x upscale + bg
   *  composite happens downstream in build-daily-seed-images.cjs. */
  scale: number;
  compositeW: number;
  compositeH: number;
  /** PNG bytes (base64) of the native overlay composite. */
  small: string;
  /** PNG bytes (base64) of the per-pixel biome-bg index mask, at the same
   *  scale as `small`. RGB encodes a biome index (look up in biomeIndex);
   *  alpha=255 means "use that biome's bg PNG", alpha=0 means "outside biome —
   *  transparent, let static bg show through". Only present for pvt=0 (main
   *  world); heaven/hell regions skip the mask and emit transparent gaps. */
  mask?: string;
}

export interface BiomeRegionExportResult {
  /** Per-region output. */
  regions: BiomeRegionImage[];
  /** Biome-index lookup: index -> biome bg PNG filename (basename of
   *  noitamap/public/biome_bg/<filename>). Indices are RGB-encoded in the
   *  per-region mask PNGs. Stable across one bake's regions. */
  biomeIndex: Record<number, string>;
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as any);
  }
  return btoa(bin);
}

// ─── Decoration bake export (pixel scenes + POI marker sprites) ─────────────
//
// The bake page calls prepareDecorationExport() once (builds the full draw
// list: every scene composite + every marker sprite at world coords), then
// exportDecorationCell() per non-empty 2048px grid cell. The node compositor
// alpha-blends the cells onto the upscaled region fulls before stitching, so
// the deployed pyramids carry scenes + creatures in their pixels and the live
// map skips both visual layers entirely (clicks keep working off the spatial
// index; see renderGenerationResult's decorBaked path).

interface DecorDraw {
  img: CanvasImageSource;
  // Optional spritesheet source rect (markers); scenes draw the full bitmap.
  sx?: number;
  sy?: number;
  sw?: number;
  sh?: number;
  x: number;
  y: number;
  w: number;
  h: number;
  // Taikasauva ("alive") wands draw rotated 90deg CCW (tip-up -> tip-left).
  rot?: boolean;
}
const DECOR_CELL = 2048;
let _decorDraws: DecorDraw[] | null = null;

export async function prepareDecorationExport(
  result: GenerationResult,
  dependencies: DecorationExportDependencies,
  includeScenes = true
): Promise<{ cellSize: number; cells: { cx: number; cy: number }[]; mimicSpritesVersion: number } | null> {
  const draws: DecorDraw[] = [];

  // 1. Pixel scenes (z-order below markers, so pushed first).
  const decorationResult = includeScenes ? result : {
    ...result,
    pixelScenesByPW: Object.fromEntries(Object.entries(result.pixelScenesByPW).map(([key, scenes]) =>
      [key, scenes.filter(scene => scene.key.startsWith('static_tile/'))])),
  };
  const built = await dependencies.buildSceneBitmaps(decorationResult);
  if (!built) return null;
  for (const scene of built.validScenes) {
    const bmp = built.bitmapByKey.get(dependencies.sceneRenderKey(scene));
    if (!bmp) continue;
    draws.push({ img: bmp, x: scene.x, y: scene.y, w: scene.width, h: scene.height });
  }
  const sceneCount = draws.length;

  // 2. POI marker sprites. Mirrors marker-tile-source.ts at drawScale=1 with
  // no spoiler scrub (bake is always full-detail; spoiler-free is disabled on
  // baked seeds client-side).
  const md = await buildMarkerData(result);
  for (const item of md.items) {
    const keys = Array.isArray(item.spriteKey) ? item.spriteKey : [item.spriteKey];
    const isTaikasauva = !!(item.poi && (item.poi as any).isTaikasauva);
    let isMain = true;
    let rootOX = 0,
      rootOY = 0;
    for (const k of keys) {
      const a = md.atlas[k];
      if (!a) continue;
      if (isMain) {
        isMain = false;
        rootOX = a.ox ?? item.w / 2;
        rootOY = a.oy ?? item.h / 2;
      }
      // Same math as the tile source: layer top-left = marker centre minus the
      // root layer's origin (per-layer l_ox cancels out at drawScale=1).
      draws.push({
        img: md.spritesheet,
        sx: a.x,
        sy: a.y,
        sw: a.w,
        sh: a.h,
        x: item.osdX - rootOX,
        y: item.osdY - rootOY,
        w: a.w,
        h: a.h,
        rot: isTaikasauva,
      });
    }
  }
  _decorDraws = draws;

  // Non-empty cells on the absolute world grid (cell x0 = cx * DECOR_CELL).
  const cellSet = new Set<string>();
  for (const d of draws) {
    const cx0 = Math.floor(d.x / DECOR_CELL),
      cx1 = Math.floor((d.x + d.w - 1) / DECOR_CELL);
    const cy0 = Math.floor(d.y / DECOR_CELL),
      cy1 = Math.floor((d.y + d.h - 1) / DECOR_CELL);
    for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) cellSet.add(`${cx},${cy}`);
  }
  const cells = [...cellSet].map(s => {
    const [cx, cy] = s.split(',').map(Number);
    return { cx, cy };
  });
  console.log(
    `[OSD Bridge] Decor export prepared: ${sceneCount} scenes + ${draws.length - sceneCount} sprite layers, ${cells.length} cells`
  );
  return { cellSize: DECOR_CELL, cells, mimicSpritesVersion: MIMIC_SPRITES_VERSION };
}

/** Render one decor grid cell; returns a PNG data URL or null when empty. */
export function exportDecorationCell(cx: number, cy: number): string | null {
  if (!_decorDraws) return null;
  const x0 = cx * DECOR_CELL,
    y0 = cy * DECOR_CELL;
  const hits = _decorDraws.filter(
    d => d.x < x0 + DECOR_CELL && d.x + d.w > x0 && d.y < y0 + DECOR_CELL && d.y + d.h > y0
  );
  if (hits.length === 0) return null;
  const canvas = document.createElement('canvas');
  canvas.width = DECOR_CELL;
  canvas.height = DECOR_CELL;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  for (const d of hits) {
    if (d.sw !== undefined) {
      if (d.rot) {
        const cx = d.x - x0 + d.w / 2;
        const cy = d.y - y0 + d.h / 2;
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(-Math.PI / 2); // tip-up -> tip-left
        ctx.drawImage(d.img, d.sx!, d.sy!, d.sw!, d.sh!, -d.w / 2, -d.h / 2, d.w, d.h);
        ctx.restore();
      } else {
        ctx.drawImage(d.img, d.sx!, d.sy!, d.sw!, d.sh!, d.x - x0, d.y - y0, d.w, d.h);
      }
    } else {
      ctx.drawImage(d.img, d.x - x0, d.y - y0, d.w, d.h);
    }
  }
  return canvas.toDataURL('image/png');
}

export function releaseDecorationExport(): void {
  _decorDraws = null;
}

/**
 * Re-render the 9 biome regions (3 horizontal PWs × 3 verticals: main/heaven/
 * hell) for a finished generation, plus per-region biome-bg masks (main world
 * only) so a downstream Node compositor can stamp the live map's biome
 * backgrounds in at native scale before stitching. Heaven/hell regions get a
 * solid black bg downstream (matches the live map, which doesn't paint biome
 * bgs in those planes). Empty regions are skipped and logged.
 */
export async function exportBiomeRegionImages(
  result: GenerationResult,
  dependencies: BiomeRegionExportDependencies
): Promise<BiomeRegionExportResult> {
  const { biomeRenderOrder: BIOME_RENDER_ORDER, createTileOverlays: createTileOverlaysCheap } = dependencies;

  const { tileLayers, biomeData, isNGP, worldCenter, parallelWorlds } = result;
  const w = isNGP ? 72 : 70;
  const pwOffsetPixels = w * 512;
  const pws = parallelWorlds || [-1, 0, 1];
  const pwOrder = [...pws].sort((a, b) => {
    if (a === 0) return -1;
    if (b === 0) return 1;
    return b - a;
  });

  const layerIndicesByBiome = new Map<string, number[]>();
  for (let i = 0; i < tileLayers.length; i++) {
    const layer = tileLayers[i];
    if (layer.biomeName) {
      const arr = layerIndicesByBiome.get(layer.biomeName);
      if (arr) arr.push(i);
      else layerIndicesByBiome.set(layer.biomeName, [i]);
    }
  }
  const orderedBiomes = BIOME_RENDER_ORDER.filter(b => !SKIP_BIOMES.has(b));
  const orderedSet = new Set<string>(orderedBiomes);
  const unorderedBiomes: string[] = [];
  for (const [biomeName] of layerIndicesByBiome) {
    if (!orderedSet.has(biomeName) && !SKIP_BIOMES.has(biomeName)) unorderedBiomes.push(biomeName);
  }
  const allBiomesToRender = [...orderedBiomes, ...unorderedBiomes];

  const anchorY = -(14 * 512);
  const pvtList = [0, -1, 1].filter(pvt => {
    if (pvt < 0 && !biomeData.heavenPixels) return false;
    if (pvt > 0 && !biomeData.hellPixels) return false;
    return true;
  });

  // Load the static-map biome boundary polygons (same source the live bg
  // renderer uses). Polygons live in static-map coords:
  //   gx = svgX * CHUNK_SIZE + MAP_TOP_LEFT_X
  //   gy = svgY * CHUNK_SIZE + BIOME_IMAGE_TOP_Y
  // Per pw the bg translates by pw * pwOffsetPixels horizontally.
  const boundaryData = (await import('../data/biome_boundries_py.json')).default as any;
  const biomesWithBg = (boundaryData?.biomes ?? []).filter(
    (b: any) => b.filename && BIOME_BACKGROUND_MAP[b.filename] && !SKIP_BIOMES.has(b.filename)
  );
  // Stable index assignment: each biome's `filename` -> integer index ≥ 1.
  // 0 is reserved for "no biome" (alpha=0 in the mask).
  const biomeIndex: Record<number, string> = {};
  const indexByFilename = new Map<string, number>();
  biomesWithBg.forEach((b: any, i: number) => {
    const idx = i + 1;
    indexByFilename.set(b.filename, idx);
    // Value is the bg PNG basename so the Node side can fetch
    // noitamap/public/biome_bg/<file>.
    const bgPath = BIOME_BACKGROUND_MAP[b.filename];
    biomeIndex[idx] = bgPath.split('/').pop() || bgPath;
  });

  const CHUNK = 512;
  const MAP_TOP_LEFT_X = -17920;
  const BIOME_IMAGE_TOP_Y = -14 * CHUNK;

  // Fold POI marker extents into region bounds. Region X/Y come only from biome
  // tile overlays, but markers are baked into decor cells at absolute world
  // coords and the upscale compositor only samples decor inside [minX, maxX) x
  // [minY, maxY). A marker past the biome edge (e.g. the gun_room "It's a wand,
  // ok?" experimental wand at x~16121, east of pw=0's biome edge ~15870 and west
  // of pw=1's ~18940) lands in an inter-region gap and is clipped from the baked
  // DZI on every bake — even though the live map shows it (markers are a separate
  // OSD layer there). Group marker extents by world column (round(osdX/stride))
  // so a cross-column POI misfiled into another pw's poisByPW bucket expands the
  // region it actually sits in, never balloons a wrong region or double-draws.
  const markerBoundsByCol = new Map<number, { minX: number; minY: number; maxX: number; maxY: number }>();
  try {
    const md = await buildMarkerData(result);
    for (const it of md.items) {
      const col = Math.round(it.osdX / pwOffsetPixels);
      const l = it.osdX - it.w / 2,
        r = it.osdX + it.w / 2;
      const t = it.osdY - it.h / 2,
        b = it.osdY + it.h / 2;
      const cur = markerBoundsByCol.get(col);
      if (cur) {
        if (l < cur.minX) cur.minX = l;
        if (r > cur.maxX) cur.maxX = r;
        if (t < cur.minY) cur.minY = t;
        if (b > cur.maxY) cur.maxY = b;
      } else {
        markerBoundsByCol.set(col, { minX: l, minY: t, maxX: r, maxY: b });
      }
    }
  } catch (e) {
    console.warn('[export] marker-bounds fold skipped:', e);
  }

  const out: BiomeRegionImage[] = [];

  for (const pw of pwOrder) {
    for (const pvt of pvtList) {
      const overlays: (OffscreenCanvas | null)[] = createTileOverlaysCheap(biomeData, tileLayers, pw, pvt, isNGP);

      let minX = Infinity,
        minY = Infinity,
        maxX = -Infinity,
        maxY = -Infinity;
      const validOverlays: { overlay: OffscreenCanvas; x: number; y: number }[] = [];
      for (const biomeName of allBiomesToRender) {
        const layerIdxArr = layerIndicesByBiome.get(biomeName);
        if (!layerIdxArr) continue;
        for (const layerIdx of layerIdxArr) {
          const overlay = overlays[layerIdx];
          if (!overlay || overlay.width === 0 || overlay.height === 0) continue;
          const layer = tileLayers[layerIdx];
          const x = -(worldCenter * 512) + pw * pwOffsetPixels + layer.correctedX;
          const y = anchorY + layer.correctedY + pvt * 24576;
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x + overlay.width * 10);
          maxY = Math.max(maxY, y + overlay.height * 10);
          validOverlays.push({ overlay, x, y });
        }
      }
      if (validOverlays.length === 0) {
        console.warn(`[export] skipped empty region pw=${pw} pvt=${pvt}`);
        continue;
      }

      // Expand to cover markers in this pw's world column so decor sprites past
      // the biome edge (inter-region gaps) aren't clipped from the baked DZI.
      // Markers only sit on the main plane (pvt=0); heaven/hell bands carry no
      // decor at the markers' Y, so widening them would just grow the canvas.
      const mb = pvt === 0 ? markerBoundsByCol.get(pw) : undefined;
      if (mb) {
        if (mb.minX < minX) minX = mb.minX;
        if (mb.maxX > maxX) maxX = mb.maxX;
        if (mb.minY < minY) minY = mb.minY;
        if (mb.maxY > maxY) maxY = mb.maxY;
      }

      const compositeW = Math.ceil((maxX - minX) / 10);
      const compositeH = Math.ceil((maxY - minY) / 10);
      const compositeCanvas = new OffscreenCanvas(compositeW, compositeH);
      const compositeCtx = compositeCanvas.getContext('2d')!;
      for (const { overlay, x, y } of validOverlays) {
        compositeCtx.drawImage(overlay, Math.round((x - minX) / 10), Math.round((y - minY) / 10));
      }

      const smallData = compositeCtx.getImageData(0, 0, compositeW, compositeH);
      // Force overlay alpha to binary (0/255 with 128 threshold). The overlay
      // bitmaps from createTileOverlaysCheap can carry soft-alpha edge pixels
      // which blend badly when the upscale step composites biome bgs
      // underneath. Snapping alpha kills the fringe at the source. The final
      // flatten-to-opaque-black happens later, in upscalePngWithBg, AFTER the
      // bgs are baked underneath.
      for (let i = 3; i < smallData.data.length; i += 4) {
        smallData.data[i] = smallData.data[i] >= 128 ? 255 : 0;
      }
      const osdWidth = compositeW * 10;
      const scale = osdWidth / compositeW;
      const small = await blobToBase64(await rgbaToPngBlob(smallData.data, compositeW, compositeH));

      // Per-region biome-index mask. Main world only — biome polygons are
      // anchored to the static-map (boundary JSON only covers main-world
      // biomes), so heaven/hell skip the mask and emit transparent gaps.
      let mask: string | undefined;
      if (pvt === 0) {
        const maskCanvas = new OffscreenCanvas(compositeW, compositeH);
        const maskCtx = maskCanvas.getContext('2d')!;
        // Translate biome-polygon static-map coords into this region's local
        // (compositeW, compositeH) space. The region's top-left is (minX, minY)
        // in OSD coords; biomes' static-map gx/gy translate by pw horizontally.
        const pwShift = pw * pwOffsetPixels;
        for (const biome of biomesWithBg) {
          const idx = indexByFilename.get(biome.filename);
          if (!idx) continue;
          const rawParts = (biome.svg_map_path as string).split(' ');
          maskCtx.beginPath();
          let prev: string | null = null;
          for (let j = 0; j < rawParts.length; j++) {
            const part = rawParts[j];
            if (part === 'M' || part === 'L' || part === 'Z') {
              if (part === 'Z') maskCtx.closePath();
              prev = part;
              continue;
            }
            const xVal = Number(part);
            const yPart = rawParts[j + 1];
            if (yPart === undefined) break;
            const yVal = Number(yPart);
            const gx = xVal * CHUNK + MAP_TOP_LEFT_X + pwShift;
            const gy = yVal * CHUNK + BIOME_IMAGE_TOP_Y;
            // Convert to local mask coords (1px = 10 OSD units).
            const cx = (gx - minX) / 10;
            const cy = (gy - minY) / 10;
            if (prev === 'M') maskCtx.moveTo(cx, cy);
            else maskCtx.lineTo(cx, cy);
            j++; // skip the y part we just consumed
            prev = 'L';
          }
          maskCtx.fillStyle = `rgb(${(idx >> 16) & 0xff}, ${(idx >> 8) & 0xff}, ${idx & 0xff})`;
          maskCtx.fill();
        }
        // Keep the mask only where some terrain overlay actually covers. The
        // wang layers are laid out at 510 px per chunk (tile_generator.js
        // correctedX: 51 tiles x 10 px), so every layer ends a few px short
        // of the chunk grid the biome polygons follow. The live map never
        // notices — the static base map shows through the strip — but the
        // bake paints raw biome background wherever "inside polygon, overlay
        // transparent", which turned every such strip into a dark chunk-
        // aligned line. Dropping the mask there makes the strip transparent,
        // matching what the live map shows.
        const coverage = new OffscreenCanvas(compositeW, compositeH);
        const covCtx = coverage.getContext('2d')!;
        covCtx.fillStyle = '#fff';
        for (const { overlay, x, y } of validOverlays) {
          covCtx.fillRect(Math.round((x - minX) / 10), Math.round((y - minY) / 10), overlay.width, overlay.height);
        }
        maskCtx.globalCompositeOperation = 'destination-in';
        maskCtx.drawImage(coverage, 0, 0);
        maskCtx.globalCompositeOperation = 'source-over';
        const maskData = maskCtx.getImageData(0, 0, compositeW, compositeH);
        // Force alpha to 255 wherever any biome was painted, 0 elsewhere — so
        // the Node side has a clean alpha=255 / alpha=0 mask with no
        // antialiased edges. (Canvas2D may have anti-aliased polygon edges.)
        for (let i = 0; i < maskData.data.length; i += 4) {
          const any = maskData.data[i] | maskData.data[i + 1] | maskData.data[i + 2];
          maskData.data[i + 3] = any ? 255 : 0;
        }
        mask = await blobToBase64(await rgbaToPngBlob(maskData.data, compositeW, compositeH));
      }

      out.push({
        pw,
        pvt,
        minX: Math.round(minX),
        minY: Math.round(minY),
        osdWidth,
        scale,
        compositeW,
        compositeH,
        small,
        mask,
      });
    }
  }

  return { regions: out, biomeIndex };
}

