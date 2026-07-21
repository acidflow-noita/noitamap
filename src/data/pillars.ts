/**
 * pillars.ts
 *
 * Achievement Pillars reconstruction. Ported from Noita's
 * data/scripts/biomes/mountain_tree.lua `spawn_pillars`:
 *
 *   - 6 pillars, COUNT*INC wide, INC apart, centred on the spawn point.
 *   - Each pillar i has a fixed category of achievements (FLAGS[i]).
 *   - Build order (bottom -> top): a `fade` cap below, the base segment, 3 plain
 *     segments, then ONE engraved segment (pillar_part_<code>) per achievement,
 *     then an end cap (pillar_end_0X).
 *   - In-game only UNLOCKED achievements get a segment. We always emit every
 *     segment and mark locked ones so they render desaturated ("not unlocked yet").
 *
 * Segment art is baked into the spritesheet as pillar:<basename> (and a
 * grayscale twin pillar_gray:<basename>) by build-spritesheet.cjs.
 */

const COUNT = 6;
const WIDTH = 660;
const INC = WIDTH / COUNT; // 110
const SIZE = 48; // segment height/width in world px
const ABOVE = 3; // plain segments above the base before achievements

// End-cap selection per pillar, verbatim from spawn_pillars.
const END_CAPS = ["pillar_end_01", "pillar_end_03", "pillar_end_06", "pillar_end_02", "pillar_end_05", "pillar_end_04"];

// Wiki section anchor per pillar index (the page splits into 6 named sections).
const PILLAR_SECTIONS = [
  "Pillar_of_Sacrifice_&_Transformation",
  "Pillar_of_the_Essences",
  "Pillar_of_Completions",
  "Pillar_of_Bosses",
  "Pillar_of_Accomplishments",
  "Pillar_of_Secrets",
];

// i18n key for each pillar's heading (resolved on the card). Full phrase per
// language so e.g. "Pillar of Bosses" reads naturally everywhere.
const PILLAR_THEMES = [
  "pillar.theme.sacrifice",
  "pillar.theme.essences",
  "pillar.theme.completions",
  "pillar.theme.bosses",
  "pillar.theme.accomplishments",
  "pillar.theme.secrets",
];

/**
 * How each achievement segment is unlocked, as a structured spec resolved to
 * localized text at render time (telescope-osd-bridge resolvePillarRequirement).
 *
 *   tmpl       - i18n template key containing {{name}} (e.g. "pillar.req.defeat").
 *   nameKey    - common.csv key whose verified translation fills {{name}}. Names
 *                are NEVER blind-translated — they come from the game data that
 *                is already localized in all 16 languages.
 *   key        - i18n key for a self-contained phrase with no {{name}} param.
 *   targetType - POI `type` to fly-to + open when the {{name}} link is clicked
 *                (reuses the search/seed-report cinematic goto). Optional.
 *
 * boss `animal_*` and `item_essence_*` keys are the same ones the boss cards and
 * essence cards already use, so they are guaranteed present in common.csv.
 */
export interface PillarTarget {
  /** POI type to resolve a seed-dependent travel target via the marker index. */
  targetType?: string;
  /** POI item id to match (e.g. mimic_potion) via the marker index. */
  itemId?: string;
  /** Essence material (fire/water/laser/air/alcohol) — matches the essence POI. */
  material?: string;
  /** Crystal-key chest variant (dark/coral/steel) — matches the chest POI. */
  chestVariant?: string;
  /** Creature id (CREATURE_DATA key) — matches the nearest entity POI. */
  entity?: string;
  /** Wand sprite suffix (e.g. "custom/kantele") — matches the unique wand POI. */
  wandSprite?: string;
  /** Fixed world coords for static structures (e.g. the Avarice Diamond). */
  x?: number;
  y?: number;
  /**
   * Search-bar chip resolved from these common.csv keys, OR-joined localized
   * names ("Essence of Fire | Essence of Water | ..."). Like searchPerks but
   * for item/spell name keys.
   */
  searchNameKeys?: string[];
  /**
   * Verbatim search-bar query for POIs that only exist under hand-assigned
   * English names (e.g. the Music Machines — no in-game name key exists).
   * Takes precedence over the ITEM_SEARCH_NAME_KEYS lookup.
   */
  query?: string;
  /**
   * Search-driven target: clicking populates the search bar with the localized
   * names of these telescope perk ids, OR-combined ("a | b | c"), instead of
   * flying to one POI. Used by the transformation segments (any of N perks
   * scattered across the worlds triggers progress).
   */
  searchPerks?: string[];
  /**
   * Search-driven flavour of the identity fields above: instead of flying to
   * the single nearest match, populate the search bar (localized item name,
   * see ITEM_SEARCH_NAME_KEYS) so the user sees ALL instances, nearest first.
   * Used for multi-instance items (chests, sacrifice items). The identity
   * fields stay authoritative for the reverse "Pillar" button.
   */
  search?: boolean;
  /**
   * Category filter to co-activate when this search link fires, so the results
   * list is narrowed to the right kind of POI (e.g. a chest search also flips
   * the Chests filter, dropping wands/items that merely mention "chest").
   * MUST be a filter that INCLUDES the target's POI type/item, or the target
   * would be filtered OUT — e.g. utility_box has no matching filter, so it gets
   * none. Values match the dynamic-map filter keys in unifiedsearch.ts.
   */
  searchFilter?: string;
}

export interface PillarLink extends PillarTarget {
  /**
   * Literal term to find inside the resolved sentence and turn into a dashed
   * pin-link. Proper nouns (Toveri, Tapion vasalli, Kolmisilmä) are kept
   * untranslated in every locale, so a literal match works language-wide.
   * Place names (Avarice Diamond) match inline in English and fall back to a
   * trailing pin chip in locales whose sentence phrased the place differently.
   */
  label?: string;
  /** i18n key resolved at render time — for localized chip labels (halo). */
  labelKey?: string;
  /**
   * Search chips backed by a seed-dependent structure POI: when no POI with
   * this `item` id exists in the marker index, the results banner explains
   * that only the destination chamber matched (pillar.structureMissing).
   */
  structureItem?: string;
  /**
   * Wiki page of a coords-only destination (altars, moons, ...). These spots
   * have no generated POI — nothing clickable at the target — so when set,
   * travelling there synthesizes a place card (label + this wiki + the
   * "Pillar" back-button) instead of a bare pan.
   */
  wiki?: string;
}

/**
 * POI item/type id -> common.csv key of its proper in-game name. Serves two
 * sides of the same feature: unifiedsearch indexes the localized name on the
 * matching POIs, and pillar search links put that same localized name into the
 * search bar, so the OR query hits in every language. Ids with no in-game
 * name (statue_hand, sun_rock, darksun_rock props) fall back to the raw id,
 * which is always indexed.
 */
export const ITEM_SEARCH_NAME_KEYS: Record<string, string> = {
  chest: "item_chest_treasure",
  great_chest: "item_chest_treasure_super",
  utility_box: "item_utility_box",
  worm_crystal: "building_worm_deflector",
  greed_crystal: "item_greed_crystal",
  mimic_potion: "animal_mimic_potion",
  orb: "item_orb",
};

export interface PillarReqSpec {
  tmpl?: string;
  nameKey?: string;
  /** CREATURE_DATA id whose alias names {{name}} when no animal_* key exists
   *  (e.g. the Gate Guardian has no localized animal_boss_gate entry). */
  creatureId?: string;
  key?: string;
  targetType?: string;
  /** Where the {{name}} in a tmpl phrase travels to (essence/chest/orb/coords). */
  target?: PillarTarget;
  /** Inline travel links for the free-form `key` phrases. */
  links?: PillarLink[];
  /**
   * Wrap the WHOLE resolved phrase in a single link to this target (used by the
   * transformation segments, whose localized phrases can't carry a stable
   * inline label to match against).
   */
  phraseTarget?: PillarTarget;
  /**
   * Per-achievement wiki page override. Default is the Achievement Pillars
   * section of the segment's pillar; transformations point at their own
   * Transformations section instead.
   */
  wiki?: string;
}

// Reusable travel-link presets. Coords for fixed structures come from
// src/data/structures.json; POI-type links resolve to the generated POI.
const LINK_TOVERI: PillarLink = { label: "Toveri", targetType: "friend" };
const LINK_KAUHU: PillarLink = {
  label: "Kauhuhirviö",
  wiki: "https://noita.wiki.gg/wiki/Kauhuhirvi%C3%B6",
  entity: "ultimate_killer",
};
const LINK_AVARICE: PillarLink = {
  label: "Avarice Diamond",
  wiki: "https://noita.wiki.gg/wiki/The_Tower#Avarice_Diamond",
  x: 9472,
  y: 4330,
};
const LINK_TAPIO: PillarLink = { label: "Tapion vasalli", targetType: "islandspirit" };
const LINK_KOLMI: PillarLink = { label: "Kolmisilmä", targetType: "boss_centipede" };
const LINK_ALTAR: PillarLink = {
  label: "Mountain Altar",
  x: 781,
  y: -1167,
  wiki: "https://noita.wiki.gg/wiki/Mountain_Altar",
};

// Fixed-structure travel targets (coords from src/data/structures.json). These
// are where the achievement's unlock actually happens in the world (derived
// from the AddFlagPersistent call sites in data/scripts/**). Used as the
// segment's `target` so the {{name}}/phrase links fly to the right spot.
// (The Mountain Altar coord lives on LINK_ALTAR below, since it is a sacrifice
// destination link rather than an item target.)
const T_THE_WORK: PillarTarget = { x: 6397, y: 15072 };
const T_MOON: PillarTarget = { x: 259, y: -25847 };
const T_DARK_MOON: PillarTarget = { x: 261, y: 37764 };
const T_SCALES: PillarTarget = { x: 13060, y: 8 };
const T_NULL_ALTAR: PillarTarget = { x: 14080, y: 7510 };
const T_END_OF_EVERYTHING: PillarTarget = { x: -4862, y: 15110 };
const T_GOURD_CAVE: PillarTarget = { x: -16134, y: -6312 };
const T_EXP_WAND_DIAMOND: PillarTarget = { x: 16127, y: 9986 };
const T_TOWER_PORTAL: PillarTarget = { x: 9984, y: 4358 };

// Moon links recur across many specs — share one const so the wiki page and
// coords can never drift between them.
const LINK_MOON: PillarLink = { label: "Moon", wiki: "https://noita.wiki.gg/wiki/Moon", ...T_MOON };
const LINK_DARK_MOON: PillarLink = { label: "Dark Moon", wiki: "https://noita.wiki.gg/wiki/Dark_Moon", ...T_DARK_MOON };

// Shared by the completion segments.
const LINK_ENDINGS: PillarLink = { label: "Endings", wiki: "https://noita.wiki.gg/wiki/Endings" };
const LINK_THE_WORK: PillarLink = { label: "The Work", wiki: "https://noita.wiki.gg/wiki/The_Work_(End)" };
const LINK_ORBS_11: PillarLink = { label: "11 Orbs", itemId: "orb", search: true, searchFilter: "or" };
const LINK_ORBS_33: PillarLink = { label: "33 Orbs", itemId: "orb", search: true, searchFilter: "or" };

// Essence search chips: OR-join the localized essence names (common.csv keys).
const ESSENCE_KEYS_4 = ["item_essence_fire", "item_essence_water", "item_essence_laser", "item_essence_air"];
const LINK_4_ESSENCES: PillarLink = { label: "4 elemental Essences", search: true, searchNameKeys: ESSENCE_KEYS_4 };
const LINK_5_ESSENCES: PillarLink = {
  label: "5 Essences",
  search: true,
  searchNameKeys: [...ESSENCE_KEYS_4, "item_essence_alcohol"],
};

// Transformations wiki page (per-transformation section anchors).
const WIKI_TRANSFORMATIONS = "https://noita.wiki.gg/wiki/Transformations";

/**
 * Perk ids (telescope ids, resolved via perkNameKey -> common.csv) that add a
 * level toward each transformation. Straight from the game's
 * data/scripts/perks/perk_list.lua call sites of add_<x>_level:
 *   ratty:   PLAGUE_RATS, REVENGE_RATS, VOMIT_RATS ("Spontaneous Generation")
 *   funky:   CORDYCEPS, MOLD ("Fungal Colony"), FUNGAL_DISEASE
 *   ghostly: ANGRY_GHOST, HUNGRY_GHOST, DEATH_GHOST ("Mournful Spirit")
 *   lukky:   ATTACK_FOOT ("Lukki Mutation"), LEGGY_FEET, LUKKI_MINION
 *   halo:    +/-3 net alignment; light +1 and dark -1 perks listed separately.
 */
const PERKS_RATTY = ["plague_rats", "revenge_rats", "vomit_rats"];
const PERKS_FUNKY = ["cordyceps", "mold", "fungal_disease"];
const PERKS_GHOSTLY = ["angry_ghost", "hungry_ghost", "death_ghost"];
const PERKS_LUKKY = ["attack_foot", "leggy_feet", "lukki_minion"];
const PERKS_HALO_LIGHT = ["saving_grace", "respawn", "genome_more_love", "peace_with_gods"];
const PERKS_HALO_DARK = ["exploding_corpses", "global_gore", "vampirism", "genome_more_hatred"];

export const PILLAR_REQUIREMENTS: Record<string, PillarReqSpec> = {
  // Pillar 1 — Sacrifice & Transformation
  // Altar sacrifices all happen at the Mountain Altar (altar_tablet_magic.lua).
  // Sacrifice items exist in multiple places across the worlds, so their
  // {{name}} is a SEARCH link (populates the search bar with the localized
  // item name; results are proximity-sorted) rather than a jump to one
  // arbitrary instance. The Mountain Altar (where the sacrifice happens)
  // stays a direct travel link.
  misc_chest_rain: {
    tmpl: "pillar.req.sacrifice",
    nameKey: "pillar.item.treasureChest",
    target: { targetType: "chest", search: true, searchFilter: "c" },
    links: [LINK_ALTAR],
  },
  misc_util_rain: {
    tmpl: "pillar.req.sacrifice",
    nameKey: "pillar.item.utilityBox",
    // utility_box is its own POI type — no dynamic filter includes it, so no
    // searchFilter (co-activating one would hide the result).
    target: { targetType: "utility_box", search: true },
    links: [LINK_ALTAR],
  },
  misc_worm_rain: {
    tmpl: "pillar.req.sacrifice",
    nameKey: "pillar.item.wormCrystal",
    target: { itemId: "worm_crystal", search: true, searchFilter: "i" },
    links: [LINK_ALTAR],
  },
  misc_greed_rain: {
    tmpl: "pillar.req.sacrifice",
    nameKey: "pillar.item.greedCrystal",
    target: { itemId: "greed_crystal", search: true, searchFilter: "i" },
    links: [LINK_ALTAR],
  },
  misc_altar_tablet: {
    key: "pillar.req.altarTablet",
    links: [{ label: "3 Emerald Tablets", search: true, query: "Emerald Tablet", searchFilter: "i" }, LINK_ALTAR],
  },
  misc_mimic_potion_rain: {
    tmpl: "pillar.req.sacrifice",
    nameKey: "animal_mimic_potion",
    target: { itemId: "mimic_potion", search: true, searchFilter: "i" },
    links: [LINK_ALTAR],
  },
  misc_monk_bots: {
    tmpl: "pillar.req.sacrifice",
    nameKey: "pillar.item.monkStatue",
    target: { itemId: "statue_hand", search: true, searchFilter: "i" },
    links: [LINK_ALTAR],
  },
  misc_sun_effect: {
    tmpl: "pillar.req.sacrifice",
    nameKey: "pillar.item.sunstone",
    target: { itemId: "sun_rock", search: true, searchFilter: "i" },
    links: [LINK_ALTAR],
  },
  misc_darksun_effect: {
    tmpl: "pillar.req.sacrifice",
    nameKey: "pillar.item.darkSunstone",
    target: { itemId: "darksun_rock", search: true, searchFilter: "i" },
    links: [LINK_ALTAR],
  },
  secret_tower: {
    key: "pillar.req.tower",
    links: [{ label: "The Tower", wiki: "https://noita.wiki.gg/wiki/The_Tower", ...T_TOWER_PORTAL }],
  },
  // Transformations: the whole phrase is a search link that fills the search
  // bar with the contributing perks (OR), and the card's wiki link points at
  // the transformation's own section instead of the Achievement Pillars page.
  player_status_ghostly: {
    key: "pillar.req.transformGhostly",
    phraseTarget: { searchPerks: PERKS_GHOSTLY },
    wiki: `${WIKI_TRANSFORMATIONS}#Ghostly_Transformation`,
  },
  player_status_ratty: {
    key: "pillar.req.transformRatty",
    phraseTarget: { searchPerks: PERKS_RATTY },
    wiki: `${WIKI_TRANSFORMATIONS}#Ratty_Transformation`,
  },
  player_status_funky: {
    key: "pillar.req.transformFunky",
    phraseTarget: { searchPerks: PERKS_FUNKY },
    wiki: `${WIKI_TRANSFORMATIONS}#Funky_Transformation`,
  },
  player_status_lukky: {
    key: "pillar.req.transformLukky",
    phraseTarget: { searchPerks: PERKS_LUKKY },
    wiki: `${WIKI_TRANSFORMATIONS}#Lukki_Transformation`,
  },
  // Halo needs 3 picks of the SAME polarity, so light and dark get separate
  // search chips instead of one mixed query.
  player_status_halo: {
    key: "pillar.req.transformHalo",
    links: [
      { labelKey: "pillar.halo.light", searchPerks: PERKS_HALO_LIGHT },
      { labelKey: "pillar.halo.dark", searchPerks: PERKS_HALO_DARK },
      { label: "wiki", wiki: `${WIKI_TRANSFORMATIONS}#Halo_Transformation` },
    ],
    wiki: `${WIKI_TRANSFORMATIONS}#Halo_Transformation`,
  },
  // Pillar 2 — Essences (names from common.csv item_essence_*; link to the essence POI)
  essence_fire: { tmpl: "pillar.req.collect", nameKey: "item_essence_fire", target: { material: "fire" } },
  essence_water: { tmpl: "pillar.req.collect", nameKey: "item_essence_water", target: { material: "water" } },
  essence_laser: { tmpl: "pillar.req.collect", nameKey: "item_essence_laser", target: { material: "laser" } },
  essence_air: { tmpl: "pillar.req.collect", nameKey: "item_essence_air", target: { material: "air" } },
  essence_alcohol: { tmpl: "pillar.req.collect", nameKey: "item_essence_alcohol", target: { material: "alcohol" } },
  secret_moon: { key: "pillar.req.voidMoon", links: [LINK_MOON, LINK_4_ESSENCES] },
  secret_moon2: {
    key: "pillar.req.drunkMoon",
    links: [LINK_MOON, LINK_5_ESSENCES, { label: "Destruction", search: true, searchNameKeys: ["action_destruction"] }],
  },
  special_mood: {
    key: "pillar.req.gourdMoon",
    links: [LINK_KOLMI, LINK_MOON, { label: "Refreshing Gourd", itemId: "gourd" }, LINK_4_ESSENCES],
  },
  secret_dmoon: { key: "pillar.req.bloodMoon", links: [LINK_DARK_MOON] },
  dead_mood: { key: "pillar.req.darkGourdMoon", links: [LINK_DARK_MOON] },
  secret_sun_collision: { key: "pillar.req.asAboveSoBelow", links: [LINK_MOON] },
  secret_darksun_collision: { key: "pillar.req.asAboveSoBelowDark", links: [LINK_DARK_MOON] },
  // Pillar 3 — Completions
  progress_ending0: {
    key: "pillar.req.endingGreed",
    links: [{ label: "Greed", wiki: "https://noita.wiki.gg/wiki/Endings" }],
  },
  progress_ending1_toxic: {
    key: "pillar.req.endingToxic",
    links: [
      { label: "Sampo", search: true, query: "Sampo" },
      // Inline "altar" wraps the Mountain Altar goto (label override only).
      { ...LINK_ALTAR, label: "altar" },
      LINK_THE_WORK,
      LINK_ENDINGS,
    ],
  },
  progress_ending1_gold: { key: "pillar.req.endingPure", links: [LINK_THE_WORK, LINK_ORBS_11, LINK_ENDINGS] },
  progress_ending2: { key: "pillar.req.endingPeaceful", links: [LINK_THE_WORK, LINK_ORBS_33, LINK_ENDINGS] },
  // "New Game+++" carries no coords — a wiki-only link renders as an external
  // URL chip inside the phrase (see makePin's external branch).
  progress_newgameplusplus3: {
    key: "pillar.req.endingNgpp",
    links: [{ label: "New Game+++", wiki: "https://noita.wiki.gg/wiki/New_Game_Plus" }, LINK_ENDINGS],
  },
  progress_nightmare: {
    key: "pillar.req.endingNightmare",
    links: [{ label: "Nightmare mode", wiki: "https://noita.wiki.gg/wiki/Nightmare_mode" }, LINK_ENDINGS],
  },
  // Pillar 4 — Bosses (names from common.csv animal_*; links fly to the boss POI)
  miniboss_dragon: { tmpl: "pillar.req.defeat", nameKey: "animal_boss_dragon", targetType: "dragon" },
  miniboss_limbs: { tmpl: "pillar.req.defeat", nameKey: "animal_boss_limbs", targetType: "pyramid_boss" },
  miniboss_meat: { tmpl: "pillar.req.defeat", nameKey: "animal_boss_meat", targetType: "boss_meat" },
  miniboss_ghost: { tmpl: "pillar.req.defeat", nameKey: "animal_boss_ghost", targetType: "boss_ghost" },
  miniboss_pit: { tmpl: "pillar.req.defeat", nameKey: "animal_boss_pit", targetType: "boss_pit" },
  miniboss_alchemist: { tmpl: "pillar.req.defeat", nameKey: "animal_boss_alchemist", targetType: "alchemist_boss" },
  miniboss_robot: { tmpl: "pillar.req.defeat", nameKey: "animal_boss_robot", targetType: "boss_robot" },
  miniboss_wizard: { tmpl: "pillar.req.defeat", nameKey: "animal_boss_wizard", targetType: "boss_wizard" },
  miniboss_maggot: { tmpl: "pillar.req.defeat", nameKey: "animal_maggot_tiny", targetType: "tiny" },
  miniboss_fish: { tmpl: "pillar.req.defeat", nameKey: "animal_fish_giga", targetType: "boss_fish" },
  miniboss_islandspirit: { tmpl: "pillar.req.defeat", nameKey: "animal_islandspirit", targetType: "islandspirit" },
  miniboss_threelk: {
    key: "pillar.req.threelk",
    links: [LINK_TAPIO, { label: "helpless animals", wiki: "https://noita.wiki.gg/wiki/Helpless_Animals" }],
  },
  miniboss_gate_monsters: { tmpl: "pillar.req.defeat", creatureId: "boss_gate", targetType: "triangle_boss" },
  final_secret_orb3: { tmpl: "pillar.req.defeat", nameKey: "animal_friend", targetType: "friend" },
  miniboss_sky: { tmpl: "pillar.req.defeat", nameKey: "animal_boss_sky", targetType: "boss_sky" },
  boss_centipede: { tmpl: "pillar.req.defeat", nameKey: "animal_boss_centipede", targetType: "boss_centipede" },
  // Pillar 5 — Accomplishments
  // Orbs of True Knowledge: the 11 true orbs are real search POIs (item "orb",
  // injected from data/orbs.json — the generator emits none on NG). The WHOLE
  // phrase is a search link (like the transformations) that fills the bar with
  // the localized in-game name "Orb" (item_orb) and co-activates the Orbs
  // filter, so results are exactly the 11 true orbs — never energy-orb spells
  // or wands that merely carry them. progress_orb_evil unlocks via the
  // corrupted (NG+) orbs, which sit in the same 11 orb rooms, so the same
  // search shows where to go.
  progress_orb_1: { key: "pillar.req.orb1", phraseTarget: { itemId: "orb", search: true, searchFilter: "or" } },
  progress_orb_evil: { key: "pillar.req.orbEvil", phraseTarget: { itemId: "orb", search: true, searchFilter: "or" } },
  progress_orb_all: { key: "pillar.req.orbAll", phraseTarget: { itemId: "orb", search: true, searchFilter: "or" } },
  progress_pacifist: {
    key: "pillar.req.pacifist",
    links: [{ label: "pacifist", wiki: "https://noita.wiki.gg/wiki/Pacifist" }],
  },
  progress_nogold: {
    key: "pillar.req.nogold",
    links: [{ label: "gold", wiki: "https://noita.wiki.gg/wiki/Gold" }],
  },
  progress_clock: { key: "pillar.req.speedrun5", target: T_THE_WORK },
  progress_minit: { key: "pillar.req.speedrun1", target: T_THE_WORK },
  progress_nohit: {
    key: "pillar.req.nohit",
    links: [{ label: "no-hit", wiki: "https://noita.wiki.gg/wiki/Damage_Types" }],
  },
  progress_sun: { key: "pillar.req.uusiAurinko", target: T_SCALES },
  progress_darksun: { key: "pillar.req.pimeaAurinko", target: T_SCALES },
  progress_sunkill: {
    key: "pillar.req.benignSunshine",
    target: T_SCALES,
    links: [LINK_KOLMI, { label: "wiki", wiki: "https://noita.wiki.gg/wiki/Uusi_Aurinko#Miscellaneous" }],
  },
  secret_supernova: { key: "pillar.req.supernova", links: [LINK_MOON] },
  // Pillar 6 — Secrets
  // The pedestal is a synthetic item POI (item "greed_curse", greed_curse.png
  // sprite) pushed by telescope-adapter, so gotos land on a real marker.
  secret_greed: {
    key: "pillar.req.greed",
    target: { itemId: "greed_curse" },
    links: [{ label: "Greed Curse Pedestal", wiki: "https://noita.wiki.gg/wiki/Curse_of_Greed", itemId: "greed_curse" }],
  },
  final_secret_orb: { key: "pillar.req.friendship", links: [LINK_KAUHU, LINK_AVARICE] },
  final_secret_orb2: { key: "pillar.req.friendship2", links: [LINK_TOVERI, LINK_AVARICE] },
  // Crystal-key chests: phrase links for the key (wiki only — the charged key
  // is a quest item, never a generated POI), the chargers, and the chest
  // itself. Labels match the EN phrases inline; other locales fall back to
  // trailing chips.
  secret_chest_dark: {
    key: "pillar.req.darkChest",
    target: { chestVariant: "dark" },
    links: [
      { label: "Crystal Key", wiki: "https://noita.wiki.gg/wiki/Crystal_Key" },
      { label: "Huilu", wandSprite: "custom/flute" },
      { label: "Kantele", wandSprite: "custom/kantele" },
      { label: "chest in eastern Hell", chestVariant: "dark" },
    ],
  },
  secret_chest_light: {
    key: "pillar.req.coralChest",
    target: { chestVariant: "coral" },
    links: [
      { label: "Crystal Key", wiki: "https://noita.wiki.gg/wiki/Crystal_Key" },
      { label: "Music Machines", search: true, query: "Music Machine" },
      { label: "Eastern Cloudscape chest", chestVariant: "coral" },
    ],
  },
  // The unique steel chest inside the End of Everything room is the actual
  // goal: the link flies to that chest POI (chestVariant steel), falling back
  // to the room coords when no generated chest exists. The spec-level target
  // gives the chest's own card a reverse "Pillar" button pointing HERE rather
  // than at the generic "sacrifice a chest" segment.
  card_unlocked_everything: {
    key: "pillar.req.endOfEverything",
    target: { chestVariant: "steel" },
    links: [
      {
        label: "End of Everything",
        wiki: "https://noita.wiki.gg/wiki/The_End_of_Everything",
        chestVariant: "steel",
        ...T_END_OF_EVERYTHING,
      },
    ],
  },
  card_unlocked_divide: {
    key: "pillar.req.avarice",
    links: [LINK_AVARICE, { label: "Curse of Greed", itemId: "greed_curse" }],
  },
  secret_fruit: {
    key: "pillar.req.secretFruit",
    links: [
      LINK_KOLMI,
      { label: "gourd", search: true, searchNameKeys: ["item_gourd"] },
      { label: "Gourd Cave", wiki: "https://noita.wiki.gg/wiki/Refreshing_Gourd", ...T_GOURD_CAVE },
    ],
  },
  secret_allessences: {
    key: "pillar.req.allEssences",
    target: T_THE_WORK,
    // Only the 4 elemental essences count — the Essence of Spirits must NOT
    // be in the OR search.
    links: [{ label: "4 normal Essences", search: true, searchNameKeys: ESSENCE_KEYS_4 }],
  },
  // The chip searches for the cube (telescope prop, when the seed spawns one)
  // AND the Meditation Chamber (synthetic scene-anchored POI).
  secret_meditation: {
    key: "pillar.req.meditation",
    wiki: "https://noita.wiki.gg/wiki/Meditation_Chamber",
    target: { itemId: "meditation_cube" },
    links: [{ label: "Meditation Cube", search: true, query: "Meditation", structureItem: "meditation_cube" }],
  },
  // The Buried Eye spawns at a per-seed position — the chip searches for the
  // structure AND its destination chamber (both synthetic scene-anchored POIs).
  secret_buried_eye: {
    key: "pillar.req.buriedEye",
    wiki: "https://noita.wiki.gg/wiki/Buried_Eye",
    target: { itemId: "buried_eye" },
    links: [
      { label: "Buried Eye", search: true, query: "Buried Eye", structureItem: "buried_eye" },
      { label: "Teleportatium", search: true, searchNameKeys: ["mat_magic_liquid_teleportation"] },
    ],
  },
  // The Hourglass Chamber spawns left OR right of the Hiisi Base shop (50/50
  // per seed) — goto resolves the synthetic hourglass POI placed at the
  // scanner's per-seed pixel-scene position, never a fixed guess.
  secret_hourglass: {
    key: "pillar.req.hourglass",
    target: { itemId: "hourglass" },
    links: [
      { label: "Hourglass", itemId: "hourglass", wiki: "https://noita.wiki.gg/wiki/The_Hourglass_Chamber" },
      { label: "Unstable Teleportatium", search: true, searchNameKeys: ["mat_magic_liquid_unstable_teleportation"] },
    ],
  },
  progress_hut_a: {
    key: "pillar.req.expWandGlimmer",
    target: T_EXP_WAND_DIAMOND,
    links: [{ label: "Experimental wand", wiki: "https://noita.wiki.gg/wiki/Wands#Unique_wands" }],
  },
  progress_hut_b: {
    key: "pillar.req.expWandRequirements",
    target: T_EXP_WAND_DIAMOND,
    links: [{ label: "Experimental wand", wiki: "https://noita.wiki.gg/wiki/Wands#Unique_wands" }],
  },
  secret_null: {
    key: "pillar.req.nullAltar",
    links: [{ label: "Nullifying Altar", wiki: "https://noita.wiki.gg/wiki/Nullifying_Altar", ...T_NULL_ALTAR }],
  },
};

/**
 * [persistentFlag, segmentCode] per pillar, in stacking order, exactly as the
 * game lists them. segmentCode -> pillar_part_<code>.png.
 */
export const PILLAR_FLAGS: Array<Array<[string, string]>> = [
  [
    ["misc_chest_rain", "crain"],
    ["misc_util_rain", "urain"],
    ["misc_worm_rain", "wrain"],
    ["misc_greed_rain", "grain"],
    ["misc_altar_tablet", "train"],
    ["misc_mimic_potion_rain", "mrain"],
    ["misc_monk_bots", "mbots"],
    ["misc_sun_effect", "seffect"],
    ["misc_darksun_effect", "dseffect"],
    ["secret_tower", "secrett"],
    ["player_status_ghostly", "pghost"],
    ["player_status_ratty", "prat"],
    ["player_status_funky", "pfungi"],
    ["player_status_lukky", "plukki"],
    ["player_status_halo", "phalo"],
  ],
  [
    ["essence_fire", "essencef"],
    ["essence_water", "essencew"],
    ["essence_laser", "essencee"],
    ["essence_air", "essencea"],
    ["essence_alcohol", "essenceal"],
    ["secret_moon", "moon"],
    ["secret_moon2", "moona"],
    ["special_mood", "moong"],
    ["secret_dmoon", "dmoon"],
    ["dead_mood", "dmoong"],
    ["secret_sun_collision", "sunmoon"],
    ["secret_darksun_collision", "dsunmoon"],
  ],
  [
    ["progress_ending0", "end0"],
    ["progress_ending1_toxic", "endt"],
    ["progress_ending1_gold", "endb"],
    ["progress_ending2", "endg"],
    ["progress_newgameplusplus3", "endp"],
    ["progress_nightmare", "endn"],
  ],
  [
    ["miniboss_dragon", "minid"],
    ["miniboss_limbs", "minil"],
    ["miniboss_meat", "meat"],
    ["miniboss_ghost", "minigh"],
    ["miniboss_pit", "minip"],
    ["miniboss_alchemist", "minia"],
    ["miniboss_robot", "minir"],
    ["miniboss_wizard", "meme"],
    ["miniboss_maggot", "maggot"],
    ["miniboss_fish", "fish"],
    ["miniboss_islandspirit", "elk"],
    ["miniboss_threelk", "threelk"],
    ["miniboss_gate_monsters", "minigm"],
    ["final_secret_orb3", "yeah3"],
    ["miniboss_sky", "minisky"],
    ["boss_centipede", "boss"],
  ],
  [
    ["progress_orb_1", "orbf"],
    ["progress_orb_evil", "orbe"],
    ["progress_orb_all", "orba"],
    ["progress_pacifist", "pacifist"],
    ["progress_nogold", "nogold"],
    ["progress_clock", "clock"],
    ["progress_minit", "minit"],
    ["progress_nohit", "nohit"],
    ["progress_sun", "sun"],
    ["progress_darksun", "dsun"],
    ["progress_sunkill", "sunkill"],
    ["secret_supernova", "col"],
  ],
  [
    ["secret_greed", "secretg"],
    ["final_secret_orb", "yeah"],
    ["final_secret_orb2", "yeah2"],
    ["secret_chest_dark", "secretcd"],
    ["secret_chest_light", "secretcl"],
    ["card_unlocked_everything", "secretall"],
    ["card_unlocked_divide", "secretten"],
    ["secret_fruit", "secretf"],
    ["secret_allessences", "secretae"],
    ["secret_meditation", "secretme"],
    ["secret_buried_eye", "secretbe"],
    ["secret_hourglass", "secrethg"],
    ["progress_hut_a", "huta"],
    ["progress_hut_b", "hutb"],
    ["secret_null", "null"],
  ],
];

/**
 * Map the pillar's persistent flags onto the noitamap unlock keys we actually
 * receive from the mod (src/unlocks.ts UNLOCK_KEYS). Only the overlapping ones
 * are known; flags with no entry are "no data" and, in mod mode, render locked.
 */
const FLAG_TO_UNLOCK_KEY: Record<string, string> = {
  progress_orb_1: "sea_lava",
  progress_orb_all: "everything",
  miniboss_dragon: "dragon",
  miniboss_pit: "tentacle",
  miniboss_wizard: "mestari",
  secret_chest_dark: "secret_chest_dark",
  secret_chest_light: "secret_chest_light",
  card_unlocked_everything: "everything",
  card_unlocked_divide: "divide",
};

/**
 * Curated card title per achievement flag. The naive flag prettifier below
 * produced garbage for most flags ("Secret: Dmoon", "Special: Mood",
 * "Essence: Laser"). Boss/creature names and essence names are the exact
 * common.csv English values; the rest are the wiki/community names the
 * requirement phrases already use.
 */
const PILLAR_TITLES: Record<string, string> = {
  // Pillar 1 — Sacrifice & Transformation
  misc_chest_rain: "Treasure Chest Sacrifice",
  misc_util_rain: "Utility Box Sacrifice",
  misc_worm_rain: "Worm Crystal Sacrifice",
  misc_greed_rain: "Greed-Cursed Crystal Sacrifice",
  misc_altar_tablet: "Emerald Tablet Sacrifice",
  misc_mimic_potion_rain: "Potion Mimic Sacrifice",
  misc_monk_bots: "Monk Statue Sacrifice",
  misc_sun_effect: "Sunstone Sacrifice",
  misc_darksun_effect: "Dark Sunstone Sacrifice",
  secret_tower: "The Tower",
  player_status_ghostly: "Ghostly Transformation",
  player_status_ratty: "Ratty Transformation",
  player_status_funky: "Funky Transformation",
  player_status_lukky: "Lukki Transformation",
  player_status_halo: "Halo Transformation",
  // Pillar 2 — Essences
  essence_fire: "Essence of Fire",
  essence_water: "Essence of Water",
  essence_laser: "Essence of Earth",
  essence_air: "Essence of Air",
  essence_alcohol: "Essence of Spirits",
  secret_moon: "Void Moon",
  secret_moon2: "Drunk Moon",
  special_mood: "Gourd Moon",
  secret_dmoon: "Blood Moon",
  dead_mood: "Dark Gourd Moon",
  secret_sun_collision: "As Above, So Below",
  secret_darksun_collision: "As Above, So Below (Dark)",
  // Pillar 3 — Completions
  progress_ending0: "Greed Ending",
  progress_ending1_toxic: "Toxic Ending",
  progress_ending1_gold: "Pure Ending",
  progress_ending2: "Peaceful Ending",
  progress_newgameplusplus3: "New Game+++",
  progress_nightmare: "Nightmare Mode",
  // Pillar 4 — Bosses (names verbatim from common.csv animal_*)
  miniboss_dragon: "Suomuhauki",
  miniboss_limbs: "Kolmisilmän koipi",
  miniboss_meat: "Kolmisilmän sydän",
  miniboss_ghost: "Unohdettu",
  miniboss_pit: "Sauvojen tuntija",
  miniboss_alchemist: "Ylialkemisti",
  miniboss_robot: "Kolmisilmän silmä",
  miniboss_wizard: "Mestarien mestari",
  miniboss_maggot: "Limatoukka",
  miniboss_fish: "Syväolento",
  miniboss_islandspirit: "Tapion vasalli",
  miniboss_threelk: "Tapion vasalli (Threelk)",
  miniboss_gate_monsters: "Gate Guardian",
  final_secret_orb3: "Toveri",
  miniboss_sky: "Kivi",
  boss_centipede: "Kolmisilmä",
  // Pillar 5 — Accomplishments
  progress_orb_1: "One Orb of True Knowledge",
  progress_orb_evil: "Corrupted Orb",
  progress_orb_all: "All Orbs",
  progress_pacifist: "Pacifist Run",
  progress_nogold: "No-Gold Run",
  progress_clock: "5-Minute Speedrun",
  progress_minit: "1-Minute Speedrun",
  progress_nohit: "No-Hit Run",
  progress_sun: "Uusi Aurinko",
  progress_darksun: "Pimeä Aurinko",
  progress_sunkill: "Benign Sunshine",
  secret_supernova: "Supernova",
  // Pillar 6 — Secrets
  secret_greed: "Greed",
  final_secret_orb: "Friendship",
  final_secret_orb2: "Friendship 2",
  secret_chest_dark: "Dark Chest",
  secret_chest_light: "Coral Chest",
  card_unlocked_everything: "The End of Everything",
  card_unlocked_divide: "Avarice",
  secret_fruit: "Secret Fruit",
  secret_allessences: "All Essences",
  secret_meditation: "Meditation",
  secret_buried_eye: "Buried Eye",
  secret_hourglass: "Hourglass",
  progress_hut_a: "Experimental Wand (Glimmer)",
  progress_hut_b: "Experimental Wand (Requirements)",
  secret_null: "Nullifying Altar",
};

/** Human-readable achievement label from the flag (fallback for the card). */
export function pillarFlagName(flag: string): string {
  const curated = PILLAR_TITLES[flag];
  if (curated) return curated;
  return flag
    .replace(/^(misc|secret|progress|player_status|miniboss|essence|final_secret|card_unlocked|special|dead)_/, "$1: ")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Localized display title for an achievement segment. Resolution order:
 *   1. reqSpec.nameKey -> verified common.csv translation (bosses, essences);
 *      Finnish proper nouns marked "doesn't need to be translated" fall through.
 *   2. pillar.title.<flag> locale key (community/Steam names with no in-game
 *      term; per-locale values derived from the approved pillar.req phrases).
 *   3. The curated English title (poi.name / PILLAR_TITLES).
 * Translators injected to keep this module free of i18n imports.
 */
export function pillarSegmentTitle(
  poi: { flag?: string; name?: string; reqSpec?: PillarReqSpec },
  translateItem: (key: string) => string,
  t: (key: string, defaultValue: string) => string,
): string {
  const flag = String(poi.flag || "");
  const nameKey = poi.reqSpec?.nameKey ?? PILLAR_REQUIREMENTS[flag]?.nameKey;
  if (nameKey) {
    const tr = translateItem(nameKey);
    if (tr && tr !== nameKey) return tr;
  }
  const fallback = poi.name || pillarFlagName(flag);
  return t(`pillar.title.${flag}`, fallback);
}

export interface PillarSegmentPOI {
  type: "item";
  item: "pillar_segment";
  x: number;
  y: number;
  flag: string;
  segCode: string;
  name: string;
  locked: boolean;
  biome: string;
  wiki: string;
  pillarIndex: number;
  theme: string;
  reqSpec?: PillarReqSpec;
}

export function isAchievementPillarSegment(poi: any): boolean {
  return (
    poi?.type === "item" &&
    poi.item === "pillar_segment" &&
    !String(poi.flag || "").startsWith("__struct")
  );
}

/**
 * Build every pillar segment POI for the Achievement Pillars centred at
 * (baseX, baseY). `isUnlocked(flag)` decides colour vs grayscale. Plain
 * structural segments (base/fade/cap) are emitted as always-unlocked decoration.
 */
export function buildPillarSegments(
  baseX: number,
  baseY: number,
  isUnlocked: (flag: string) => boolean,
): PillarSegmentPOI[] {
  const out: PillarSegmentPOI[] = [];
  // Markers render centred on (x,y); the lua positions are top-left, so offset
  // by half a segment to keep the 48px tiles stacking seamlessly.
  const seg = (
    x: number,
    y: number,
    segCode: string,
    flag: string,
    name: string,
    locked: boolean,
    pillarIndex: number,
  ): void => {
    out.push({
      type: "item",
      item: "pillar_segment",
      x: x + SIZE / 2,
      y: y + SIZE / 2,
      flag,
      segCode,
      name,
      locked,
      biome: "mountain_tree",
      wiki:
        PILLAR_REQUIREMENTS[flag]?.wiki ??
        `https://noita.wiki.gg/wiki/Achievement_Pillars#${PILLAR_SECTIONS[pillarIndex]}`,
      pillarIndex,
      theme: PILLAR_THEMES[pillarIndex],
      reqSpec: PILLAR_REQUIREMENTS[flag],
    });
  };

  for (let i = 0; i < COUNT; i++) {
    const px = baseX - COUNT * INC * 0.5 + i * INC;

    // fade cap just below the base, then the base segment at baseY
    seg(px, baseY + SIZE, "fade", `__struct_fade_${i}`, "Pillar", false, i);
    seg(px, baseY, "", `__struct_base_${i}`, "Pillar", false, i);

    // 3 plain segments above the base
    let py = baseY;
    for (let j = 0; j < ABOVE; j++) {
      py -= SIZE;
      seg(px, py, "", `__struct_plain_${i}_${j}`, "Pillar", false, i);
    }

    // one engraved segment per achievement, stacking upward
    for (const [flag, segCode] of PILLAR_FLAGS[i]) {
      py -= SIZE;
      seg(px, py, segCode, flag, pillarFlagName(flag), !isUnlocked(flag), i);
    }

    // end cap on top
    py -= SIZE;
    const cap = END_CAPS[i % END_CAPS.length];
    seg(px, py, cap, `__struct_cap_${i}`, "Pillar", false, i);
  }
  return out;
}

/** World anchor of the Achievement Pillars structure (matches the adapter). */
export const PILLAR_BASE = { x: -1536, y: -1340 };

/** Centre X of pillar column `i` (mirrors buildPillarSegments layout). */
export function pillarColumnX(pillarIndex: number): number {
  return PILLAR_BASE.x - COUNT * INC * 0.5 + pillarIndex * INC + SIZE / 2;
}

/**
 * Forward resolver: given an achievement flag, return the pillar column it lives
 * in (and a travel anchor). Used for the dynamic reverse button — when a POI is
 * reached by clicking a specific pillar segment's link, the button should lead
 * back to THAT pillar, not the POI's default association. Returns null for an
 * unknown flag.
 */
export function pillarLocationForFlag(flag: string): { pillarIndex: number; flag: string; x: number; y: number } | null {
  for (let i = 0; i < PILLAR_FLAGS.length; i++) {
    if (PILLAR_FLAGS[i].some(([f]) => f === flag)) {
      return { pillarIndex: i, flag, x: pillarColumnX(i), y: PILLAR_BASE.y - 4 * SIZE };
    }
  }
  return null;
}

/**
 * Reverse association: given an arbitrary map POI, return the pillar it belongs
 * to (so its card can show a "Pillar" button that flies to that column). Built
 * from the same PILLAR_REQUIREMENTS targets used for the forward links, so the
 * two directions can never drift. Returns null when the POI isn't tied to any
 * achievement segment.
 */
export function poiPillarAssociation(poi: any): { pillarIndex: number; flag: string; x: number; y: number } | null {
  if (!poi) return null;
  const type = String(poi.type || "");
  const item = String(poi.item || "");
  const material = String(poi.material || "");
  const chestVariant = String(poi.chestVariant || "");
  const perk = item === "perk" ? String(poi.perk || "").toLowerCase() : "";
  // Entity id: generated POIs carry a full xml path, manual ones a bare id.
  const entity =
    type === "entity"
      ? String(poi.entity || "")
          .toLowerCase()
          .replace(/\.xml$/, "")
          .split("/")
          .pop() || ""
      : "";

  const perkInTarget = (t: PillarTarget | undefined) => !!(perk && t?.searchPerks?.includes(perk));

  // Two passes: specific identity (item/material/chestVariant/entity/perk)
  // first, generic POI-type matches second. Otherwise the steel/dark/coral
  // chests would associate with the "sacrifice a chest" segment, whose generic
  // chest target wins by pillar order over their own achievements.
  for (const specificOnly of [true, false]) {
    for (let i = 0; i < PILLAR_FLAGS.length; i++) {
      for (const [flag] of PILLAR_FLAGS[i]) {
        const spec = PILLAR_REQUIREMENTS[flag];
        if (!spec) continue;
        // Identity fields may live on target (tmpl {{name}} links) or on
        // phraseTarget (whole-phrase links, e.g. the orb search).
        const t = spec.target ?? spec.phraseTarget;
        let hit: boolean;
        if (specificOnly) {
          const matchItem = !!(t?.itemId && t.itemId === item);
          const matchMat = !!(t?.material && t.material === material);
          const matchChest = !!(t?.chestVariant && t.chestVariant === chestVariant);
          // Entities are referenced from links (e.g. Kauhuhirviö on the
          // friendship segment), not targets.
          const matchEntity = !!(entity && (spec.links ?? []).some((l) => l.entity === entity));
          // Transformation perks: any perk that adds a level toward the
          // segment's transformation (phrase link searchPerks or halo chips).
          const matchPerk =
            perkInTarget(t) || perkInTarget(spec.phraseTarget) || (spec.links ?? []).some((l) => perkInTarget(l));
          hit = matchItem || matchMat || matchChest || matchEntity || matchPerk;
        } else {
          hit = !!((spec.targetType && spec.targetType === type) || (t?.targetType && t.targetType === type));
        }
        if (hit) {
          return { pillarIndex: i, flag, x: pillarColumnX(i), y: PILLAR_BASE.y - 4 * SIZE };
        }
      }
    }
  }
  return null;
}

/**
 * Predicate factory for the spell-unlock fallback (`&u=`). unlocks === null ->
 * daily / no-mod: everything unlocked. Otherwise a pillar flag is unlocked only
 * if it maps (FLAG_TO_UNLOCK_KEY) to a spell key the mod reported. This is the
 * coarse fallback used when the dedicated pillar channel (`&p=`) is absent; see
 * makePillarUnlockPredicateFromFlags for the accurate path.
 */
export function makePillarUnlockPredicate(unlocks: string[] | null | undefined): (flag: string) => boolean {
  if (unlocks == null) return () => true;
  const set = new Set(unlocks);
  return (flag: string) => {
    const key = FLAG_TO_UNLOCK_KEY[flag];
    return key != null && set.has(key);
  };
}

/**
 * Accurate predicate from the dedicated pillar channel (`&p=`, src/
 * pillars-unlocks.ts): the mod reports the raw achievement flags it read via
 * HasFlagPersistent, so a segment is unlocked iff its flag is in that set.
 */
export function makePillarUnlockPredicateFromFlags(flags: string[]): (flag: string) => boolean {
  const set = new Set(flags);
  return (flag: string) => set.has(flag);
}

export interface PillarPlace {
  /** Rounded "x,y" key — stable id + reverse-association match. */
  key: string;
  label: string;
  labelKey?: string;
  wiki?: string;
  x: number;
  y: number;
  /** Pillar column this place belongs to (for the reverse "Pillar" button). */
  pillarIndex: number;
  flag: string;
}

/**
 * Fixed world places referenced by pillar links that carry coords (Mountain
 * Altar, Nullifying Altar, The Tower, Moon, ...). These have no generated POI
 * and no atlas sprite — instead they get an invisible click-only marker (see
 * poi-spatial-index buildMarkerData) and a search-only synthetic POI (see
 * unifiedsearch getPillarPlacePOIs), so closing their card isn't permanent:
 * the spot stays clickable and the place name stays searchable.
 *
 * Built by scanning PILLAR_REQUIREMENTS so it can never drift from the links.
 * Deduped by rounded coords; first occurrence wins the pillar association.
 */
export const PILLAR_PLACES: PillarPlace[] = (() => {
  const out: PillarPlace[] = [];
  const seen = new Set<string>();
  const consider = (link: PillarLink | undefined, pillarIndex: number, flag: string): void => {
    if (!link || typeof link.x !== "number" || typeof link.y !== "number") return;
    const key = `${Math.round(link.x)},${Math.round(link.y)}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      key,
      label: link.label ?? "",
      labelKey: link.labelKey,
      wiki: link.wiki,
      x: link.x,
      y: link.y,
      pillarIndex,
      flag,
    });
  };
  for (let i = 0; i < PILLAR_FLAGS.length; i++) {
    for (const [flag] of PILLAR_FLAGS[i]) {
      const spec = PILLAR_REQUIREMENTS[flag];
      if (!spec) continue;
      for (const l of spec.links ?? []) consider(l, i, flag);
    }
  }
  return out;
})();

/** Reverse association for a synthesized pillar_place POI, matched by coords. */
export function pillarPlaceAssociation(poi: any): { pillarIndex: number; flag: string; x: number; y: number } | null {
  if (!poi || poi.type !== "pillar_place") return null;
  const key = `${Math.round(poi.x)},${Math.round(poi.y)}`;
  const place = PILLAR_PLACES.find((p) => p.key === key);
  if (!place) return null;
  return { pillarIndex: place.pillarIndex, flag: place.flag, x: pillarColumnX(place.pillarIndex), y: PILLAR_BASE.y - 4 * SIZE };
}
