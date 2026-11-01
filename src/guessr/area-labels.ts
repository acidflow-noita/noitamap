type Values = Record<string, string | number>;

/** Reviewed aliases for these same biomes. Some extra map languages have real
 * translations here while their CSV-derived canonical slot is still English.
 * The realm-specific The Work spawn alias is deliberately excluded. */
export const AREA_BIOME_MAP_FALLBACKS: Readonly<Record<string, readonly string[]>> = {
  biome_pyramid: ['extended.spawn.pyramid'],
  biome_winter: ['extended.spawn.snowy_wasteland'],
  biome_winter_caves: ['extended.spawn.snowy_chasm'],
  biome_vault_frozen: ['gameContent.biomes.Frozen Vault', 'extended.spawn.frozen_vault'],
  biome_liquidcave: ['extended.spawn.ancient_laboratory'],
  biome_rainforest: ['gameContent.biomes.Underground Jungle', 'extended.spawn.underground_jungle'],
  biome_rainforest_dark: ['gameContent.biomes.Lukki Lair', 'extended.spawn.lukki_lair'],
  biome_fungicave: ['gameContent.biomes.Fungal Caverns', 'extended.spawn.fungal_caverns'],
  biome_meat: ['gameContent.biomes.Meat Realm', 'extended.spawn.meat_realm'],
  biome_robobase: ['gameContent.biomes.Power Plant', 'extended.spawn.power_plant'],
  biome_tower: ['extended.spawn.the_tower'],
  biome_lake: ['extended.spawn.lake'],
  biome_lava: ['extended.spawn.lava_lake'],
  biome_snowcastle: ['gameContent.biomes.Hiisi Base', 'extended.spawn.hiisi_base'],
  biome_boss_arena: ['extended.spawn.the_laboratory'],
  biome_coalmine: ['gameContent.biomes.Mines', 'extended.spawn.mines'],
  biome_coalmine_alt: ['extended.spawn.collapsed_mines'],
  biome_excavationsite: ['gameContent.biomes.Coal Pits', 'extended.spawn.coal_pits'],
  biome_snowcave: ['gameContent.biomes.Snowy Depths', 'extended.spawn.snowy_depths'],
  biome_vault: ['gameContent.biomes.The Vault', 'extended.spawn.the_vault'],
  biome_crypt: ['gameContent.biomes.Temple of the Art', 'extended.spawn.temple_of_the_art'],
  biome_boss_sky: ['extended.spawn.kivi_temple'],
  biome_watchtower: ['extended.spawn.watchtower'],
  biome_holymountain: ['extended.spawn.holy_mountain'],
};

export interface AreaLabelTranslations {
  language: string;
  term: (englishName: string, canonicalKey?: string) => string;
  text: (source: string, values?: Values) => string;
  number: (value: number) => string;
  existing: (englishName: string, mapKey: string) => string | undefined;
}

interface QualifiedArea {
  name: string;
  key: string;
  template: string;
  values?: Values;
  preferred?: { name: string; key: string };
}

// These labels are the curated inventory's distinct recognition areas. The
// suffix describes which area it is; translating only the canonical base would
// collapse separate questions into the same displayed name.
const qualifiedAreas: Readonly<Record<string, QualifiedArea>> = {
  'ylialkemisti (boss room)': { name: 'Ylialkemisti', key: 'animal_boss_alchemist', template: '{{name}} (boss room)' },
  'fungal caverns (main)': { name: 'Fungal Caverns', key: 'biome_fungicave', template: '{{name}} (main)' },
  'fungal caverns (western jungle enclave)': { name: 'Fungal Caverns', key: 'biome_fungicave', template: '{{name}} (western jungle enclave)' },
  'fungal caverns (eastern jungle enclave)': { name: 'Fungal Caverns', key: 'biome_fungicave', template: '{{name}} (eastern jungle enclave)' },
  'meat realm (main, including meat room)': { name: 'Meat realm', key: 'biome_meat', template: '{{name}} (main, including meat room)' },
  'meat realm (secondary)': { name: 'Meat realm', key: 'biome_meat', template: '{{name}} (secondary)' },
  'the work (heaven)': {
    name: 'The Work', key: 'biome_boss_victoryroom', template: '{{name}} (Heaven)',
    preferred: { name: 'The Work (Sky)', key: 'gameContent.biomes.The Work (Sky)' },
  },
  'the work (hell)': {
    name: 'The Work', key: 'biome_boss_victoryroom', template: '{{name}} (Hell)',
    preferred: { name: 'The Work (Hell)', key: 'gameContent.biomes.The Work (Hell)' },
  },
  'holy mountain (lowest, beside kolmi)': {
    name: 'Holy Mountain', key: 'biome_holymountain', template: '{{name}} (lowest, beside {{boss}})', values: { boss: 'Kolmi' },
  },
};

const areaAliases: Readonly<Record<string, { name: string; key: string }>> = {
  'extremely dense rock': { name: 'Extremely dense rock', key: 'mat_rock_hard_border' },
  'the tower': { name: 'The Tower', key: 'biome_tower' },
  mountain_tree: { name: 'Giant Tree', key: 'extended.spawn.giant_tree' },
  gourd_room: { name: 'Gourd Cave', key: 'gameContent.structures.Gourd Cave' },
};

/** Presentation only: no inventory, mask, scoring, or protocol changes. Unknown
 * labels are left to the canonical term lookup instead of being guessed. */
export function formatGuessrAreaLabel(
  englishName: string,
  canonicalKey: string | undefined,
  translations: AreaLabelTranslations,
): string | undefined {
  const label = englishName.trim().toLowerCase();
  if (label === 'the tower' && translations.language === 'en') return 'The Tower';
  if (Object.hasOwn(areaAliases, label)) {
    const alias = areaAliases[label];
    return translations.term(alias.name, canonicalKey ?? alias.key);
  }
  if (label === 'watercave') {
    // This map marker is currently an English placeholder in every locale.
    // Keep the friendly area name until an approved translation is available.
    return translations.existing('Dark Cave (At Refresh Heart)', 'gameContent.structures.Dark Cave (At Refresh Heart)') ?? 'Dark Cave';
  }
  if (label === 'infinite hiidet elevator') {
    return translations.text('Infinite {{name}} elevator', { name: 'Hiidet' });
  }
  const depth = /^holy mountain \(depth ([1-6])\)$/.exec(label);
  if (depth) {
    return translations.text('{{name}} (depth {{depth}})', {
      name: translations.term('Holy Mountain', canonicalKey ?? 'biome_holymountain'),
      depth: translations.number(Number(depth[1])),
    });
  }
  if (!Object.hasOwn(qualifiedAreas, label)) return undefined;
  const area = qualifiedAreas[label];
  if (area.preferred) {
    const existing = translations.existing(area.preferred.name, area.preferred.key);
    if (existing !== undefined) return existing;
  }
  return translations.text(area.template, {
    ...area.values,
    ...(area.values?.boss === 'Kolmi' && translations.language !== 'en'
      ? { boss: translations.term('Kolmi', 'animal_boss_centipede') } : {}),
    name: translations.term(area.name, canonicalKey ?? area.key),
  });
}
