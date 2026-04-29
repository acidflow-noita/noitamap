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
    case "liquid": return "Liquid";
    case "solid": return "Solid";
    case "gas": return "Gas";
    case "fire": return "Fire";
    case "powder": return "Powder";
    default: return slug.charAt(0).toUpperCase() + slug.slice(1);
  }
}

/**
 * Walk up from `el` to find an enclosing popup (static OSD overlay popup or
 * telescope marker tooltip) and dismiss it. Used by the CTA click handler so
 * the auth modal isn't visually buried under the popup.
 */
function dismissEnclosingPopup(el: HTMLElement): void {
  const tooltip = el.closest(".marker-tooltip") as HTMLElement | null;
  if (tooltip) {
    tooltip.remove();
    return;
  }
  const popup = el.closest(".osOverlayPopup") as HTMLElement | null;
  if (popup) {
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

  const render = () => {
    body.innerHTML = "";
    if (!isProUser()) {
      wrap.style.display = "";
      header.textContent = i18next.t("extended.title", "Extended info");
      body.appendChild(renderProPlaceholder(kind));
      return;
    }
    renderProBody(wrap, header, body, kind, id);
  };

  render();

  const unsub = authService.subscribe(() => {
    if (!wrap.isConnected) {
      unsub();
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

  const render = () => {
    body.innerHTML = "";
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
      let id: string | null = null;
      for (const n of tryNames) {
        if (!n) continue;
        id = getCreatureIdByName(n);
        if (id) break;
      }
      body.innerHTML = "";
      const node = id ? renderCreature(id) : null;
      if (node) {
        body.appendChild(node);
      } else {
        wrap.style.display = "none";
      }
    });
  };

  render();
  const unsub = authService.subscribe(() => {
    if (!wrap.isConnected) {
      unsub();
      return;
    }
    render();
  });
  return wrap;
}

const PREVIEW_FIELDS: Record<ExtendedKind, string[]> = {
  creature: [
    "Faction", "HP", "Attacks", "Immunities", "Spawn", "Blood",
    "Damage multipliers",
  ],
  spell: [
    "Type", "Mana", "Cast delay", "Recharge time", "Speed",
    "Damage", "Spread",
  ],
  material: [
    "Type", "Density", "Hardness", "Viscosity", "Burnable",
    "Dangers", "Tags", "Reactions",
  ],
};

/** Realistic skeleton widths per field label so the placeholder looks plausible. */
const SKELETON_WIDTHS: Record<string, string> = {
  // creature
  Faction: "5em", HP: "2.5em", Attacks: "7em", Immunities: "6em",
  Spawn: "4em", Blood: "4.5em", "Damage multipliers": "8em",
  // spell
  Type: "4em", Mana: "2em", "Cast delay": "3em", "Recharge time": "3em",
  Speed: "2.5em", Damage: "3em", Spread: "2em",
  // material
  Density: "3em", Hardness: "2.5em", Viscosity: "3em", Burnable: "2em",
  Dangers: "5em", Tags: "6em", Reactions: "5em",
};

function renderProPlaceholder(kind: ExtendedKind): HTMLElement {
  const placeholder = document.createElement("div");
  placeholder.className = "extended-info-placeholder pro-accent";

  const fields = document.createElement("div");
  fields.className = "extended-info-placeholder-fields";
  for (const label of PREVIEW_FIELDS[kind]) {
    const l = document.createElement("span");
    l.className = "extended-info-label";
    l.textContent = `${label}:`;
    const skel = document.createElement("span");
    skel.className = "extended-info-skeleton";
    if (SKELETON_WIDTHS[label]) skel.style.width = SKELETON_WIDTHS[label];
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
  header: HTMLElement,
  body: HTMLElement,
  kind: ExtendedKind,
  id: string,
): void {
  const loading = document.createElement("div");
  loading.className = "extended-info-loading";
  loading.textContent = i18next.t("extended.loading", "Loading...");
  body.appendChild(loading);

  const fill = (cb: () => HTMLElement | null) => {
    const node = cb();
    body.innerHTML = "";
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

function row(label: string, value: string | number | null | undefined): HTMLElement | null {
  if (value == null || value === "") return null;
  const r = document.createElement("div");
  r.className = "extended-info-row";
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
  r.className = "extended-info-row";
  const l = document.createElement("span");
  l.className = "extended-info-label";
  l.textContent = `${label}:`;
  r.appendChild(l);
  r.appendChild(valueNode);
  return r;
}

function dmgMultsTable(mults: [string, string | null | undefined][]): HTMLElement | null {
  const present = mults.filter(([, v]) => v != null && v !== "");
  if (present.length === 0) return null;
  const tbl = document.createElement("table");
  tbl.className = "extended-info-table";
  for (const [k, v] of present) {
    const tr = document.createElement("tr");
    const td1 = document.createElement("td");
    td1.textContent = k;
    const td2 = document.createElement("td");
    td2.textContent = String(v);
    tr.appendChild(td1);
    tr.appendChild(td2);
    tbl.appendChild(tr);
  }
  return tbl;
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

  const append = (el: HTMLElement | null) => {
    if (el) root.appendChild(el);
  };

  // Faction (and category if present, in parens — preserves original layout
  // where the displayed text was e.g. "Ghosts (ghost)").
  if (c.category || c.faction) {
    const parts: string[] = [];
    if (c.category) parts.push(c.category);
    if (c.faction) parts.push(`(${c.faction})`);
    append(row("Faction", parts.join(" ")));
  }

  // HP
  if (c.health) {
    const hp = stripWiki(c.health);
    append(row("HP", hp));
  }

  // Attacks
  if (c.attackType) append(row("Attacks", parseAttacks(c.attackType)));

  // Immunities
  if (c.immunities) append(row("Immunities", stripWiki(c.immunities)));

  // Damage multipliers
  const mults: [string, string | null | undefined][] = [
    ["Melee", c.dmgMultMelee],
    ["Projectile", c.dmgMultProjectile],
    ["Slice", c.dmgMultSlice],
    ["Explosion", c.dmgMultExplosion],
    ["Electricity", c.dmgMultElectricity],
    ["Fire", c.dmgMultFire],
    ["Ice", c.dmgMultIce],
    ["Drill", c.dmgMultDrill],
    ["Radioactive", c.dmgMultRadioactive],
    ["Holy", c.dmgMultHoly],
  ];
  const dmgTbl = dmgMultsTable(mults);
  if (dmgTbl) {
    root.appendChild(subhead(i18next.t("extended.dmgMults", "Damage multipliers")));
    root.appendChild(dmgTbl);
  }

  // Spawn
  if (c.spawnLocation) append(row("Spawn", stripWiki(c.spawnLocation)));
  if (c.ngplusSpawnLocation) append(row("Spawn (NG+)", stripWiki(c.ngplusSpawnLocation)));

  // Blood / Corpse — link to bartender when we have the material id
  // (FULL_CREATURES_FINAL.json carries blood_material_id / corpse_material_id).
  if (c.blood || c.corpse) {
    const wrap = document.createElement("div");
    wrap.className = "extended-info-row";
    const lab = document.createElement("span");
    lab.className = "extended-info-label";
    lab.textContent = "Materials:";
    wrap.appendChild(lab);
    const valWrap = document.createElement("span");
    valWrap.className = "extended-info-value extended-info-mat-list";
    if (c.blood) {
      const node = creatureMaterialNode("Blood", stripWiki(c.blood), c.blood_material_id);
      valWrap.appendChild(node);
    }
    if (c.corpse) {
      const node = creatureMaterialNode("Corpse", stripWiki(c.corpse), c.corpse_material_id);
      valWrap.appendChild(node);
    }
    wrap.appendChild(valWrap);
    root.appendChild(wrap);
  }

  // Polymorph & notes
  if (c.chaosPolymorph) append(row("Polymorph (chaos)", c.chaosPolymorph));
  if (c.unstablePolymorph) append(row("Polymorph (unstable)", c.unstablePolymorph));
  if (c.dmgMultNotes && c.dmgMultNotes !== "1x") append(row("Notes", c.dmgMultNotes));

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

  const append = (el: HTMLElement | null) => {
    if (el) root.appendChild(el);
  };

  append(row("Type", s.type));
  append(row("Mana", s.manaDrain != null ? String(s.manaDrain) : null));
  append(row("Uses", s.uses ? String(s.uses) : null));
  append(row("Cast delay", s.castDelay));
  append(row("Recharge", s.rechargeDelay));
  append(row("Speed", s.speed != null && s.speed !== "" ? String(s.speed) : null));
  append(row("Spread", s.spread ? String(s.spread) : null));
  append(row("Lifetime", s.lifetime ? String(s.lifetime) : null));
  append(row("Recoil", s.recoil));
  append(row("Bounces", s.bounces));
  append(row("Crit", s.criticalChance));
  append(row("Price", s.price != null ? String(s.price) : null));
  if (s.unlockCondition) append(row("Unlock", s.unlockCondition));

  // Damage breakdown
  const dmgs: [string, number | null | undefined][] = [
    ["Projectile", s.damageProjectile],
    ["Melee", s.damageMelee],
    ["Electric", s.damageElectric],
    ["Fire", s.damageFire],
    ["Explosion", s.damageExplosion],
    ["Ice", s.damageIce],
    ["Slice", s.damageSlice],
    ["Drill", s.damageDrill],
    ["Healing", s.damageHealing],
    ["Holy", s.damageHoly],
  ];
  const present = dmgs.filter(([, v]) => v != null && v !== 0);
  if (present.length > 0) {
    root.appendChild(subhead(i18next.t("extended.damage", "Damage")));
    const tbl = document.createElement("table");
    tbl.className = "extended-info-table";
    for (const [k, v] of present) {
      const tr = document.createElement("tr");
      const td1 = document.createElement("td");
      td1.textContent = k;
      const td2 = document.createElement("td");
      td2.textContent = String(v);
      tr.appendChild(td1);
      tr.appendChild(td2);
      tbl.appendChild(tr);
    }
    root.appendChild(tbl);
  }

  // Tier spawn probability
  if (Array.isArray(s.spellTier) && s.spellTier.length > 0) {
    root.appendChild(subhead(i18next.t("extended.tiers", "Tier spawn rate")));
    const tbl = document.createElement("table");
    tbl.className = "extended-info-table";
    for (let i = 0; i < s.spellTier.length; i++) {
      const tr = document.createElement("tr");
      const td1 = document.createElement("td");
      td1.textContent = `T${s.spellTier[i]}`;
      const td2 = document.createElement("td");
      const p = s.spawnProbability?.[i];
      td2.textContent = p != null ? String(p) : "-";
      tr.appendChild(td1);
      tr.appendChild(td2);
      tbl.appendChild(tr);
    }
    root.appendChild(tbl);
  }

  return root.childElementCount > 0 ? root : null;
}

function renderMaterial(id: string): HTMLElement | null {
  const m = getExtendedMaterial(id);
  if (!m) return null;

  const root = document.createElement("div");
  root.className = "extended-info-material";

  const append = (el: HTMLElement | null) => {
    if (el) root.appendChild(el);
  };

  // Type — colored span using bartender's material-type-* class
  const slug = materialTypeSlug(m);
  const typeSpan = document.createElement("span");
  typeSpan.className = `extended-info-value material-type-${slug}`;
  typeSpan.textContent = materialTypeLabel(slug);
  append(rowWithNode("Type", typeSpan));

  // Density is meaningful for liquid/solid/powder/gas (relative to others).
  if (m.density != null) append(row("Density", String(m.density)));

  // Solid / powder mining stats
  if (slug === "solid" || slug === "powder") {
    if (m.hardness != null) append(row("Hardness", String(m.hardness)));
    if (m.durability != null && m.durability !== 0) append(row("Durability", String(m.durability)));
    if (m.crackability != null && m.crackability !== 0) append(row("Crackability", String(m.crackability)));
  }

  // Liquid-specific
  if (slug === "liquid") {
    if (m.liquid_viscosity != null) append(row("Viscosity", String(m.liquid_viscosity)));
    if (m.liquid_gravity != null) append(row("Liquid gravity", String(m.liquid_gravity)));
  }

  if (m.electrical_conductivity) append(row("Conducts electricity", "yes"));
  if (m.slippery) append(row("Slippery", "yes"));
  if (m.burnable) append(row("Burnable", "yes"));
  if (m.on_fire) append(row("Always burning", "yes"));
  if (m.autoignition_temperature != null && m.autoignition_temperature !== 100) {
    append(row("Autoignition", String(m.autoignition_temperature)));
  }
  if (m.cold_freezes_to_material_name) append(row("Freezes to", m.cold_freezes_to_material_name));

  // Danger flags
  const dangers: string[] = [];
  if (m.danger_fire) dangers.push("fire");
  if (m.danger_radioactive) dangers.push("radioactive");
  if (m.danger_poison) dangers.push("poison");
  if (m.danger_water) dangers.push("water");
  if (dangers.length > 0) append(row("Dangers", dangers.join(", ")));

  // Stain effects (status effects applied when stained)
  if (Array.isArray(m.stain_effects) && m.stain_effects.length > 0) {
    const items: HTMLElement[] = [];
    for (const se of m.stain_effects) {
      const eff = getStatusEffect(se.id);
      if (!eff?.name) continue;
      const r = row(eff.name, eff.description || "");
      if (r) items.push(r);
    }
    if (items.length) {
      root.appendChild(subhead(i18next.t("extended.stainEffects", "Stain effects")));
      for (const r of items) root.appendChild(r);
    }
  }

  // Ingestion effects (status effects from drinking the material)
  if (Array.isArray(m.ingestion_effects) && m.ingestion_effects.length > 0) {
    const items: HTMLElement[] = [];
    for (const ie of m.ingestion_effects) {
      const eff = getStatusEffect(ie.id);
      if (!eff?.name) continue;
      const r = row(eff.name, eff.description || "");
      if (r) items.push(r);
    }
    if (items.length) {
      root.appendChild(subhead(i18next.t("extended.ingestionEffects", "Ingestion effects")));
      for (const r of items) root.appendChild(r);
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
      tagsNode.appendChild(a);
      if (i < m.tags!.length - 1) {
        tagsNode.appendChild(document.createTextNode(", "));
      }
    });
    append(rowWithNode("Tags", tagsNode));
  }

  // Reaction links — link out only.
  const roles = getReactionRoles(id);
  if (roles.asReagent || roles.asResult) {
    const linksWrap = document.createElement("div");
    linksWrap.className = "extended-info-reactions";
    linksWrap.appendChild(
      subhead(i18next.t("extended.reactionsHeader", "Material reactions on Bartender")),
    );

    if (roles.asReagent) {
      linksWrap.appendChild(
        externalLink(
          bartenderReagentLink(id),
          i18next.t("extended.asReagent", "View as reagent"),
        ),
      );
    }
    if (roles.asResult) {
      linksWrap.appendChild(
        externalLink(
          bartenderProductLink(id),
          i18next.t("extended.asProduct", "View as product"),
        ),
      );
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
function externalLink(href: string, label: string): HTMLElement {
  const a = document.createElement("a");
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener";
  a.className = "extended-info-link";
  const text = document.createElement("span");
  text.textContent = label;
  a.appendChild(text);
  const icon = document.createElement("i");
  icon.className = "bi bi-box-arrow-up-right";
  a.appendChild(icon);
  return a;
}

/**
 * Render a "Blood: <link>" or "Corpse: <link>" fragment for the creature
 * material row. When we have the bartender material id, wrap it in a link
 * to bartender's reactions page (as reagent — the most useful default since
 * blood/corpse are inputs to alchemy). Without the id we fall back to plain
 * text using the wiki name.
 */
function creatureMaterialNode(
  kind: string,
  displayName: string,
  materialId: string | null | undefined,
): HTMLElement {
  const wrap = document.createElement("span");
  wrap.className = "extended-info-mat-entry";
  const k = document.createElement("span");
  k.className = "extended-info-mat-kind";
  k.textContent = `${kind}: `;
  wrap.appendChild(k);
  if (materialId) {
    wrap.appendChild(externalLink(bartenderReagentLink(materialId), displayName));
  } else {
    const t = document.createElement("span");
    t.textContent = displayName;
    wrap.appendChild(t);
  }
  return wrap;
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
