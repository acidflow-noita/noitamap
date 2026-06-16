/**
 * special-wands.ts
 *
 * Named special wands (Huilu, Kantele) carry only their Finnish name in the
 * telescope data. This maps their stable `sprite` key to an English alias so
 * they're searchable by the English term and can show an English subtitle on
 * their POI card. Kept dependency-free so both the search bundle and the
 * telescope bundle can import it without pulling in heavy deps.
 */
export const SPECIAL_WAND_ALIAS: Record<string, string> = {
  "custom/flute": "Flute",
  "custom/kantele": "Kantele",
};
