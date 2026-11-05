/** Dust's original particle thumbnails, used only in cards/search. Map targets
 * remain invisible so a static icon never covers the actual particle effect. */
const icons = {
  holy_mountain: new URL('./assets/icons/holy_mountain.png', import.meta.url).href,
  meditation: new URL('./assets/icons/meditation.png', import.meta.url).href,
  eye_room: new URL('./assets/icons/eye_room.png', import.meta.url).href,
  red_portal: new URL('./assets/icons/red_portal.png', import.meta.url).href,
  sun: new URL('./assets/icons/sun.png', import.meta.url).href,
  dark_sun: new URL('./assets/icons/dark_sun.png', import.meta.url).href,
  moon: new URL('./assets/icons/moon.png', import.meta.url).href,
};
export interface ParticleIconPOI {
  type?: string; item?: string; name?: string; entity?: string;
  portalEntity?: string; effect?: string;
}
const roomIcons: Record<string, keyof typeof icons> = {
  meditation_cube: 'meditation', meditation_chamber: 'meditation',
  hourglass_chamber: 'eye_room', buried_eye_teleporter: 'holy_mountain',
  buried_eye: 'holy_mountain', buried_eye_chamber: 'holy_mountain',
};
const namedRooms: Record<string, keyof typeof icons> = {
  'Meditation Cube Room': 'meditation', 'Meditation Chamber': 'meditation',
  'Eye Spell Room': 'eye_room', 'Hourglass Chamber': 'eye_room', 'Hourglass': 'eye_room',
  'Buried Eye': 'holy_mountain', 'Buried Eye Room': 'holy_mountain', 'Buried Eye Chamber': 'holy_mountain',
  'Tower Portal Diamond': 'holy_mountain', 'Desert Skull, Eye': 'holy_mountain',
};

export function particleIcon(poi: ParticleIconPOI, suns: readonly string[] = []): string | null {
  if (poi.type === 'spell' || poi.item === 'spell') return null;
  if (poi.type === 'pillar_place') {
    if (['Sun/Moon', 'Moon'].includes(poi.name ?? '')) return icons[suns.includes('sun') ? 'sun' : 'moon'];
    if (['Dark Sun/Dark Moon', 'Dark Moon'].includes(poi.name ?? '')) return icons[suns.includes('dark_sun') ? 'dark_sun' : 'moon'];
  }
  if (poi.type === 'eye_room') return icons.eye_room;
  if (poi.name && namedRooms[poi.name]) return icons[namedRooms[poi.name]];
  if (poi.item && roomIcons[poi.item]) return icons[roomIcons[poi.item]];
  for (const value of [poi.portalEntity, poi.effect, poi.entity, poi.item]) {
    const id = value?.split('/').at(-1)?.replace(/\.xml$/, '') ?? '';
    if (id === 'newsun' || id === 'sun') return icons.sun;
    if (id === 'newsun_dark' || id === 'dark_sun') return icons.dark_sun;
    if (id === 'moon' || id === 'dark_moon') return icons.moon;
    if (id === 'meditation' || /^teleport_meditation_cube(?:_|$)/.test(id)) return icons.meditation;
    if (id === 'eye_room' || /^teleport_hourglass(?:_|$)/.test(id)) return icons.eye_room;
    if (id === 'red_portal') return icons.red_portal;
    if (/^(?:mystery_teleport|teleport_ending|teleport_teleroom)(?:_|$)/.test(id)) return icons.red_portal;
    if (id === 'holy_mountain' || /^teleport(?:_|$)/.test(id)) return icons.holy_mountain;
  }
  return poi.item === 'portal' ? icons.holy_mountain : null;
}
