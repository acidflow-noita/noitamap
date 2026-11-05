/** Rebuild the captured-base liquid mask from authored materials and the native
 * generator. This is an offline build: no rendered RGB, browser, or game process.
 * Run: node --import tsx build_scripts/build-static-liquid-masks.mts
 * After reviewing changed sources, add --refresh-provenance to accept hashes. */
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import JSZip from 'jszip';
import { decodePngToRgba } from '../src/telescope/png-decode.ts';
import { encodeLiquidMask, decodeLiquidMask, maskBlock, paintMaskBlock, type LiquidMaskBlock } from '../src/liquids/mask-codec.ts';
import { liquidMaterialIds } from '../src/liquids/materials.ts';
import { BIOME_ENGINE, MATERIAL_NAMES_BY_ID, WANG_COLOR_TO_ID } from '../lib/noita-telescope-vm/js/engine_resolve/engine_data.js';
import { computeMaterialNoiseDensity, selectComponentForCell } from '../lib/noita-telescope-vm/js/engine_resolve/band_select.js';
import { createMaterialField } from '../lib/noita-telescope-vm/js/engine_resolve/material_field.js';
import { resolveCellFull } from '../lib/noita-telescope-vm/js/engine_resolve/chunk_wobble.js';
import { NollaPrng } from '../lib/noita-telescope-vm/js/nolla_prng.js';
import {
  BIOME_BACKGROUND_MAP, STATIC_TERRAIN_BIOMES, WORLD_HEIGHT, WORLD_TOP,
  createPlaneOwnership, createBackgroundOwnership,
} from '../src/telescope/terrain-policy.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = resolve(ROOT, 'src/liquids/static-sources.json');
const OUTPUT = resolve(ROOT, 'src/liquids/assets/static-mask.bin.gz');
const RESERVATIONS = resolve(ROOT, 'src/liquids/assets/captured-fluid-reservations.json');
const BLOCK = 512;
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const engineByColor = new Map(BIOME_ENGINE.map((b: any) => [b.color & 0xffffff, b]));
const wangIds = new Map<number, number>(WANG_COLOR_TO_ID as [number, number][]);

type Pixels = ReturnType<typeof decodePngToRgba>;
type Placement = { key: string; x: number; y: number; biomeColor?: number; substitutions?: Record<string, string> };
type SourceCheck = { path: string; archive?: string; sha256: string };

export interface CapturedFluidReservation {
  x: number; y: number; width: number; height: number; runs: number[];
}

export function capturedFluidReservationPolicyFingerprint() {
  return hash(JSON.stringify({ backgrounds: BIOME_BACKGROUND_MAP,
    staticBiomes: [...STATIC_TERRAIN_BIOMES].sort(), width: 70,
    worldTop: WORLD_TOP, worldHeight: WORLD_HEIGHT }));
}

/** Retain only fixed fluid pixels that native terrain or biome backgrounds
 * can cover. Native ownership uses actual generated layer claims; the separate
 * biome-background path also uses its documented non-static background map.
 * Vertical planes use the normal map's repeated first/last row, exactly as the
 * generator does. Large captured Lake/lava regions have neither claim.
 *
 * Work on sparse runs, splitting at biome-chunk boundaries. Crop each result to
 * nonzero bounds so consumers allocate bits for the narrow overlaps only. */
export function capturedFluidReservations(blocks: readonly LiquidMaskBlock[], world: any): CapturedFluidReservation[] {
  const { layers, biomeData, GENERATOR_CONFIG: config, W: width } = world;
  if (width !== 70 || biomeData.pixels.length !== width * 48)
    throw new Error('Captured fluid reservations require the normal 70-column biome map');
  const nameByColor = new Map<number, string>(Object.entries(config).map(([name, value]: [string, any]) =>
    [value.color & 0xffffff, name] as [number, string]));
  const repeatedRow = (row: number) => {
    const pixels = new Uint32Array(biomeData.pixels.length);
    for (let y = 0; y < 48; y++) pixels.set(biomeData.pixels.subarray(row * width, (row + 1) * width), y * width);
    return pixels;
  };
  const planes = new Map([-1, 0, 1].map(plane => {
    const pixels = plane < 0 ? biomeData.heavenPixels ?? repeatedRow(0)
      : plane > 0 ? biomeData.hellPixels ?? repeatedRow(47) : biomeData.pixels;
    const terrain = createPlaneOwnership(layers, biomeData.pixels, pixels, config, width);
    const background = createBackgroundOwnership(terrain, pixels, config, plane as -1 | 0 | 1);
    return [plane, { pixels, terrain, background }] as const;
  }));
  const claimCache = new Map<string, boolean>();
  const canPaint = (x: number, y: number) => {
    const key = `${Math.floor(x / BLOCK)},${Math.floor(y / BLOCK)}`;
    if (claimCache.has(key)) return claimCache.get(key)!;
    const plane = Math.floor((y - WORLD_TOP) / WORLD_HEIGHT), state = planes.get(plane);
    if (!state) return false;
    const localY = y - plane * WORLD_HEIGHT;
    const cx = ((Math.floor((x + width * 256) / BLOCK) % width) + width) % width;
    const cy = Math.floor((localY - WORLD_TOP) / BLOCK);
    const name = nameByColor.get(state.pixels[cy * width + cx] & 0xffffff);
    const backgroundOwner = state.background.at(x, localY);
    const claims = state.terrain.at(x, localY) >= 0 ||
      (backgroundOwner >= 0 && !!BIOME_BACKGROUND_MAP[state.background.names[backgroundOwner]]) ||
      (!!name && !!BIOME_BACKGROUND_MAP[name] && !STATIC_TERRAIN_BIOMES.has(name));
    claimCache.set(key, claims);
    return claims;
  };
  const chunks = new Map<string, { x: number; y: number; runs: number[][] }>();
  for (const block of blocks) for (let p = 0; p < block.runs.length; p += 3) {
    const y = block.y + block.runs[p], end = block.x + block.runs[p + 1] + block.runs[p + 2];
    for (let x = block.x + block.runs[p + 1]; x < end;) {
      const cx = Math.floor(x / BLOCK) * BLOCK, cy = Math.floor(y / BLOCK) * BLOCK;
      const next = Math.min(end, cx + BLOCK);
      if (canPaint(x, y)) {
        const key = `${cx},${cy}`;
        let chunk = chunks.get(key);
        if (!chunk) { chunk = { x: cx, y: cy, runs: [] }; chunks.set(key, chunk); }
        chunk.runs.push([y - cy, x - cx, next - x]);
      }
      x = next;
    }
  }
  const out: CapturedFluidReservation[] = [];
  for (const chunk of chunks.values()) {
    const merged: number[][] = [];
    for (const run of chunk.runs.sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
      const last = merged.at(-1);
      if (last && last[0] === run[0] && last[1] + last[2] >= run[1])
        last[2] = Math.max(last[1] + last[2], run[1] + run[2]) - last[1];
      else merged.push([...run]);
    }
    let x0 = BLOCK, x1 = 0;
    for (const run of merged) { x0 = Math.min(x0, run[1]); x1 = Math.max(x1, run[1] + run[2]); }
    const y0 = merged[0][0], y1 = merged.at(-1)![0] + 1;
    out.push({ x: chunk.x + x0, y: chunk.y + y0, width: x1 - x0, height: y1 - y0,
      runs: merged.flatMap(([row, start, length]) => [row - y0, start - x0, length]) });
  }
  return out.sort((a, b) => a.y - b.y || a.x - b.x);
}

/** The volcanic-lake surface's authored polygon is an axis-aligned rectangle
 * in chunk-normalized coordinates. Reject other shapes rather than silently
 * treating an unsupported polygon as a full liquid chunk. Native selection
 * samples integer world coordinates modulo 512, divided by 512, without a
 * half-pixel shift. Its ray crossing excludes the left/top polygon boundary
 * and includes right/bottom (0x0086d325..0x0086d378, 0x00ddc9a0). */
export function rectangularPolygonMask(xml: string): Uint8Array {
  const polygon = /<polygon\b[^>]*>([\s\S]*?)<\/polygon>/.exec(xml)?.[1];
  if (!polygon) throw new Error('Invalid source polygon');
  const points = [...polygon.matchAll(/<Vec2\b([^>]*)\/?\s*>/g)].map(m => {
    const attrs = Object.fromEntries([...m[1].matchAll(/(x|y)\s*=\s*"([^"]+)"/g)].map(a => [a[1], Number(a[2])]));
    return [attrs.x, attrs.y];
  });
  const xs = [...new Set(points.map(p => p[0]))].sort((a, b) => a - b);
  const ys = [...new Set(points.map(p => p[1]))].sort((a, b) => a - b);
  if (points.length !== 4 || !points.flat().every(Number.isFinite) || xs.length !== 2 || ys.length !== 2 || xs[0] !== 0 || xs[1] !== 1 ||
    ys[0] < 0 || ys[1] !== 1 || new Set(points.map(p => p.join(','))).size !== 4)
    throw new Error('Static liquid polygon is no longer the supported full-width rectangle');
  const pixels = new Uint8Array(BLOCK * BLOCK);
  for (let y = Math.floor(Math.fround(ys[0]) * BLOCK) + 1; y < BLOCK; y++)
    pixels.fill(1, y * BLOCK + 1, (y + 1) * BLOCK);
  return pixels;
}

/** Source PNG black is an instruction to leave the previous material intact.
 * Force air, solids, and unknown spawn pixels clear previous liquid coverage.
 * Gray is density, not a material color. Substitutions stay in Wang color space. */
export function sceneMaterialAt(source: Pixels, p: number, scene: Placement,
  biomeAt: (x: number, y: number) => number): number | null {
  const i = p * 4;
  if (!source.data[i + 3]) return null;
  let rgb = (source.data[i] << 16) | (source.data[i + 1] << 8) | source.data[i + 2];
  if (!rgb) return null;
  for (const [from, to] of Object.entries(scene.substitutions ?? {}))
    if (rgb === parseInt(from, 16)) rgb = parseInt(to, 16);
  if (rgb === 0x42) return 0;
  const r = rgb >>> 16, g = (rgb >>> 8) & 255, b = rgb & 255;
  if (r === g && g === b) {
    const x = scene.x + p % source.width, y = scene.y + Math.floor(p / source.width);
    const biome = engineByColor.get(scene.biomeColor ?? biomeAt(x, y));
    return biome?.bands.length
      ? selectComponentForCell(biome, x, y, computeMaterialNoiseDensity(x, y, 1))
      : -1;
  }
  return wangIds.get(rgb) ?? -1;
}

/** Sparse tile store also applies later scene solids/air as erasures. A union
 * of liquid-only source masks would wobble the rock of overlapping scenes. */
export class StaticMaskBuilder {
  blocks = new Map<string, LiquidMaskBlock>();
  set(x: number, y: number, pixels: Uint8Array) {
    const key = `${x},${y}`, block = maskBlock(x, y, BLOCK, BLOCK, pixels);
    if (block) this.blocks.set(key, block); else this.blocks.delete(key);
  }
  stamp(source: Pixels, scene: Placement, eligible: Set<number>, biomeAt: (x: number, y: number) => number) {
    for (let y = Math.floor(scene.y / BLOCK) * BLOCK; y < scene.y + source.height; y += BLOCK)
      for (let x = Math.floor(scene.x / BLOCK) * BLOCK; x < scene.x + source.width; x += BLOCK) {
        const old = this.blocks.get(`${x},${y}`), pixels = new Uint8Array(BLOCK * BLOCK);
        if (old) paintMaskBlock(old, pixels, x, y, BLOCK, BLOCK, 1);
        for (let sy = Math.max(0, y - scene.y); sy < Math.min(source.height, y + BLOCK - scene.y); sy++)
          for (let sx = Math.max(0, x - scene.x); sx < Math.min(source.width, x + BLOCK - scene.x); sx++) {
            const id = sceneMaterialAt(source, sy * source.width + sx, scene, biomeAt);
            if (id !== null) pixels[(scene.y + sy - y) * BLOCK + scene.x + sx - x] = eligible.has(id) ? 1 : 0;
          }
        this.set(x, y, pixels);
      }
  }
  finish() { return [...this.blocks.values()].sort((a, b) => a.y - b.y || a.x - b.x); }
}

export function fixedScenePlacements(manifest: any, biomePixels: Uint32Array, width: number): Placement[] {
  const scenes: Placement[] = [...manifest.splicedScenes];
  for (const pw of manifest.capture.parallelWorlds) {
    for (const rule of manifest.biomeScenes) {
      const colors = new Set(rule.colors.map((c: string) => parseInt(c, 16)));
      for (let p = 0; p < biomePixels.length; p++) {
        const color = biomePixels[p] & 0xffffff;
        if (!colors.has(color)) continue;
        const x = (p % width) * BLOCK - width * 256 + pw * manifest.capture.worldWidth;
        const y = (Math.floor(p / width) - 14) * BLOCK;
        scenes.push({ key: y === rule.crackedAtY ? rule.crackedKey : rule.key,
          x: x + (rule.offsetX ?? 0), y: y + (rule.offsetY ?? 0), biomeColor: color });
      }
    }
    const hm = manifest.holyMountains, rng = new NollaPrng(0);
    const topColors = new Set([0x6dcb28, 0x93cb4c, 0x93cb4d, 0x93cb4e, 0x93cb4f, 0x93cb5a, 0x5a9628]);
    for (let n = 0; n < hm.depthChunks.length; n++) for (let j = 0; j < hm.widthChunks[n]; j++) {
      const cx = hm.startChunks[n] + j, y = hm.depthChunks[n] * BLOCK;
      const color = biomePixels[(hm.depthChunks[n] + 14) * width + cx + width / 2] & 0xffffff;
      if (!topColors.has(color)) continue;
      const x = cx * BLOCK + pw * manifest.capture.worldWidth;
      rng.SetRandomSeed(manifest.capture.materialSeed, x, y);
      const suffix = y > 12000 ? '_ending' : ({ 5: '_water', 8: '_blood', 11: '_oil', 13: '_radioactive', 15: '_lava' } as Record<number, string>)[rng.Random(1, 50)] ?? '';
      scenes.push({ key: `temple/altar_top${suffix}`, x, y: y + hm.offsetY, biomeColor: color });
    }
  }
  return [...scenes, ...manifest.fixedScenes];
}

/** Run the source marker scanner for captured biomes whose scenes the live map
 * deliberately preserves. The capture's pyramid has stair markers only, but
 * deriving that result is safer than assuming every possible room was absent. */
export async function capturedSpawnedScenePlacements(manifest: any, world: any): Promise<Placement[]> {
  const pixelScenes = await import('../lib/noita-telescope-vm/js/pixel_scene_generation.js');
  const sceneData = pixelScenes.PIXEL_SCENE_DATA as Record<string, any>;
  const sceneSpawns = pixelScenes.PIXEL_SCENE_SPAWN_DATA as Record<string, any[]>;
  const meta = JSON.parse(await readFile(resolve(ROOT, 'lib/noita-telescope-vm/data/pixel_scene_meta.json'), 'utf8')).scenes;
  for (const [key, m] of Object.entries(meta) as [string, any][]) {
    sceneData[key] ??= { ...m, key, name: key.split('/').at(-1), isCosmetic: false };
    sceneSpawns[key] ??= Array.from({ length: m.spawns.length / 3 }, (_, p) => ({
      sourceBiome: key.split('/')[0], x: m.spawns[p * 3], y: m.spawns[p * 3 + 1], spawnFunctionIndex: m.spawns[p * 3 + 2],
    }));
  }
  const { prescanSpawnFunctions, scanSpawnFunctions } = await import('../lib/noita-telescope-vm/js/poi_scanner.js');
  const { BIOME_SPAWN_FUNCTION_MAP } = await import('../lib/noita-telescope-vm/js/spawn_function_config.js');
  const spawnFunctions = BIOME_SPAWN_FUNCTION_MAP as Record<string, { funcName: string }[]>;
  const targets = new Set(manifest.spawnedBiomes ?? []);
  const markers = prescanSpawnFunctions(world.layers.filter((l: any) => targets.has(l.biomeName)), false)
    .filter((s: any) => spawnFunctions[s.sourceBiome][s.spawnFunctionIndex].funcName.startsWith('load_pixel_scene'));
  const out: Placement[] = [];
  for (const pw of manifest.capture.parallelWorlds) {
    const result = scanSpawnFunctions(world.biomeData, markers, manifest.capture.materialSeed, 0, pw, 0, false, {}, 'normal');
    for (const scene of result.finalPixelScenes) {
      const substitutions = Object.fromEntries((scene.variantKey ?? '').split('&')
        .filter((part: string) => part.includes('=') && !part.startsWith('biome='))
        .map((part: string) => part.split('=')));
      out.push({ key: manifest.sceneAliases?.[scene.key] ?? scene.key, x: scene.x, y: scene.y,
        biomeColor: world.GENERATOR_CONFIG[scene.biome]?.color & 0xffffff, substitutions });
    }
  }
  return out;
}

async function inputs(manifest: any) {
  const archiveBytes = await readFile(resolve(ROOT, manifest.materialArchive));
  const zip = await JSZip.loadAsync(archiveBytes);
  const xml = await zip.file(manifest.materialPath)?.async('string');
  if (!xml) throw new Error(`Missing ${manifest.materialPath}`);
  const sources = new Map<string, Pixels>(), checks: SourceCheck[] = [];
  const polygons = new Map<number, Uint8Array>();
  const addFile = async (path: string) => {
    const bytes = await readFile(resolve(ROOT, path));
    checks.push({ path, sha256: hash(bytes) }); return bytes;
  };
  const keys = new Set<string>([...manifest.splicedScenes, ...manifest.biomeScenes, ...manifest.fixedScenes]
    .flatMap((s: any) => [s.key, ...(s.crackedKey ? [s.crackedKey] : [])]));
  for (const key of manifest.holyMountains.sources) keys.add(key);
  for (const key of Object.values(manifest.sceneAliases ?? {}) as string[]) keys.add(key);
  for (const key of [...keys].sort()) {
    const bytes = await addFile(`${manifest.sceneRoot}/${key}.png`);
    sources.set(key, decodePngToRgba(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)));
  }
  await addFile(manifest.biomeMap);
  for (const path of [...['engine_data', 'material_field', 'lattice_builder', 'topo0_resolve', 'topo2_resolve',
    'band_select', 'bitmap_caves', 'carve_noise', 'chunk_wobble', 'perlin_noise', 'simplex_noise'].map(n => `js/engine_resolve/${n}.js`),
    ...['tile_generator', 'nolla_prng', 'generator_config', 'biome_generator', 'biome_hacks', 'pathfinding', 'constants', 'stbhw',
      'poi_scanner', 'spawn_functions', 'spawn_function_config', 'pixel_scene_generation', 'pixel_scene_config', 'utils'].map(n => `js/${n}.js`),
    'test/helpers/generate.mjs', 'data/pixel_scene_meta.json', 'data/wang_tiles/water.png', 'data/wang_tiles/pyramid.png',
    ...['watchtower', 'potion_mimics', 'darkness', 'boss', 'barren'].map(n => `data/wang_tiles/static/${n}_fg.png`)])
    await addFile(`lib/noita-telescope-vm/${path}`);
  await addFile('src/liquids/materials.ts');
  await addFile('build_scripts/build-static-liquid-masks.mts');
  for (const rule of manifest.polygonBiomes ?? []) {
    if (rule.material !== 'lava' || rule.coordinateSpace !== 'normalized-biome-chunk')
      throw new Error(`Unreviewed static polygon convention: ${rule.source}`);
    const text = await zip.file(rule.source)?.async('string');
    if (!text || !new RegExp(`material_name\\s*=\\s*"${rule.material}"`).test(text))
      throw new Error(`Missing source polygon material: ${rule.source}`);
    polygons.set(parseInt(rule.color, 16), rectangularPolygonMask(text));
  }
  for (const path of [manifest.materialPath, ...((manifest.polygonBiomes ?? []).map((r: any) => r.source)), 'data/scripts/biomes/temple_altar.lua',
    'data/scripts/biomes/temple_altar_left.lua', 'data/scripts/biomes/temple_altar_top_shared.lua',
    'data/scripts/biomes/pyramid.lua', 'data/biome/_pixel_scenes.xml']) {
    const bytes = await zip.file(path)?.async('uint8array');
    if (!bytes) throw new Error(`Missing source provenance: ${path}`);
    checks.push({ archive: manifest.materialArchive, path, sha256: hash(bytes) });
  }
  checks.sort((a, b) => `${a.archive ?? ''}/${a.path}`.localeCompare(`${b.archive ?? ''}/${b.path}`));
  return { sources, checks, polygons, eligible: liquidMaterialIds(xml, MATERIAL_NAMES_BY_ID) };
}

export async function buildStaticLiquidMasks(refreshProvenance = false) {
  const manifest = JSON.parse(await readFile(MANIFEST, 'utf8'));
  const { sources, checks, polygons, eligible } = await inputs(manifest);
  if (!refreshProvenance && JSON.stringify(checks) !== JSON.stringify(manifest.sourceChecks))
    throw new Error('Static liquid source provenance changed. Review the source geometry and use --refresh-provenance.');

  // Upstream's headless helper runs the same biome and Wang generators as live
  // rendering. Its canvas shims discard visual output; only material data is used.
  const { generate } = await import('../lib/noita-telescope-vm/test/helpers/generate.mjs');
  const world = await generate({ seed: manifest.capture.materialSeed });
  const { layers, biomeData, W, GENERATOR_CONFIG } = world;
  const field = createMaterialField(layers, biomeData, GENERATOR_CONFIG, W, manifest.capture.materialSeed);
  const bmap = { w: W, colorAt: (x: number, y: number) => biomeData.pixels[y * W + x] & 0xffffff };
  const edgeNoise = (color: number) => engineByColor.get(color)?.noiseBiomeEdges !== false;
  const allowed = new Set(manifest.topologyBiomes.map((n: string) => GENERATOR_CONFIG[n].color & 0xffffff));
  for (const color of polygons.keys()) allowed.add(color);
  const bounds = manifest.capture.bounds, store = new StaticMaskBuilder();
  const biomeAt = (x: number, y: number) => bmap.colorAt(((Math.floor((x + W * 256) / BLOCK) % W) + W) % W,
    Math.max(0, Math.min(47, Math.floor((y + 7168) / BLOCK))));
  const candidates = new Set<string>();
  for (let y = bounds.y; y < bounds.y + bounds.height; y += BLOCK)
    for (let x = bounds.x; x < bounds.x + bounds.width; x += BLOCK) {
      const color = biomeAt(x, y);
      if (!allowed.has(color)) continue;
      if ((color === 0x1133f1 || color === 0x11a3fc) && y + BLOCK <= 225) continue;
      for (let dy = edgeNoise(color) ? -1 : 0; dy <= (edgeNoise(color) ? 1 : 0); dy++)
        for (let dx = edgeNoise(color) ? -1 : 0; dx <= (edgeNoise(color) ? 1 : 0); dx++) {
          const tx = x + dx * BLOCK, ty = y + dy * BLOCK;
          if (tx >= bounds.x && tx < bounds.x + bounds.width && ty >= bounds.y && ty < bounds.y + bounds.height)
            candidates.add(`${tx},${ty}`);
        }
    }
  let completed = 0;
  const cell: any = {}, lavaId = MATERIAL_NAMES_BY_ID.indexOf('lava');
  for (const key of candidates) {
    const [x, y] = key.split(',').map(Number), pixels = new Uint8Array(BLOCK * BLOCK);
    const baseColor = biomeAt(x, y);
    // These authored non-wobbled biomes have one unconditional lava component.
    // Scene stamping below removes the egg, rooms, and other solid overlays.
    if (polygons.has(baseColor) && eligible.has(lavaId)) pixels.set(polygons.get(baseColor)!);
    else if ((baseColor === 0xff6a02 || baseColor === 0x9e4302) && eligible.has(lavaId)) pixels.fill(1);
    else for (let py = 0; py < BLOCK; py++) for (let px = 0; px < BLOCK; px++) {
      resolveCellFull(bmap, x + px, y + py, edgeNoise, cell);
      if (allowed.has(cell.color) && eligible.has(field.materialAt(x + px, y + py))) pixels[py * BLOCK + px] = 1;
    }
    store.set(x, y, pixels);
    if (++completed % 100 === 0) console.log(`[static liquids] Resolved ${completed}/${candidates.size} source blocks`);
  }
  const spawned = await capturedSpawnedScenePlacements(manifest, world);
  const placements = [...fixedScenePlacements(manifest, biomeData.pixels, W), ...spawned];
  for (const scene of placements) {
    const source = sources.get(scene.key);
    if (!source) throw new Error(`No material source for ${scene.key}`);
    store.stamp(source, scene, eligible, biomeAt);
  }
  const blocks = store.finish(), bytes = encodeLiquidMask(blocks);
  const restored = decodeLiquidMask(bytes);
  if (hash(encodeLiquidMask(restored)) !== hash(bytes)) throw new Error('Static mask round trip failed');
  manifest.sourceChecks = checks;
  manifest.coverage.spawnedSceneAudit = [...new Set(spawned.map(s => s.key))].sort().map(key => ({
    key, instances: spawned.filter(s => s.key === key).length,
  }));
  const compressed = gzipSync(bytes, { level: 9 });
  manifest.artifact = { path: 'src/liquids/assets/static-mask.bin.gz', sha256: hash(compressed),
    bytes: compressed.byteLength, rawBytes: bytes.byteLength, rawSha256: hash(bytes), blocks: blocks.length,
    liquidPixels: blocks.reduce((sum, block) => sum + [...block.runs].filter((_v, i) => i % 3 === 2).reduce((a, b) => a + b, 0), 0),
    placements: placements.length };
  const reservations = capturedFluidReservations(blocks, world);
  const reservationBytes = Buffer.from(JSON.stringify(reservations) + '\n');
  if (reservationBytes.byteLength > 100_000)
    throw new Error(`Captured fluid reservations unexpectedly exceed 100KB: ${reservationBytes.byteLength}`);
  manifest.capturedFluidReservations = {
    path: 'src/liquids/assets/captured-fluid-reservations.json', sha256: hash(reservationBytes),
    sourceMaskSha256: manifest.artifact.sha256, policySha256: capturedFluidReservationPolicyFingerprint(),
    bytes: reservationBytes.byteLength, blocks: reservations.length,
    runs: reservations.reduce((n, block) => n + block.runs.length / 3, 0),
    liquidPixels: reservations.reduce((n, block) => n + block.runs.filter((_v, p) => p % 3 === 2).reduce((a, b) => a + b, 0), 0),
    bitsetBytes: reservations.reduce((n, block) => n + Math.ceil(block.width * block.height / 8), 0),
    purpose: 'Reserve captured source-fluid pixels wherever normal native terrain or a non-static biome background can cover the base.',
  };
  await mkdir(dirname(OUTPUT), { recursive: true });
  await writeFile(OUTPUT, compressed);
  await writeFile(RESERVATIONS, reservationBytes);
  await rm(OUTPUT.slice(0, -3), { force: true });
  await writeFile(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`[static liquids] ${blocks.length} blocks, ${compressed.byteLength} compressed bytes (${bytes.byteLength} decoded), ${manifest.artifact.liquidPixels} material pixels`);
  console.log(`[static liquids] reservations: ${reservations.length} cropped blocks, ${reservationBytes.byteLength} bytes, ${manifest.capturedFluidReservations.bitsetBytes} material-bit bytes`);
  return { blocks, manifest };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await buildStaticLiquidMasks(process.argv.includes('--refresh-provenance'));
