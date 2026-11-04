import structures from '../../data/structures.json';

export type SunEffect = 'sun' | 'dark_sun';
export interface SunPlacement { effect: SunEffect; x: number; y: number; diameter: number }
export const SUN_FRAME_SIZE = 1536;
export const SUN_REVISION = 'a2bda47';
// Existing Sun quest landmarks. Visibility is supplied separately from the
// selected unlock view and the mod's persistent Moon-replacement flags.
export const SUNS: readonly SunPlacement[] = [
  ['sun', 'Sun/Moon', 210], ['dark_sun', 'Dark Sun/Dark Moon', 320],
].map(([effect, name, diameter]) => {
  const place = structures.find(place => place.name === name)!;
  return { effect: effect as SunEffect, x: place.x, y: place.y, diameter: Number(diameter) };
});
