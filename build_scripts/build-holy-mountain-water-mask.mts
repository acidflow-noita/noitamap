/** Offline mask for water in the captured Holy Mountain lower rooms only. */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { decodePngToRgba } from '../src/telescope/png-decode.ts';
import { encodeLiquidMask, maskBlock, type LiquidMaskBlock } from '../src/liquids/mask-codec.ts';
import { MATERIAL_NAMES_BY_ID, WANG_COLOR_TO_ID } from '../lib/noita-telescope-vm/js/engine_resolve/engine_data.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
const ROOMS = new Set(['temple/altar', 'temple/altar_left', 'temple/altar_right', 'temple/altar_right_snowcastle']);

export async function buildHolyMountainWaterMask() {
  const checks: { path: string; sha256: string }[] = [];
  const source = async (path: string) => {
    const bytes = await readFile(resolve(ROOT, path));
    checks.push({ path, sha256: sha256(bytes) });
    return bytes;
  };
  const manifest = JSON.parse((await source('src/liquids/static-sources.json')).toString());
  const png = async (path: string) => {
    const bytes = await source(path);
    return decodePngToRgba(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  };
  const map = await png(manifest.biomeMap);
  const waterId = MATERIAL_NAMES_BY_ID.indexOf('water');
  if (waterId < 0 || map.width !== 70) throw new Error('Unsupported Holy Mountain material/map source');
  const waterColors = new Set<number>((WANG_COLOR_TO_ID as [number, number][])
    .filter(([, id]) => id === waterId).map(([rgb]) => rgb));
  if (!waterColors.size) throw new Error('Water has no authored material color');
  const blocks: LiquidMaskBlock[] = [], pools: { key: string; x: number; y: number; width: number; height: number; pixels: number }[] = [];
  for (const rule of manifest.biomeScenes.filter((r: { key: string }) => ROOMS.has(r.key))) {
    const raw = await png(`${manifest.sceneRoot}/${rule.key}.png`);
    const water = new Uint8Array(raw.width * raw.height);
    let left = raw.width, right = 0, top = raw.height, bottom = 0, count = 0;
    for (let p = 0; p < water.length; p++) {
      const i = p * 4, rgb = (raw.data[i] << 16) | (raw.data[i + 1] << 8) | raw.data[i + 2];
      if (!raw.data[i + 3] || !waterColors.has(rgb)) continue;
      water[p] = 1; count++;
      const x = p % raw.width, y = Math.floor(p / raw.width);
      left = Math.min(left, x); right = Math.max(right, x + 1);
      top = Math.min(top, y); bottom = Math.max(bottom, y + 1);
    }
    if (!count) continue;
    const width = right - left, height = bottom - top, pixels = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) pixels.set(water.subarray((top + y) * raw.width + left,
      (top + y) * raw.width + right), y * width);
    const colors = new Set(rule.colors.map((c: string) => parseInt(c, 16)));
    for (let p = 0; p < map.width * map.height; p++) {
      const i = p * 4, color = (map.data[i] << 16) | (map.data[i + 1] << 8) | map.data[i + 2];
      if (!colors.has(color)) continue;
      for (const pw of manifest.capture.parallelWorlds) {
        const x = (p % map.width) * 512 - map.width * 256 + pw * manifest.capture.worldWidth + (rule.offsetX ?? 0) + left;
        const y = (Math.floor(p / map.width) - 14) * 512 + (rule.offsetY ?? 0) + top;
        blocks.push(maskBlock(x, y, width, height, pixels)!);
        pools.push({ key: rule.key, x, y, width, height, pixels: count });
      }
    }
  }
  await source('lib/noita-telescope-vm/js/engine_resolve/engine_data.js');
  await source('build_scripts/build-holy-mountain-water-mask.mts');
  blocks.sort((a, b) => a.y - b.y || a.x - b.x);
  pools.sort((a, b) => a.y - b.y || a.x - b.x);
  if (!blocks.length) throw new Error('Holy Mountain water mask is empty');
  const raw = encodeLiquidMask(blocks), compressed = gzipSync(raw, { level: 9 });
  const { mapKey, sourceDate, filenameSeed, parallelWorlds, worldWidth } = manifest.capture;
  const artifact = { path: 'src/liquids/assets/holy-mountain-water.bin.gz', bytes: compressed.byteLength,
    sha256: sha256(compressed), rawBytes: raw.byteLength, rawSha256: sha256(raw) };
  await writeFile(resolve(ROOT, artifact.path), compressed);
  await writeFile(resolve(ROOT, 'src/liquids/holy-mountain-water.json'), JSON.stringify({
    version: 1, scope: 'holy-mountain-water', material: 'water',
    capture: { mapKey, sourceDate, filenameSeed, parallelWorlds, worldWidth },
    artifact, pools, sourceChecks: checks,
  }, null, 2) + '\n');
  console.log(`[HM water] ${pools.length} pool sections, ${pools.reduce((n, p) => n + p.pixels, 0)} water pixels, ${compressed.byteLength} compressed bytes`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildHolyMountainWaterMask();
