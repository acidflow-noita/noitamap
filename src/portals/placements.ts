import { NollaPrng } from '../../lib/noita-telescope/js/nolla_prng.js';
import catalog from './assets/effects.json';
import data from './placements.json';

export interface PortalPlacement {
  id: string;
  entity: string;
  effect: string;
  x: number;
  y: number;
  condition: string;
  phase: number;
}
export interface PortalSeed {
  seed: number;
  ngPlus?: number;
  worldSize: number;
  worldCenter: number;
  biomeData?: { pixels?: ArrayLike<number> };
  pixelScenesByPW?: Record<string, Array<{ key?: string; name?: string; x: number; y: number }>>;
  poisByPW?: Record<string, Array<{ item?: string; x: number; y: number }>>;
  parallelWorlds?: number[];
}
const entities: Record<string, string> = Object.fromEntries(Object.keys(catalog.effects).map(entity => [entity,
  entity === 'teleport_liquid_powered' ? 'holy_mountain' : entity === 'teleport_meditation_cube_return' ? 'meditation'
    : entity === 'teleport_hourglass_return' ? 'eye_room' : entity]));
const byKey = new Map(data.recipes.flatMap(rule => rule.keys.map(key => [key, rule] as const)));
const byBiome = new Map(data.recipes.flatMap(rule => rule.biomes.map(color => [color, rule] as const)));
const hmColors = new Set([0x93cb4c, 0x93cb4d, 0x93cb4e, 0x93cb4f, 0x93cb5a, 0x6dcb28, 0x5a9628]);
function phaseFor(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return (hash >>> 0) % 72;
}
/** The existing scene positions are authoritative, including NG+/Nightmare and
 * parallel-world offsets. This does not mutate or add fake loot to seed reports.
 * Conditional portals show potential sites, not a claim about a player's save. */
export function collectPortals(seed: PortalSeed): PortalPlacement[] {
  const portals = new Map<string, PortalPlacement>();
  const seenHmCells = new Set<string>();
  const add = (entity: string, x: number, y: number, condition: string) => {
    const effect = entities[entity];
    if (!effect || !Number.isFinite(x) || !Number.isFinite(y)) return;
    const id = `${entity}:${x}:${y}`;
    if (!portals.has(id)) portals.set(id, { id, entity, effect, x, y, condition, phase: phaseFor(`${seed.seed}:${id}`) });
  };
  for (const scenes of Object.values(seed.pixelScenesByPW ?? {})) for (const scene of scenes) {
    const rule = byKey.get(scene.key ?? '');
    if (!rule || !Number.isFinite(scene.x) || !Number.isFinite(scene.y)) continue;
    for (const p of rule.points) add(p.entity, scene.x+p.x, scene.y+p.y, p.condition);
    if (scene.key?.startsWith('temple/altar_top')) seenHmCells.add(`${scene.x}:${scene.y+40}`);
  }
  // Scanner-emitted entrance coordinates also cover the Buried Eye when its
  // spawn is in a Wang tile rather than a separately indexed pixel scene.
  for (const pois of Object.values(seed.poisByPW ?? {})) for (const p of pois) {
    if (p.item === 'buried_eye_teleporter') add('teleport_snowcave_buried_eye', p.x, p.y, 'liquid');
  }
  // Old baked metadata can omit cosmetic scenes. Reconstruct only reviewed
  // chunk-anchored sites from the ACTUAL seed biome map, not a vanilla row table.
  const pixels = seed.biomeData?.pixels;
  const width = seed.worldSize;
  if (pixels && Number.isInteger(width) && width > 0 && pixels.length === width*48) {
    const worlds = seed.parallelWorlds ?? Object.keys(seed.poisByPW ?? {}).filter(k => k.endsWith(',0')).map(k => Number(k.split(',')[0]));
    const rng = new NollaPrng(0);
    for (const pw of new Set(worlds)) {
      if (!Number.isInteger(pw)) continue;
      for (let index = 0; index < pixels.length; index++) {
        const color = pixels[index] & 0xffffff;
        const x = ((index%width)-seed.worldCenter+pw*width)*512;
        const y = (Math.floor(index/width)-14)*512;
        const rule = byBiome.get(color);
        if (rule) for (const p of rule.points) add(p.entity, x+p.x, y+p.y, p.condition);
        if (!hmColors.has(color) || seenHmCells.has(`${x}:${y}`)) continue;
        // Same per-basin source RNG and spawn offsets as the game. No graphics
        // state or particle simulation is needed to recover the two-pixel shift.
        if (color === 0x5a9628) add('teleport_ending', x+266, y+46, 'liquid');
        else if (y <= 12000) {
          rng.SetRandomSeed(seed.seed+(seed.ngPlus ?? 0), x, y);
          const special = [5,8,11,13,15].includes(rng.Random(1,50));
          add('teleport_liquid_powered', x+(special ? 266 : 264), y+46, 'liquid');
        }
      }
    }
  }
  return [...portals.values()];
}
