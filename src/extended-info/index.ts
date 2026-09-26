/**
 * extended-info: lazy loaders for the bartender JSONs (creatures, spells,
 * materials, status effects, reaction roles) plus the auth-gated section
 * builder used by popups in overlays.ts and telescope-osd-bridge.ts.
 *
 * Free users never receive the extended values: we render a placeholder with
 * a "Sign in with Patreon" CTA and skip the fetch entirely. Pro users trigger
 * a one-time fetch per data set on first popup.
 */

import i18next from "../i18n";
import { authService } from "../auth/auth-service";
import { AuthUI } from "../auth/auth-ui";
import { gameTranslator } from "../game-translations/translator";
import { CREATURE_DATA } from "../data/creature-data";
import { attachHoverPopover, attachWikiLinkPopover, dismissPopovers, hidePopovers } from "../popover-util";
import { navigateCreatureSpawns, onCreatureSpawnNavigationChanged, resolveCreatureSpawns, type CreatureSpawnMode } from "../creature-spawn-navigation";

const BARTENDER_BASE = "https://bartender.runfast.stream";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ExtendedCreature {
  id: string;
  name?: string | null;
  alias?: string | null;
  category?: string | null;
  faction?: string | null;
  health?: string | null;
  attackType?: string | null;
  spawnLocation?: string | null;
  ngplusSpawnLocation?: string | null;
  immunities?: string | null;
  blood?: string | null;
  corpse?: string | null;
  blood_material_id?: string | null;
  corpse_material_id?: string | null;
  dmgMultMelee?: string | null;
  dmgMultProjectile?: string | null;
  dmgMultSlice?: string | null;
  dmgMultExplosion?: string | null;
  dmgMultElectricity?: string | null;
  dmgMultFire?: string | null;
  dmgMultIce?: string | null;
  dmgMultDrill?: string | null;
  dmgMultRadioactive?: string | null;
  dmgMultHoly?: string | null;
  dmgMultNotes?: string | null;
  chaosPolymorph?: string | null;
  unstablePolymorph?: string | null;
  [k: string]: any;
}

export interface ExtendedSpell {
  id: string;
  name?: string;
  description?: string | null;
  type?: string | null;
  manaDrain?: number | null;
  uses?: number | null;
  damageProjectile?: number | null;
  damageMelee?: number | null;
  damageElectric?: number | null;
  damageFire?: number | null;
  damageExplosion?: number | null;
  damageIce?: number | null;
  damageSlice?: number | null;
  damageDrill?: number | null;
  damageHealing?: number | null;
  damageHoly?: number | null;
  radius?: number | null;
  speed?: string | number | null;
  spread?: number | null;
  lifetime?: number | null;
  castDelay?: string | null;
  rechargeDelay?: string | null;
  recoil?: string | null;
  bounces?: string | null;
  criticalChance?: string | null;
  spellTier?: string[] | null;
  spawnProbability?: string[] | null;
  unlockCondition?: string | null;
  price?: number | null;
  tags?: string[] | null;
  [k: string]: any;
}

export interface ExtendedMaterial {
  id: string;
  name?: string;
  ui_name?: string;
  cell_type?: string;
  type?: string;
  density?: number;
  hardness?: number;
  durability?: number;
  crackability?: number;
  liquid_viscosity?: number;
  liquid_gravity?: number;
  electrical_conductivity?: boolean;
  slippery?: boolean;
  burnable?: boolean;
  on_fire?: boolean;
  autoignition_temperature?: number;
  temperature_of_fire?: number;
  cold_freezes_to_material_name?: string;
  warmth_melts_to_material?: number | string;
  tags?: string[];
  danger_fire?: boolean;
  danger_radioactive?: boolean;
  danger_poison?: boolean;
  danger_water?: boolean;
  stain_effects?: { id: number; duration: number }[];
  ingestion_effects?: { id: number; duration: number }[];
  parent_material?: string | null;
  wikipage?: string;
  graphics?: { color?: string | null; [k: string]: any };
  [k: string]: any;
}

interface StatusEffect {
  statusId: string;
  name: string | null;
  description: string | null;
}

type ReactionRoles = Record<string, [number, number]>; // [reagent, product]

// ─── Lazy fetchers ───────────────────────────────────────────────────────────

let creaturesById: Map<string, ExtendedCreature> | null = null;
let creaturesLoading: Promise<void> | null = null;
let creatureNameToId: Map<string, string> | null = null;

let spellsById: Map<string, ExtendedSpell> | null = null;
let spellsLoading: Promise<void> | null = null;

let materialsById: Map<string, ExtendedMaterial> | null = null;
let materialsLoading: Promise<void> | null = null;

let reactionRoles: ReactionRoles | null = null;
let reactionRolesLoading: Promise<void> | null = null;

let statusEffects: StatusEffect[] | null = null;
let statusEffectsLoading: Promise<void> | null = null;

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: "force-cache" });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json() as Promise<T>;
}

/**
 * Slugify a string for use as a synthetic creature id. Mirrors the build-time
 * slugify in generate-creature-data.cjs so synthetic ids generated here align
 * with those bundled into CREATURE_DATA.
 */
function slugifyId(s: string | null | undefined): string {
  if (!s) return "";
  return String(s)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function syntheticCreatureId(c: ExtendedCreature, taken: { has(id: string): boolean }): string | null {
  const base = slugifyId(c.alias || c.name || "");
  if (!base) return null;
  const candidates = [
    `_${base}`,
    `_${base}__${slugifyId(c.wikipage || "")}`,
    `_${base}__${slugifyId(c.name || "")}`,
  ].filter((x) => x && !x.endsWith("__"));
  for (const id of candidates) {
    if (!taken.has(id)) return id;
  }
  let i = 2;
  while (taken.has(`_${base}_${i}`)) i++;
  return `_${base}_${i}`;
}

export async function loadExtendedCreatures(): Promise<void> {
  if (creaturesById) return;
  if (creaturesLoading) return creaturesLoading;
  creaturesLoading = (async () => {
    try {
      const list = await fetchJson<ExtendedCreature[]>("assets/full_creatures.json");
      const m = new Map<string, ExtendedCreature>();
      const nm = new Map<string, string>();
      for (const c of list) {
        if (!c) continue;
        let id = c.id;
        if (!id) {
          // Some entries (traps, nests, boss orbs, crystals) have no native id.
          // Synthesise one so they're still keyed in the map and discoverable
          // by name/alias lookups.
          const synth = syntheticCreatureId(c, m);
          if (!synth) continue;
          id = synth;
          (c as ExtendedCreature).id = id;
        }
        if (!m.has(id)) m.set(id, c);
        const nameKey = (c.name || "").toLowerCase().trim();
        if (nameKey && !nm.has(nameKey)) nm.set(nameKey, id);
        const aliasKey = (c.alias || "").toLowerCase().trim();
        if (aliasKey && !nm.has(aliasKey)) nm.set(aliasKey, id);
      }
      creaturesById = m;
      creatureNameToId = nm;
    } catch (err) {
      console.warn("[extended-info] full_creatures.json load failed:", err);
      creaturesById = new Map();
      creatureNameToId = new Map();
    } finally {
      creaturesLoading = null;
    }
  })();
  return creaturesLoading;
}

export function getExtendedCreature(id: string): ExtendedCreature | null {
  return creaturesById?.get(id) ?? null;
}

export function getCreatureIdByName(name: string): string | null {
  if (!creatureNameToId) return null;
  return creatureNameToId.get(name.toLowerCase().trim()) ?? null;
}

export async function loadExtendedSpells(): Promise<void> {
  if (spellsById) return;
  if (spellsLoading) return spellsLoading;
  spellsLoading = (async () => {
    try {
      const list = await fetchJson<ExtendedSpell[]>("assets/full_spells.json");
      const m = new Map<string, ExtendedSpell>();
      for (const s of list) {
        if (!s?.id) continue;
        if (!m.has(s.id)) m.set(s.id, s);
      }
      spellsById = m;
    } catch (err) {
      console.warn("[extended-info] full_spells.json load failed:", err);
      spellsById = new Map();
    } finally {
      spellsLoading = null;
    }
  })();
  return spellsLoading;
}

export function getExtendedSpell(id: string): ExtendedSpell | null {
  return spellsById?.get(id) ?? null;
}

export async function loadExtendedMaterials(): Promise<void> {
  if (materialsById) return;
  if (materialsLoading) return materialsLoading;
  materialsLoading = (async () => {
    try {
      const list = await fetchJson<ExtendedMaterial[]>("assets/full_materials.json");
      const m = new Map<string, ExtendedMaterial>();
      for (const mat of list) {
        if (!mat?.id) continue;
        if (!m.has(mat.id)) m.set(mat.id, mat);
      }
      materialsById = m;
    } catch (err) {
      console.warn("[extended-info] full_materials.json load failed:", err);
      materialsById = new Map();
    } finally {
      materialsLoading = null;
    }
  })();
  return materialsLoading;
}

export function getExtendedMaterial(id: string): ExtendedMaterial | null {
  return materialsById?.get(id) ?? null;
}

export async function loadReactionRoles(): Promise<void> {
  if (reactionRoles) return;
  if (reactionRolesLoading) return reactionRolesLoading;
  reactionRolesLoading = (async () => {
    try {
      reactionRoles = await fetchJson<ReactionRoles>("assets/reaction_roles.json");
    } catch (err) {
      console.warn("[extended-info] reaction_roles.json load failed:", err);
      reactionRoles = {};
    } finally {
      reactionRolesLoading = null;
    }
  })();
  return reactionRolesLoading;
}

export function getReactionRoles(materialId: string): { asReagent: boolean; asResult: boolean } {
  const e = reactionRoles?.[materialId];
  return { asReagent: !!(e && e[0]), asResult: !!(e && e[1]) };
}

export async function loadStatusEffects(): Promise<void> {
  if (statusEffects) return;
  if (statusEffectsLoading) return statusEffectsLoading;
  statusEffectsLoading = (async () => {
    try {
      statusEffects = await fetchJson<StatusEffect[]>("assets/material_effects.json");
    } catch (err) {
      console.warn("[extended-info] material_effects.json load failed:", err);
      statusEffects = [];
    } finally {
      statusEffectsLoading = null;
    }
  })();
  return statusEffectsLoading;
}

/**
 * Resolve a stain/ingestion effect id from FULL_MATERIALS_FINAL.json into a
 * status effect entry. The materials JSON uses 1-based indices into noita's
 * canonical status_list.lua order, so we subtract 1 before indexing.
 */
function getStatusEffect(materialEffectId: number): StatusEffect | null {
  if (!statusEffects) return null;
  const idx = materialEffectId - 1;
  if (idx < 0) return null;
  return statusEffects[idx] ?? null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function isProUser(): boolean {
  const s = authService.getState();
  return s.authenticated && s.isSubscriber;
}

export function bartenderReagentLink(materialId: string): string {
  return `${BARTENDER_BASE}/reactions?reagents=${encodeURIComponent(materialId)}`;
}

export function bartenderProductLink(materialId: string): string {
  return `${BARTENDER_BASE}/reactions?product=${encodeURIComponent(materialId)}`;
}

/**
 * Bartender's material type slug for CSS coloring (.material-type-{slug}).
 * Uses cell_type primarily; the JSON's `type` field is sometimes a free-form
 * label like "Volatile liquid" which doesn't match the bartender slug set.
 */
function materialTypeSlug(m: ExtendedMaterial): string {
  // Prefer the wiki-derived `type` field — the engine's `cell_type` is
  // misleading (Noita marks many powders/solids as "liquid" internally).
  const wt = (m.type || "").toLowerCase();
  if (wt === "liquid") return "liquid";
  if (wt === "solid") return "solid";
  if (wt === "gas") return "gas";
  if (wt === "fire") return "fire";
  if (wt === "powder") return "powder";
  if (wt === "acid") return "acid";
  if (wt && wt !== "no type") return wt;

  // Fallback to cell_type only when type is absent / "no type".
  const ct = (m.cell_type || "").toLowerCase();
  if (ct === "liquid") return "liquid";
  if (ct === "solid") return "solid";
  if (ct === "gas") return "gas";
  if (ct === "fire") return "fire";
  if (ct === "powder" || ct === "sand") return "powder";
  return ct || "solid";
}

/** Display name for the material type, matching bartender's casing. */
function materialTypeLabel(slug: string): string {
  switch (slug) {
    case "liquid":
      return i18next.t("extended.matType.liquid", "Liquid");
    case "solid":
      return i18next.t("extended.matType.solid", "Solid");
    case "gas":
      return i18next.t("extended.matType.gas", "Gas");
    case "fire":
      return i18next.t("extended.matType.fire", "Fire");
    case "powder":
      return i18next.t("extended.matType.powder", "Powder");
    default:
      return i18next.t(`extended.matType.${slug}`, slug.charAt(0).toUpperCase() + slug.slice(1));
  }
}

// Immunities are translated via flat `extended.immunity.<slug>` keys baked
// into every locale's translation.json. The slug is derived from the wiki
// token by lowercasing and replacing non-alphanumerics with underscores —
// this is just key normalisation, not a translation lookup. Translators edit
// the EN/JA/etc. values in the JSON directly.
function immunitySlug(token: string): string {
  return token
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

// Capitalise the first character if it's a Latin letter; leave non-Latin
// scripts (Cyrillic, CJK) alone since case rules differ.
function capFirst(s: string): string {
  if (!s) return s;
  const c = s.charAt(0);
  return c >= "a" && c <= "z" ? c.toUpperCase() + s.slice(1) : s;
}

function translateImmunityToken(token: string): string {
  const t = token.trim();
  if (!t) return token;
  const slug = immunitySlug(t);
  if (!slug) return capFirst(t);
  return i18next.t(`extended.immunity.${slug}`, { defaultValue: capFirst(t) });
}

function translateImmunities(s: string | null | undefined): string {
  const cleaned = stripWiki(s);
  if (!cleaned) return "";
  return cleaned
    .split(",")
    .map((p) => translateImmunityToken(p))
    .filter(Boolean)
    .join(", ");
}

// ─── Biome name translation ──────────────────────────────────────────────────
// Spawn-location names from the wiki (e.g. "Coal Pits") are translated through
// flat `extended.spawn.<slug>` keys that live in every locale's translation.json
// — populated once by build_scripts/bake-spawn-translations.cjs. Translators
// edit those JSON values directly; nothing here decides what a name maps to.
function spawnSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/&#?\w+;/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function translateBiomeName(rawName: string): string {
  const name = rawName.trim();
  if (!name) return name;
  const slug = spawnSlug(name);
  if (!slug) return name;
  return i18next.t(`extended.spawn.${slug}`, { defaultValue: name });
}

function translateBiomeList(s: string | null | undefined): string {
  const cleaned = stripWiki(s);
  if (!cleaned) return "";
  return cleaned
    .split(",")
    .map((p) => translateBiomeName(p))
    .filter(Boolean)
    .join(", ");
}

/** One destination action for the whole spawn list, using the report's map glyph. */
function creatureSpawnRow(label: string, rawSpawn: string, creatureId: string, mode: CreatureSpawnMode = 'normal'): HTMLElement | null {
  const locations = translateBiomeList(rawSpawn);
  const result = row(label, locations, "prose");
  if (!result) return null;
  const available = resolveCreatureSpawns(rawSpawn, mode);

  const value = result.querySelector<HTMLElement>(".extended-info-value")!;
  value.classList.add("extended-info-spawn-value");
  if (available.canNavigate) {
    const link = document.createElement("button");
    link.type = "button";
    link.className = "creature-spawn-link";
    link.textContent = locations;
    const action = i18next.t("extended.showSpawnBiomes", "Show spawn biomes on map");
    link.title = action;
    link.setAttribute("aria-label", `${action}: ${locations}`);
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("viewBox", "0 0 24 24");
    icon.setAttribute("fill", "currentColor");
    icon.setAttribute("aria-hidden", "true");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", "M12 2C8.1 2 5 5.1 5 9c0 5.2 7 13 7 13s7-7.8 7-13c0-3.9-3.1-7-7-7zm0 9.5a2.5 2.5 0 110-5 2.5 2.5 0 010 5z");
    icon.append(path);
    link.append(icon);
    link.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      // A card can survive until the next auth render; recheck access at action time.
      if (isProUser()) navigateCreatureSpawns(rawSpawn, link, mode, creatureId);
    });
    value.replaceChildren(link);
  }
  if (available.missing.length) {
    const missing = document.createElement("span");
    missing.className = "creature-spawn-missing";
    missing.textContent = i18next.t("extended.spawnMapMissing", {
      defaultValue: "Not shown on this map: {{locations}}",
      locations: available.missing.map(name => translateBiomeList(name)).join(", "),
    });
    value.append(missing);
  }
  return result;
}

/**
 * Walk up from `el` to find an enclosing popup (static OSD overlay popup or
 * telescope marker tooltip) and dismiss it. Used by the CTA click handler so
 * the auth modal isn't visually buried under the popup.
 */
export function dismissEnclosingPopup(el: HTMLElement): void {
  const tooltip = el.closest(".marker-tooltip") as HTMLElement | null;
  if (tooltip) {
    const close = (tooltip as HTMLElement & { __close?: () => void }).__close;
    if (close) close();
    else {
      dismissPopovers(tooltip);
      tooltip.remove();
    }
    return;
  }
  const popup = el.closest(".osOverlayPopup") as HTMLElement | null;
  if (popup) {
    hidePopovers(popup);
    popup.style.display = "none";
    const parent = popup.parentElement;
    if (parent) {
      const onLeave = () => {
        popup.style.display = "";
        parent.removeEventListener("mouseleave", onLeave);
      };
      parent.addEventListener("mouseleave", onLeave);
    }
  }
}

// ─── Section builder ─────────────────────────────────────────────────────────

export type ExtendedKind = "creature" | "spell" | "material";

// Single global languageChanged listener that re-renders ONLY currently
// visible extended-info sections. Hidden popups (visibility:hidden /
// display:none / opacity:0 — every osOverlayPopup that hasn't been hovered)
// are marked stale and re-render the next time the user hovers their popup,
// via the document-level mouseover hook below. This matters because re-
// rendering all sections on every language change forces the lazy
// full_creatures / full_spells / full_materials JSON loads (~3.4 MB total)
// for pro users on the very first switch, which made it feel like FOREVER.
let langListenerInstalled = false;
function isSectionVisible(sec: HTMLElement): boolean {
  const popup = sec.closest(".marker-tooltip, .osOverlayPopup") as HTMLElement | null;
  const target = popup ?? sec;
  if (!target.isConnected) return false;
  const cs = getComputedStyle(target);
  if (cs.display === "none") return false;
  if (cs.visibility === "hidden") return false;
  if (parseFloat(cs.opacity) === 0) return false;
  return true;
}

function ensureLangListener(): void {
  if (langListenerInstalled) return;
  langListenerInstalled = true;
  // Static creature cards can be constructed before the map registers its
  // navigation callback. Refresh visible cards, reusing the lazy refresh for
  // hidden cards instead of fetching every creature as soon as the map starts.
  onCreatureSpawnNavigationChanged(() => {
    document.querySelectorAll<HTMLElement>(".extended-info-section[data-extended-kind='creature']").forEach(wrap => {
      const render = (wrap as HTMLElement & { __rerender?: () => void }).__rerender;
      if (!render) return;
      if (isSectionVisible(wrap)) render();
      else wrap.dataset.langStale = "1";
    });
  });
  i18next.on("languageChanged", () => {
    document.querySelectorAll<HTMLElement>(".extended-info-section").forEach((wrap) => {
      const fn = (wrap as any).__rerender as (() => void) | undefined;
      if (typeof fn !== "function") return;
      const header = wrap.querySelector<HTMLElement>(".extended-info-header");
      if (header) header.textContent = i18next.t("extended.title", "Extended info");
      if (isSectionVisible(wrap)) {
        fn();
      } else {
        wrap.dataset.langStale = "1";
      }
    });
  });

  // ONE document-level mouseover that flushes any stale section in the
  // popup the user is now hovering. Cheap when nothing is stale (no DOM
  // queries hit). No per-section listener accumulation.
  document.addEventListener(
    "mouseover",
    (e) => {
      const t = e.target;
      if (!(t instanceof Element)) return;
      const popup = t.closest(".osOverlayPopup, .marker-tooltip");
      if (!popup) return;
      const stale = popup.querySelectorAll<HTMLElement>(".extended-info-section[data-lang-stale='1']");
      if (stale.length === 0) return;
      stale.forEach((sec) => {
        delete sec.dataset.langStale;
        const fn = (sec as any).__rerender as (() => void) | undefined;
        if (typeof fn === "function") fn();
      });
    },
    { passive: true },
  );
}

export function buildExtendedSection(kind: ExtendedKind, id: string): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "extended-info-section";
  wrap.dataset.extendedKind = kind;
  wrap.dataset.extendedId = id;

  const header = document.createElement("div");
  header.className = "extended-info-header";
  header.textContent = i18next.t("extended.title", "Extended info");
  wrap.appendChild(header);

  const body = document.createElement("div");
  body.className = "extended-info-body";
  wrap.appendChild(body);

  let renderVersion = 0;
  const render = () => {
    const version = ++renderVersion;
    dismissPopovers(body);
    body.replaceChildren();
    if (!isProUser()) {
      wrap.style.display = "";
      header.textContent = i18next.t("extended.title", "Extended info");
      body.appendChild(renderProPlaceholder(kind));
      return;
    }
    renderProBody(wrap, body, kind, id, () => version === renderVersion && isProUser() && wrap.isConnected);
  };

  (wrap as any).__rerender = render;
  render();
  ensureLangListener();

  const unsubAuth = authService.subscribe(() => {
    if (!wrap.isConnected) {
      unsubAuth();
      return;
    }
    render();
  });

  return wrap;
}

export function buildExtendedCreatureSectionByName(name: string, aliases?: string[]): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "extended-info-section";
  wrap.dataset.extendedKind = "creature";
  wrap.dataset.extendedName = name;

  const header = document.createElement("div");
  header.className = "extended-info-header";
  header.textContent = i18next.t("extended.title", "Extended info");
  wrap.appendChild(header);

  const body = document.createElement("div");
  body.className = "extended-info-body";
  wrap.appendChild(body);

  const tryNames = [name, ...(aliases ?? [])];

  let renderVersion = 0;
  const render = () => {
    const version = ++renderVersion;
    dismissPopovers(body);
    body.replaceChildren();
    if (!isProUser()) {
      wrap.style.display = "";
      body.appendChild(renderProPlaceholder("creature"));
      return;
    }
    const loading = document.createElement("div");
    loading.className = "extended-info-loading";
    loading.textContent = i18next.t("extended.loading", "Loading...");
    body.appendChild(loading);
    loadExtendedCreatures().then(() => {
      if (version !== renderVersion || !isProUser() || !wrap.isConnected) return;
      let id: string | null = null;
      for (const n of tryNames) {
        if (!n) continue;
        id = getCreatureIdByName(n);
        if (id) break;
      }
      dismissPopovers(body);
      body.replaceChildren();
      const node = id ? renderCreature(id) : null;
      if (node) {
        body.appendChild(node);
      } else {
        wrap.style.display = "none";
      }
    });
  };

  (wrap as any).__rerender = render;
  render();
  ensureLangListener();

  const unsubAuth = authService.subscribe(() => {
    if (!wrap.isConnected) {
      unsubAuth();
      return;
    }
    render();
  });
  return wrap;
}

// Each preview field is [i18n key, English fallback]. The fallback also doubles
// as the lookup into SKELETON_WIDTHS so the skeleton width stays stable
// regardless of locale.
const PREVIEW_FIELDS: Record<ExtendedKind, Array<[string, string]>> = {
  creature: [
    ["extended.row.faction", "Faction"],
    ["extended.row.hp", "HP"],
    ["extended.row.attacks", "Attacks"],
    ["extended.row.immunities", "Immunities"],
    ["extended.row.spawn", "Spawn"],
    ["extended.row.blood", "Blood"],
    ["extended.dmgMults", "Damage multipliers"],
  ],
  spell: [
    ["extended.row.type", "Type"],
    ["extended.row.mana", "Mana"],
    ["extended.row.castDelay", "Cast delay"],
    ["extended.row.rechargeTime", "Recharge time"],
    ["extended.row.speed", "Speed"],
    ["extended.damage", "Damage"],
    ["extended.row.spread", "Spread"],
  ],
  material: [
    ["extended.row.type", "Type"],
    ["extended.row.density", "Density"],
    ["extended.row.hardness", "Hardness"],
    ["extended.row.viscosity", "Viscosity"],
    ["extended.row.burnable", "Burnable"],
    ["extended.row.dangers", "Dangers"],
    ["extended.row.tags", "Tags"],
    ["extended.row.reactions", "Reactions"],
  ],
};

/** Realistic skeleton widths per field label so the placeholder looks plausible. */
const SKELETON_WIDTHS: Record<string, string> = {
  // creature
  Faction: "5em",
  HP: "2.5em",
  Attacks: "7em",
  Immunities: "6em",
  Spawn: "4em",
  Blood: "4.5em",
  "Damage multipliers": "8em",
  // spell
  Type: "4em",
  Mana: "2em",
  "Cast delay": "3em",
  "Recharge time": "3em",
  Speed: "2.5em",
  Damage: "3em",
  Spread: "2em",
  // material
  Density: "3em",
  Hardness: "2.5em",
  Viscosity: "3em",
  Burnable: "2em",
  Dangers: "5em",
  Tags: "6em",
  Reactions: "5em",
};

function renderProPlaceholder(kind: ExtendedKind): HTMLElement {
  const placeholder = document.createElement("div");
  placeholder.className = "extended-info-placeholder pro-accent";

  const fields = document.createElement("div");
  fields.className = "extended-info-placeholder-fields";
  for (const [i18nKey, fallback] of PREVIEW_FIELDS[kind]) {
    const l = document.createElement("span");
    l.className = "extended-info-label";
    l.textContent = `${i18next.t(i18nKey, fallback)}:`;
    const skel = document.createElement("span");
    skel.className = "extended-info-skeleton";
    if (SKELETON_WIDTHS[fallback]) skel.style.width = SKELETON_WIDTHS[fallback];
    fields.appendChild(l);
    fields.appendChild(skel);
  }
  placeholder.appendChild(fields);

  const cta = document.createElement("button");
  cta.type = "button";
  cta.className = "btn btn-sm extended-info-cta";
  cta.textContent = i18next.t("extended.cta", "Unlock with Pro");
  cta.addEventListener("click", (e) => {
    e.stopPropagation();
    dismissEnclosingPopup(cta);
    AuthUI.showGetProModal();
  });
  placeholder.appendChild(cta);

  return placeholder;
}

function renderProBody(
  wrap: HTMLElement,
  body: HTMLElement,
  kind: ExtendedKind,
  id: string,
  isCurrent: () => boolean,
): void {
  const loading = document.createElement("div");
  loading.className = "extended-info-loading";
  loading.textContent = i18next.t("extended.loading", "Loading...");
  body.appendChild(loading);

  const fill = (cb: () => HTMLElement | null) => {
    // Language/auth changes or closing the card can outlive a lazy fetch.
    // Only the current attached card may create body-mounted popovers.
    if (!isCurrent()) return;
    const node = cb();
    dismissPopovers(body);
    body.replaceChildren();
    if (node) {
      wrap.style.display = "";
      body.appendChild(node);
    } else {
      // No extended data — hide the whole section rather than show an empty stub.
      wrap.style.display = "none";
    }
  };

  if (kind === "creature") {
    loadExtendedCreatures().then(() => fill(() => renderCreature(id)));
  } else if (kind === "spell") {
    loadExtendedSpells().then(() => fill(() => renderSpell(id)));
  } else if (kind === "material") {
    Promise.all([loadExtendedMaterials(), loadReactionRoles(), loadStatusEffects()]).then(() =>
      fill(() => renderMaterial(id)),
    );
  }
}

// ─── Renderers (pro-only) ────────────────────────────────────────────────────

type RowLayout = "numeric" | "text" | "prose";
type StatRow = [string, string | number | null | undefined, RowLayout?];

function row(label: string, value: string | number | null | undefined, layout: RowLayout = "text"): HTMLElement | null {
  if (value == null || value === "") return null;
  // Only fields explicitly designated as stats can be numeric. Some health
  // entries contain location-dependent values and explanations instead of a
  // scalar; let those read across the card rather than squeezing them right.
  const numericText = String(value).replace(/(?:frames?|seconds?|milliseconds?|pixels?|ms|px|hp|s)\b/gi, "");
  if (layout === "numeric" && !/^[\d\s.,+\-−–—×x/%°∞<>≤≥=():eE]+$/u.test(numericText)) layout = "prose";
  const r = document.createElement("div");
  r.className = `extended-info-row extended-info-row--${layout}`;
  const l = document.createElement("span");
  l.className = "extended-info-label";
  l.textContent = `${label}:`;
  const v = document.createElement("span");
  v.className = "extended-info-value";
  v.textContent = String(value);
  r.appendChild(l);
  r.appendChild(v);
  return r;
}

function rowWithNode(label: string, valueNode: HTMLElement): HTMLElement {
  const r = document.createElement("div");
  r.className = "extended-info-row extended-info-row--text";
  const l = document.createElement("span");
  l.className = "extended-info-label";
  l.textContent = `${label}:`;
  // The value occupies the grid cell; an actionable child keeps only its
  // visible content as its hit area, rather than stretching across the row.
  const value = document.createElement("span");
  value.className = "extended-info-value";
  value.appendChild(valueNode);
  r.appendChild(l);
  r.appendChild(value);
  return r;
}

/** Append key-value pairs as rows into the parent. Returns count of rows added. */
function appendKVRows(parent: HTMLElement, pairs: StatRow[]): number {
  const present = pairs.filter(([, v]) => v != null && v !== "" && v !== 0);
  for (const [k, v, layout = "numeric"] of present) {
    const r = row(k, String(v), layout);
    if (r) parent.appendChild(r);
  }
  return present.length;
}

const DMG_COLOR_RESIST = "oklch(57.7% 0.245 27.325)"; // < 1.0 → tougher (red)
const DMG_COLOR_VULNERABLE = "oklch(72.3% 0.219 149.579)"; // > 1.0 → weaker (green)

/** Append damage-multiplier rows with color coding (>1.0 green, <1.0 red). */
function appendDmgMultRows(parent: HTMLElement, pairs: [string, string | number | null | undefined][]): number {
  const present = pairs.filter(([, v]) => v != null && v !== "" && v !== 0);
  for (const [k, v] of present) {
    const r = row(k, String(v), "numeric");
    if (!r) continue;
    const numStr = String(v).replace(/^[^\d.-]*/, "");
    const numVal = parseFloat(numStr);
    if (!isNaN(numVal) && numVal !== 1.0) {
      const valSpan = r.querySelector(".extended-info-value") as HTMLElement | null;
      if (valSpan) valSpan.style.color = numVal < 1.0 ? DMG_COLOR_RESIST : DMG_COLOR_VULNERABLE;
    }
    parent.appendChild(r);
  }
  return present.length;
}

/**
 * Normalise a damage-multiplier string to a consistent decimal format.
 * "1x" → "1.0", "0" → "0.0", "0.8" → "0.8", "≤1.0" → "≤1.0"
 */
function formatDmgMult(v: string): string {
  // Preserve prefix like "≤"
  const m = v.match(/^([^\d.-]*)(-?[\d.]+)x?$/);
  if (!m) return v; // e.g. special notes — pass through
  const prefix = m[1];
  const n = parseFloat(m[2]);
  if (isNaN(n)) return v;
  // Show one decimal place for clean numbers, more if needed (e.g. 0.01)
  const formatted = Number.isInteger(n * 10) ? n.toFixed(1) : String(n);
  return `${prefix}${formatted}`;
}

/**
 * Create a group wrapper for a logical section.
 * Groups with >= COLS_THRESHOLD rows get CSS multi-column layout;
 * smaller groups stay single-column.
 */
const COLS_THRESHOLD = 5;

function group(heading: string | null, rowCount: number): HTMLElement {
  const g = document.createElement("div");
  g.className = rowCount >= COLS_THRESHOLD ? "extended-info-group extended-info-group--cols" : "extended-info-group";
  if (heading) g.appendChild(subhead(heading));
  return g;
}

function subhead(text: string): HTMLElement {
  const sh = document.createElement("div");
  sh.className = "extended-info-subhead";
  sh.textContent = text;
  return sh;
}

function renderCreature(id: string): HTMLElement | null {
  const c = getExtendedCreature(id);
  if (!c) return null;

  const root = document.createElement("div");
  root.className = "extended-info-creature";

  // ── Top-level stats ──
  const topRows: HTMLElement[] = [];

  if (c.category || c.faction) {
    const parts: string[] = [];
    if (c.category) parts.push(c.category);
    if (c.faction) parts.push(`(${c.faction})`);
    const r = row(i18next.t("extended.row.faction", "Faction"), parts.join(" "));
    if (r) topRows.push(r);
  }
  if (c.health) {
    const r = row(i18next.t("extended.row.hp", "HP"), stripWiki(c.health), "numeric");
    if (r) topRows.push(r);
  }
  if (c.attackType) {
    const r = row(i18next.t("extended.row.attacks", "Attacks"), parseAttacks(c.attackType), "prose");
    if (r) topRows.push(r);
  }
  if (c.immunities) {
    const r = row(i18next.t("extended.row.immunities", "Immunities"), translateImmunities(c.immunities), "prose");
    if (r) topRows.push(r);
  }

  if (topRows.length > 0) {
    const g = group(null, topRows.length);
    for (const r of topRows) g.appendChild(r);
    root.appendChild(g);
  }

  // ── Damage multipliers ──
  const multsRaw: [string, string | null | undefined][] = [
    [i18next.t("extended.dmg.melee", "Melee"), c.dmgMultMelee],
    [i18next.t("extended.dmg.projectile", "Projectile"), c.dmgMultProjectile],
    [i18next.t("extended.dmg.slice", "Slice"), c.dmgMultSlice],
    [i18next.t("extended.dmg.explosion", "Explosion"), c.dmgMultExplosion],
    [i18next.t("extended.dmg.electricity", "Electricity"), c.dmgMultElectricity],
    [i18next.t("extended.dmg.fire", "Fire"), c.dmgMultFire],
    [i18next.t("extended.dmg.ice", "Ice"), c.dmgMultIce],
    [i18next.t("extended.dmg.drill", "Drill"), c.dmgMultDrill],
    [i18next.t("extended.dmg.radioactive", "Radioactive"), c.dmgMultRadioactive],
    [i18next.t("extended.dmg.holy", "Holy"), c.dmgMultHoly],
  ];
  const mults: [string, string | null | undefined][] = multsRaw.map(([k, v]) => [
    k,
    v != null && v !== "" ? formatDmgMult(v) : v,
  ]);
  const multsPresent = mults.filter(([, v]) => v != null && v !== "");
  if (multsPresent.length > 0) {
    // A row-major grid keeps every label/value together without balancing
    // columns again when lazy content or translated labels change height.
    const g = group(i18next.t("extended.dmgMults", "Damage multipliers"), 0);
    g.classList.add("extended-info-group--stats-grid");
    appendDmgMultRows(g, mults);
    root.appendChild(g);
  }

  // ── Spawn / Materials / Polymorph ──
  const bottomRows: HTMLElement[] = [];

  if (c.spawnLocation) {
    const r = creatureSpawnRow(i18next.t("extended.row.spawn", "Spawn"), c.spawnLocation, id);
    if (r) bottomRows.push(r);
  }
  if (c.ngplusSpawnLocation) {
    const r = creatureSpawnRow(i18next.t("extended.row.spawnNgplus", "Spawn (NG+)"), c.ngplusSpawnLocation, id, 'ng-plus');
    if (r) bottomRows.push(r);
  }

  // Blood / Corpse — individual rows, each with a bartender link
  if (c.blood) {
    const node = creatureMaterialNode(c.blood, c.blood_material_id || CREATURE_DATA[id]?.bloodMaterialId, CREATURE_DATA[id]?.bloodMaterialIds);
    bottomRows.push(rowWithNode(i18next.t("extended.row.blood", "Blood"), node));
  }
  if (c.corpse) {
    const node = creatureMaterialNode(c.corpse, c.corpse_material_id || CREATURE_DATA[id]?.corpseMaterialId, CREATURE_DATA[id]?.corpseMaterialIds);
    bottomRows.push(rowWithNode(i18next.t("extended.row.corpse", "Corpse"), node));
  }

  if (c.chaosPolymorph) {
    const r = row(i18next.t("extended.row.polyChaos", "Polymorph (chaos)"), c.chaosPolymorph);
    if (r) bottomRows.push(r);
  }
  if (c.unstablePolymorph) {
    const r = row(i18next.t("extended.row.polyUnstable", "Polymorph (unstable)"), c.unstablePolymorph);
    if (r) bottomRows.push(r);
  }
  if (c.dmgMultNotes && c.dmgMultNotes !== "1x") {
    const r = row(i18next.t("extended.row.notes", "Notes"), c.dmgMultNotes, "prose");
    if (r) bottomRows.push(r);
  }

  if (bottomRows.length > 0) {
    const g = group(null, bottomRows.length);
    for (const r of bottomRows) g.appendChild(r);
    root.appendChild(g);
  }

  return root.childElementCount > 0 ? root : null;
}

function renderSpell(id: string): HTMLElement | null {
  const s = getExtendedSpell(id);
  if (!s) return null;

  const root = document.createElement("div");
  root.className = "extended-info-spell";

  if (s.description) {
    const desc = document.createElement("div");
    desc.className = "extended-info-desc";
    desc.textContent = s.description;
    root.appendChild(desc);
  }

  // ── Top-level spell stats — many rows, use column layout ──
  const statsRows: StatRow[] = [
    [i18next.t("extended.row.type", "Type"), s.type, "text"],
    [i18next.t("extended.row.mana", "Mana"), s.manaDrain != null ? String(s.manaDrain) : null],
    [i18next.t("extended.row.uses", "Uses"), s.uses ? String(s.uses) : null],
    [i18next.t("extended.row.castDelay", "Cast delay"), s.castDelay],
    [i18next.t("extended.row.recharge", "Recharge"), s.rechargeDelay],
    [i18next.t("extended.row.speed", "Speed"), s.speed != null && s.speed !== "" ? String(s.speed) : null],
    [i18next.t("extended.row.spread", "Spread"), s.spread ? String(s.spread) : null],
    [i18next.t("extended.row.lifetime", "Lifetime"), s.lifetime ? String(s.lifetime) : null],
    [i18next.t("extended.row.recoil", "Recoil"), s.recoil],
    [i18next.t("extended.row.bounces", "Bounces"), s.bounces],
    [i18next.t("extended.row.crit", "Crit"), s.criticalChance],
    [i18next.t("extended.row.price", "Price"), s.price != null ? String(s.price) : null],
    [i18next.t("extended.row.unlock", "Unlock"), s.unlockCondition ?? null, "prose"],
  ];
  const statsPresent = statsRows.filter(([, v]) => v != null && v !== "");
  if (statsPresent.length > 0) {
    const g = group(null, statsPresent.length);
    appendKVRows(g, statsRows);
    root.appendChild(g);
  }

  // ── Damage breakdown ──
  const dmgs: [string, number | null | undefined][] = [
    [i18next.t("extended.dmg.projectile", "Projectile"), s.damageProjectile],
    [i18next.t("extended.dmg.melee", "Melee"), s.damageMelee],
    [i18next.t("extended.dmg.electric", "Electric"), s.damageElectric],
    [i18next.t("extended.dmg.fire", "Fire"), s.damageFire],
    [i18next.t("extended.dmg.explosion", "Explosion"), s.damageExplosion],
    [i18next.t("extended.dmg.ice", "Ice"), s.damageIce],
    [i18next.t("extended.dmg.slice", "Slice"), s.damageSlice],
    [i18next.t("extended.dmg.drill", "Drill"), s.damageDrill],
    [i18next.t("extended.dmg.healing", "Healing"), s.damageHealing],
    [i18next.t("extended.dmg.holy", "Holy"), s.damageHoly],
  ];
  const dmgsPresent = dmgs.filter(([, v]) => v != null && v !== 0);
  if (dmgsPresent.length > 0) {
    const g = group(i18next.t("extended.damage", "Damage"), dmgsPresent.length);
    appendKVRows(g, dmgs);
    root.appendChild(g);
  }

  // ── Tier spawn probability ──
  if (Array.isArray(s.spellTier) && s.spellTier.length > 0) {
    const tierPairs: [string, string][] = s.spellTier.map((t: string, i: number) => {
      const p = s.spawnProbability?.[i];
      return [`T${t}`, p != null ? String(p) : "-"];
    });
    const g = group(i18next.t("extended.tiers", "Tier spawn rate"), tierPairs.length);
    appendKVRows(g, tierPairs);
    root.appendChild(g);
  }

  return root.childElementCount > 0 ? root : null;
}

function renderMaterial(id: string): HTMLElement | null {
  const m = getExtendedMaterial(id);
  if (!m) return null;

  const root = document.createElement("div");
  root.className = "extended-info-material";

  // ── Collect all top-level property rows, then wrap in a group ──
  const propRows: HTMLElement[] = [];
  const pushRow = (el: HTMLElement | null) => {
    if (el) propRows.push(el);
  };

  // Type — colored span using bartender's material-type-* class
  const slug = materialTypeSlug(m);
  const typeSpan = document.createElement("span");
  typeSpan.className = `extended-info-value material-type-${slug}`;
  typeSpan.textContent = materialTypeLabel(slug);
  pushRow(rowWithNode(i18next.t("extended.row.type", "Type"), typeSpan));

  if (m.density != null) pushRow(row(i18next.t("extended.row.density", "Density"), String(m.density), "numeric"));

  // Solid / powder mining stats
  if (slug === "solid" || slug === "powder") {
    if (m.hardness != null) pushRow(row(i18next.t("extended.row.hardness", "Hardness"), String(m.hardness), "numeric"));
    if (m.durability != null && m.durability !== 0)
      pushRow(row(i18next.t("extended.row.durability", "Durability"), String(m.durability), "numeric"));
    if (m.crackability != null && m.crackability !== 0)
      pushRow(row(i18next.t("extended.row.crackability", "Crackability"), String(m.crackability), "numeric"));
  }

  // Liquid-specific
  if (slug === "liquid") {
    if (m.liquid_viscosity != null)
      pushRow(row(i18next.t("extended.row.viscosity", "Viscosity"), String(m.liquid_viscosity), "numeric"));
    if (m.liquid_gravity != null)
      pushRow(row(i18next.t("extended.row.liquidGravity", "Liquid gravity"), String(m.liquid_gravity), "numeric"));
  }

  const yes = i18next.t("extended.yes", "yes");
  if (m.electrical_conductivity)
    pushRow(row(i18next.t("extended.row.conductsElectricity", "Conducts electricity"), yes));
  if (m.slippery) pushRow(row(i18next.t("extended.row.slippery", "Slippery"), yes));
  if (m.burnable) pushRow(row(i18next.t("extended.row.burnable", "Burnable"), yes));
  if (m.on_fire) pushRow(row(i18next.t("extended.row.alwaysBurning", "Always burning"), yes));
  if (m.autoignition_temperature != null && m.autoignition_temperature !== 100) {
    pushRow(row(i18next.t("extended.row.autoignition", "Autoignition"), String(m.autoignition_temperature), "numeric"));
  }
  if (m.cold_freezes_to_material_name)
    pushRow(row(i18next.t("extended.row.freezesTo", "Freezes to"), m.cold_freezes_to_material_name));

  // Danger flags
  const dangers: string[] = [];
  if (m.danger_fire) dangers.push(i18next.t("extended.danger.fire", "fire"));
  if (m.danger_radioactive) dangers.push(i18next.t("extended.danger.radioactive", "radioactive"));
  if (m.danger_poison) dangers.push(i18next.t("extended.danger.poison", "poison"));
  if (m.danger_water) dangers.push(i18next.t("extended.danger.water", "water"));
  if (dangers.length > 0) pushRow(row(i18next.t("extended.row.dangers", "Dangers"), dangers.join(", ")));

  // Wrap collected rows in a group
  if (propRows.length > 0) {
    const g = group(null, propRows.length);
    for (const r of propRows) g.appendChild(r);
    root.appendChild(g);
  }

  // Stain effects (status effects applied when stained)
  if (Array.isArray(m.stain_effects) && m.stain_effects.length > 0) {
    const items: HTMLElement[] = [];
    for (const se of m.stain_effects) {
      const eff = getStatusEffect(se.id);
      if (!eff?.name) continue;
      const r = row(eff.name, eff.description || "", "prose");
      if (r) items.push(r);
    }
    if (items.length) {
      const g = group(i18next.t("extended.stainEffects", "Stain effects"), items.length);
      for (const r of items) g.appendChild(r);
      root.appendChild(g);
    }
  }

  // Ingestion effects (status effects from drinking the material)
  if (Array.isArray(m.ingestion_effects) && m.ingestion_effects.length > 0) {
    const items: HTMLElement[] = [];
    for (const ie of m.ingestion_effects) {
      const eff = getStatusEffect(ie.id);
      if (!eff?.name) continue;
      const r = row(eff.name, eff.description || "", "prose");
      if (r) items.push(r);
    }
    if (items.length) {
      const g = group(i18next.t("extended.ingestionEffects", "Ingestion effects"), items.length);
      for (const r of items) g.appendChild(r);
      root.appendChild(g);
    }
  }

  // Tags — each tag links to its wiki category page.
  if (Array.isArray(m.tags) && m.tags.length > 0) {
    const tagsNode = document.createElement("span");
    tagsNode.className = "extended-info-value";
    m.tags.forEach((tag, i) => {
      const bare = tag.replace(/^\[|\]$/g, "");
      const a = document.createElement("a");
      a.href = `https://noita.wiki.gg/wiki/Category:Materials_tagged_with_${encodeURIComponent(bare)}`;
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = tag;
      a.className = "extended-info-tag-link";
      attachWikiLinkPopover(a);
      tagsNode.appendChild(a);
      if (i < m.tags!.length - 1) {
        tagsNode.appendChild(document.createTextNode(", "));
      }
    });
    const tagGroup = group(null, 1);
    tagGroup.appendChild(rowWithNode(i18next.t("extended.row.tags", "Tags"), tagsNode));
    root.appendChild(tagGroup);
  }

  // Reaction links — link out only.
  const roles = getReactionRoles(id);
  if (roles.asReagent || roles.asResult) {
    const linksWrap = document.createElement("div");
    linksWrap.className = "extended-info-reactions";
    linksWrap.appendChild(subhead(i18next.t("extended.reactionsHeader", "Material reactions on Bartender")));

    if (roles.asReagent) {
      linksWrap.appendChild(externalLink(bartenderReagentLink(id), i18next.t("extended.asReagent", "View as reagent")));
    }
    if (roles.asResult) {
      linksWrap.appendChild(externalLink(bartenderProductLink(id), i18next.t("extended.asProduct", "View as product"), "product"));
    }
    root.appendChild(linksWrap);
  }

  return root.childElementCount > 0 ? root : null;
}

/**
 * External link styled like the in-popup wiki link: text + bi-box-arrow-up-right
 * icon wrapped in a single <a> so the click target is exactly the visible
 * content, not the whole row.
 */
function externalLink(href: string, label: string, role: "reagent" | "product" = "reagent"): HTMLElement {
  const a = document.createElement("a");
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.className = "extended-info-link bartender-link";
  const destination = i18next.t("extended.openInBartender", "Open in Bartender");
  a.title = destination;
  a.setAttribute("aria-label", `${label} · ${destination}`);
  const text = document.createElement("span");
  text.textContent = label;
  a.appendChild(text);
  const icon = document.createElement("i");
  icon.className = "bi bi-box-arrow-up-right";
  icon.setAttribute("aria-hidden", "true");
  a.appendChild(icon);

  const title = document.createElement("span");
  title.className = "bartender-link-title";
  const logo = document.createElement("img");
  logo.className = "bartender-link-logo";
  logo.src = "./assets/Bartender_logo.svg";
  logo.alt = "Bartender";
  const brand = /Bartender/i.exec(destination);
  if (brand) {
    title.append(document.createTextNode(destination.slice(0, brand.index)), logo,
      document.createTextNode(destination.slice(brand.index + brand[0].length)));
  } else {
    title.append(document.createTextNode(destination), logo);
  }
  const hint = role === "product"
    ? i18next.t("extended.bartenderProductHint", "View reactions that produce this material in Bartender.")
    : i18next.t("extended.bartenderReagentHint", "View reactions that use this material in Bartender.");
  attachHoverPopover(a, hint, "top", { title, owner: "bartender-link", focus: true });
  return a;
}

/**
 * Render a material value node (link or plain text) for the creature card.
 * Used for Blood / Corpse rows. When we have the bartender material id we
 * link to bartender's reactions page; otherwise plain text.
 */
function creatureMaterialNode(rawName: string, materialId: string | null | undefined, materialIds?: string[]): HTMLElement {
  const displayName = stripWiki(rawName);
  const linkIds = materialIds?.length ? materialIds : materialId && materialId !== 'none' ? [materialId] : [];
  if (linkIds.length) {
    const references = [...rawName.matchAll(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g)];
    if (references.length === linkIds.length) {
      const value = document.createElement('span');
      const separator = (text: string) => `${/^\s/.test(text) ? ' ' : ''}${stripWiki(text)}${/\s$/.test(text) ? ' ' : ''}`;
      let from = 0;
      references.forEach((reference, index) => {
        value.append(document.createTextNode(separator(rawName.slice(from, reference.index))));
        value.append(creatureMaterialNode(stripWiki(reference[0]), linkIds[index]));
        from = reference.index! + reference[0].length;
      });
      value.append(document.createTextNode(separator(rawName.slice(from))));
      return value;
    }
  }
  if (materialId && materialId !== 'none') {
    const translated = gameTranslator.translateMaterial(materialId);
    const normalizedId = materialId.replace(/^mat_/, "");
    return externalLink(bartenderReagentLink(materialId), translated === normalizedId ? displayName : translated);
  }
  const t = document.createElement("span");
  t.className = "extended-info-value";
  t.textContent = displayName;
  return t;
}

// ─── Wiki text utilities ─────────────────────────────────────────────────────

/** Strip [[wiki|links]] / [[File:...]] / HTML entities from a wiki-formatted string. */
function stripWiki(s: string | null | undefined): string {
  if (!s) return "";
  let t = String(s)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'");
  // Wiki Cargo can include unresolved citation markers in creature fields.
  t = t.replace(/\x7f?['"`]*UNIQ--ref-[\da-f]+-QINU['"`]*\x7f?/gi, '');
  t = t.replace(/<[^>]+>/g, " ");
  t = t.replace(/\[\[File:[^\]]*\]\]/g, "");
  t = t.replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, "$2");
  t = t.replace(/\s+/g, " ").trim();
  return t;
}

function parseAttacks(s: string | null | undefined): string {
  const cleaned = stripWiki(s);
  if (!cleaned) return "";
  const parts = cleaned.split(",").map((p) => p.trim());
  return parts
    .map((part) => {
      const segs = part.split("/").map((x) => x.trim());
      if (segs.length >= 3) {
        const name = segs[0];
        const type = segs[1];
        const dmg = segs[2];
        const extra = segs[3] ? ` (${segs[3]})` : "";
        if (name === type) return `${name}: ${dmg}${extra}`;
        return `${name} (${type}): ${dmg}${extra}`;
      }
      return part;
    })
    .filter(Boolean)
    .join(", ");
}
