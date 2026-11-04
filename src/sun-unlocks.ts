import type { SunEffect } from './portals/suns/placements';

/** Separate from spell unlocks and Sun-creation achievements. These are the
 * persistent flags read by Noita's two moon_altar_init.lua scripts.
 * The companion mod sends a two-bit `sun=0..3` mask, including explicit zero. */
export const SUN_UNLOCK_FLAGS = ['moon_is_sun', 'darkmoon_is_darksun'] as const;
const EFFECTS: readonly SunEffect[] = ['sun', 'dark_sun'];

export function getSunUnlocks(
  descriptor: 'all' | 'none' | 'mod',
  encoded = new URLSearchParams(window.location.search).get('sun'),
): readonly SunEffect[] {
  if (descriptor === 'all') return EFFECTS;
  if (descriptor === 'none' || !/^[0-3]$/.test(encoded ?? '')) return [];
  const mask = Number(encoded);
  return EFFECTS.filter((_, bit) => mask & (1 << bit));
}
