import { searchOverlays } from "../flexsearch";
import { resetBiomeOverlays } from "../data_sources/overlays";
import { MapName } from "../data_sources/tile_data";
import { debounce } from "../util";
import { UnifiedSearchResults, UnifiedSearchResult } from "./unifiedsearchresults";
import { TargetOfInterest, Spell } from "../data_sources/overlays";
import { gameTranslator } from "../game-translations/translator";
import i18next from "../i18n";
import spells from "../data/spells.json";
import { EventEmitter2 } from "eventemitter2";
import type { DynamicPOI } from "../dynamic-map";
import { CREATURE_ALIASES, CREATURE_DATA } from "../data/creature-data";
import { SPECIAL_WAND_ALIAS } from "../data/special-wands";
import { authService } from "../auth/auth-service";
import { AuthUI } from "../auth/auth-ui";
import { updateURLWithSearch } from "../data_sources/url";
import { perkNameKey } from "../telescope/perk-i18n";
import { canonicalEntityId } from "../telescope/entity-canonical";
import { isAchievementPillarSegment, pillarSegmentTitle, pillarReqSpec, resolvePillarLinkLabel, resolvePillarItemName, ITEM_SEARCH_NAME_KEYS, ITEM_LOCALE_NAME_KEYS, PILLAR_PLACES } from "../data/pillars";
import orbsData from "../data/orbs.json";

/**
 * The 11 Orbs of True Knowledge as synthetic search POIs. On NG the generator
 * emits no orb POIs (biomeData.orbs is empty) — the map draws them from
 * data/orbs.json as a dedicated overlay — so without this they are invisible
 * to search and the Orbs filter. They are search-index-only: cards open via
 * openTooltipForPOI's fallbackPoi path, markers stay untouched (the overlay
 * already renders the icons). orbIndex is parsed from the icon filename
 * (orb_<idx>.png), same as the overlay's collected detection.
 */
let trueOrbPOIs: DynamicPOI[] | null = null;
function getTrueOrbPOIs(): DynamicPOI[] {
  if (!trueOrbPOIs) {
    trueOrbPOIs = (orbsData as any[])
      .filter((o) => Array.isArray(o.maps) && o.maps.includes("dynamic-main-branch"))
      .map((o) => {
        const m = String(o.icon || "").match(/orb_(\d+)\.png$/);
        const orbIndex = m ? parseInt(m[1], 10) : undefined;
        return {
          id: `d-true-orb-${orbIndex ?? `${o.x}_${o.y}`}`,
          type: "item",
          item: "orb",
          orbIndex,
          name: o.name,
          x: o.x,
          y: o.y,
          worldX: o.x,
          worldY: o.y,
          pw: 0,
          biome: "orb_room",
        };
      });
  }
  return trueOrbPOIs;
}

/**
 * Fixed pillar places (Mountain Altar, The Tower, Moon, ...) as synthetic
 * search POIs. They have no generated POI — on the map they exist only as
 * click-only pillar_place markers (poi-spatial-index) — and injecting them
 * here keeps the place names searchable. Ids match those markers so
 * openTooltipForPOI anchors the card to the map spot. Rebuilt per language so
 * the label follows a labelKey. See PILLAR_PLACES in data/pillars.
 */
function getPillarPlacePOIs(): DynamicPOI[] {
  return PILLAR_PLACES.map((p) => {
    const name = resolvePillarLinkLabel(
      p,
      (k) => gameTranslator.translateItem(k),
      (k) => gameTranslator.translateMaterial(k),
      (k, dv) => String(i18next.t(k, dv)),
    );
    return {
      id: `d-pillar-place-${p.key.replace(",", "_")}`,
      type: "pillar_place",
      name,
      wiki: p.wiki,
      x: p.x,
      y: p.y,
      worldX: p.x,
      worldY: p.y,
      pw: 0,
    };
  });
}

// Inlined from poi-spatial-index to avoid pulling Flatbush into the main bundle
const CONTAINER_TYPES = new Set([
  "holy_mountain_shop",
  "shop",
  "eye_room",
  "pacifist_chest",
  "triangle_boss",
  "alchemist_boss",
  "pyramid_boss",
  "dragon",
  "wand_altar",
  "snowy_room",
  "robot_egg",
  "chest",
  "great_chest",
  "laboratory",
  "boss_spirit",
  "islandspirit",
  "boss_wizard",
  "boss_ghost",
  "boss_sky",
  "boss_centipede",
  "boss_robot",
  "boss_meat",
  "boss_fish",
  "friend",
  "starting_loadout",
]);

const CHEST_TYPES = new Set(["chest", "great_chest", "pacifist_chest"]);
const HOLY_MOUNTAIN_TYPES = new Set(["holy_mountain_shop"]);

/**
 * Append AP/LC recipe-finder buttons to the dynamic filter bar.
 * Buttons gate on auth: non-pro users see a Pro-locked popover and get the
 * Get Pro modal on click. Pro users trigger the handler exposed by the
 * pro bundle (window.__noitamap.handleAlchemyRecipe), loading the bundle
 * on demand.
 */
/**
 * Show an immediate placeholder in the search-results overlay so the user
 * knows their AP/LC click registered, even while the pro bundle is still
 * loading on first use. Cleared by showRecipe (or clearRecipe) once the
 * pro bundle takes over rendering.
 */
function showAlchemyLoading(kind: "ap" | "lc" | null): void {
  const overlay = document.getElementById("unifiedSearchResultsOverlay") as HTMLDivElement | null;
  const ul = document.getElementById("unifiedSearchResults") as HTMLUListElement | null;
  if (!overlay || !ul) return;
  if (kind === null) {
    ul.replaceChildren();
    overlay.style.display = "none";
    return;
  }
  ul.replaceChildren();
  const li = document.createElement("li");
  li.className = "alchemy-loading";
  li.textContent = `${kind.toUpperCase()}: ${i18next.t("search.indexing", "Loading...")}`;
  ul.appendChild(li);
  overlay.style.display = "block";
  const input = document.getElementById("unified-search-input");
  if (input) {
    const rect = input.getBoundingClientRect();
    overlay.style.left = `${rect.left + window.scrollX}px`;
    overlay.style.top = `${rect.bottom + window.scrollY}px`;
    overlay.style.width = "";
    overlay.style.maxWidth = `${Math.max(0, window.innerWidth - rect.left - 8)}px`;
  }
}

function appendAlchemyStubs(filterBox: HTMLElement): void {
  const icons: Record<"ap" | "lc", string> = {
    ap: "assets/icons/overlay-toggles/icon-alchemy-ap.webp",
    lc: "assets/icons/overlay-toggles/icon-alchemy-lc.webp",
  };
  for (const kind of ["ap", "lc"] as const) {
    const label = document.createElement("label");
    label.className = "alchemy-filter-btn pro-accent";
    label.tabIndex = 0;
    label.dataset.alchemy = kind;

    const titleKey = `alchemy.${kind}.title`;
    const contentKey = `alchemy.${kind}.content`;
    const proOnlyKey = `alchemy.${kind}.proOnly`;
    const defaultTitle = kind === "ap" ? "Alchemic Precursor" : "Lively Concoction";
    label.dataset.bsToggle = "popover";
    label.dataset.bsPlacement = "bottom";
    label.dataset.bsTrigger = "hover focus";
    label.dataset.bsHtml = "true";
    label.dataset.bsTitle = i18next.t(titleKey, defaultTitle);
    label.dataset.i18nTitle = titleKey;
    label.dataset.i18nContent = contentKey;
    label.dataset.i18nProOnly = proOnlyKey;

    const img = document.createElement("img");
    img.src = icons[kind];
    img.alt = kind.toUpperCase();
    img.classList.add("pixelated-image", "alchemy-filter-icon");
    img.draggable = false;
    label.appendChild(img);

    const badge = document.createElement("span");
    badge.className = "alchemy-filter-badge";
    badge.textContent = i18next.t(`alchemy.${kind}.label`, kind.toUpperCase());
    label.appendChild(badge);

    const refreshDisabledState = () => {
      const state = authService.getState();
      const locked = !state.authenticated || !state.isSubscriber;
      label.classList.toggle("alchemy-filter-btn--locked", locked);
      label.setAttribute("aria-disabled", locked ? "true" : "false");
      // Losing Pro (logout / sub lapse) while a recipe is open must turn it
      // OFF — otherwise the AP/LC results stay on screen until refresh.
      if (locked && label.classList.contains("active")) {
        label.classList.remove("active");
        (window as any).__noitamap?.handleAlchemyRecipe?.(null);
      }
      label.dataset.bsContent = i18next.t(
        locked ? proOnlyKey : contentKey,
        locked
          ? `${defaultTitle} recipe finder. Pro feature — sign in to unlock.`
          : `Find the nearest ingredients for the ${defaultTitle} recipe.`,
      );
      const existing = (window as any).bootstrap?.Popover?.getInstance(label);
      if (existing) {
        existing.setContent({
          ".popover-header": label.dataset.bsTitle!,
          ".popover-body": label.dataset.bsContent,
        });
      }
    };
    refreshDisabledState();

    label.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const state = authService.getState();
      if (!state.authenticated || !state.isSubscriber) {
        AuthUI.showGetProModal();
        return;
      }
      // Dismiss hover/focus popover so it doesn't linger on top of results.
      const pop = (window as any).bootstrap?.Popover?.getInstance(label);
      if (pop) pop.hide();
      // Keep focus on the search input so the overlay's :focus-within check
      // doesn't let hideOverlay() close the results.
      const searchInput = document.getElementById("unified-search-input") as HTMLInputElement | null;
      searchInput?.focus({ preventScroll: true });

      // Decide toggle direction BEFORE touching state so the first async
      // tick doesn't race with the optimistic active-class flip.
      const alreadyActive = label.classList.contains("active");
      const nextKind: typeof kind | null = alreadyActive ? null : kind;

      // Immediate visual feedback so the user knows the click registered even
      // while the pro bundle is still loading on the first call.
      for (const b of document.querySelectorAll<HTMLLabelElement>(".alchemy-filter-btn")) {
        b.classList.toggle("active", b.dataset.alchemy === nextKind);
      }

      // AP/LC are exclusive with the category filters — clear any active ones
      // when entering alchemy mode so results aren't mixed/confusing.
      if (nextKind !== null) {
        for (const cb of document.querySelectorAll<HTMLInputElement>(
          '#unifiedSearchFilterBox input[type="checkbox"][data-filter]',
        )) {
          if (cb.checked) {
            cb.checked = false;
            cb.dispatchEvent(new Event("change"));
          }
        }
      }

      showAlchemyLoading(nextKind);

      const hooks = (window as any).__noitamap;
      if (!hooks) return;
      if (typeof hooks.handleAlchemyRecipe !== "function") {
        if (typeof hooks.requestProLoad === "function") {
          await hooks.requestProLoad();
        }
      }
      if (typeof hooks.handleAlchemyRecipe === "function") {
        hooks.handleAlchemyRecipe(nextKind);
      }
    });

    // Refresh gating when auth state flips (login/logout).
    authService.subscribe(refreshDisabledState);

    filterBox.appendChild(label);
  }
}

/**
 * Show an immediate "Loading..." row in the results overlay so the gem click
 * has visible feedback while the pro bundle / POI index catches up. Mirrors
 * the `showAlchemyLoading` behaviour for AP/LC.
 */
function showHighValueLoading(): void {
  const overlay = document.getElementById("unifiedSearchResultsOverlay") as HTMLDivElement | null;
  const ul = document.getElementById("unifiedSearchResults") as HTMLUListElement | null;
  if (!overlay || !ul) return;
  ul.replaceChildren();
  const li = document.createElement("li");
  li.className = "alchemy-loading";
  li.textContent = `${i18next.t("highValueFilter.title", "High-value items")}: ${i18next.t("search.indexing", "Loading...")}`;
  ul.appendChild(li);
  overlay.style.display = "block";
  // Pin overlay width to the filter row so it doesn't shrink when the
  // "Loading..." content is shorter than the usual result rows.
  const filterBox = document.getElementById("unifiedSearchFilterBox");
  const input = document.getElementById("unified-search-input");
  if (filterBox && input) {
    const inputRect = input.getBoundingClientRect();
    const filterRect = filterBox.getBoundingClientRect();
    const pinWidth = Math.max(inputRect.width, filterRect.right - inputRect.left);
    overlay.style.left = `${inputRect.left + window.scrollX}px`;
    overlay.style.top = `${inputRect.bottom + window.scrollY}px`;
    overlay.style.minWidth = `${pinWidth}px`;
    overlay.style.maxWidth = `${Math.max(0, window.innerWidth - inputRect.left - 8)}px`;
  }
}

/**
 * Live reference to the active UnifiedSearch instance, set by its constructor.
 * Used by appendHighValueStub so the gem button can drive search-result
 * filtering even when the stub is first created by the static factory
 * (before the instance exists).
 */
let _activeSearch: UnifiedSearch | null = null;

/**
 * Append the "high-value items" gem toggle to the dynamic filter bar.
 * Pro-gated like AP/LC. Flips the map-marker highlight predicate via the
 * hook registered by the pro bundle (handleHighValueToggle), and also
 * narrows the search results list to only high-value items while active.
 */
function appendHighValueStub(filterBox: HTMLElement, search?: UnifiedSearch): void {
  const label = document.createElement("label");
  label.className = "high-value-filter-btn pro-accent";
  label.tabIndex = 0;
  label.id = "highValueFilterBtn";

  const titleKey = "highValueFilter.title";
  const contentKey = "highValueFilter.content";
  const proOnlyKey = "highValueFilter.proOnly";
  const defaultTitle = "High-value items";

  label.dataset.bsToggle = "popover";
  label.dataset.bsPlacement = "bottom";
  label.dataset.bsTrigger = "hover focus";
  label.dataset.bsHtml = "true";
  label.dataset.bsTitle = i18next.t(titleKey, defaultTitle);
  label.dataset.i18nTitle = titleKey;
  label.dataset.i18nContent = contentKey;
  label.dataset.i18nProOnly = proOnlyKey;

  // Inline Bootstrap Icons "gem" — no new asset needed.
  label.innerHTML = `
    <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" fill="currentColor" viewBox="0 0 16 16" class="high-value-filter-icon" aria-hidden="true">
      <path d="M3.1.7a.5.5 0 0 1 .4-.2h9a.5.5 0 0 1 .4.2l2.976 3.974c.149.185.156.45.01.644L8.4 15.3a.5.5 0 0 1-.8 0L.1 5.3a.5.5 0 0 1 0-.6zm11.386 3.785-1.806-2.41-.776 2.413zm-3.633.004.961-2.989H4.186l.963 2.995zM5.47 5.495 8 13.366l2.532-7.876zm-1.371-.999-.78-2.422-1.818 2.425zM1.499 5.5l5.113 6.817-2.192-6.82zm7.889 6.817 5.123-6.83-2.928.002z"/>
    </svg>
  `;

  const refreshDisabledState = () => {
    const state = authService.getState();
    const locked = !state.authenticated || !state.isSubscriber;
    label.classList.toggle("high-value-filter-btn--locked", locked);
    label.setAttribute("aria-disabled", locked ? "true" : "false");
    // Losing Pro (logout / sub lapse) while the highlight is on must turn it
    // OFF — otherwise the map markers stay highlighted until refresh.
    if (locked && label.classList.contains("active")) {
      applyActiveClass(false);
      (window as any).__noitamap?.handleHighValueToggle?.(false);
      applyToSearch(false);
    }
    label.dataset.bsContent = i18next.t(
      locked ? proOnlyKey : contentKey,
      locked
        ? `${defaultTitle}. Pro feature — sign in to unlock.`
        : "Highlight rare spells, orbs, and landmark items. Matching markers are scaled up and glow; others are dimmed.",
    );
    const existing = (window as any).bootstrap?.Popover?.getInstance(label);
    if (existing) {
      existing.setContent({
        ".popover-header": label.dataset.bsTitle!,
        ".popover-body": label.dataset.bsContent,
      });
    }
  };
  refreshDisabledState();
  authService.subscribe(refreshDisabledState);

  const applyActiveClass = (on: boolean) => {
    label.classList.toggle("active", on);
  };

  const applyToSearch = (on: boolean) => {
    const s = search ?? _activeSearch;
    if (!s) return;
    if (on) s.activeFilters.add("hv");
    else s.activeFilters.delete("hv");
    // Re-render the search results list so it reflects the new filter set.
    s.updateSearchResults();
  };

  const toggleFilter = async (nextActive: boolean) => {
    const hooks = window.__noitamap;
    if (!hooks) return;
    // Ensure pro bundle is loaded so handleHighValueToggle is registered.
    if (typeof hooks.handleHighValueToggle !== "function") {
      if (typeof hooks.requestProLoad === "function") {
        await hooks.requestProLoad();
      }
    }
    if (typeof hooks.handleHighValueToggle === "function") {
      hooks.handleHighValueToggle(nextActive);
    } else {
      console.warn("[HighValueFilter] pro bundle did not register handleHighValueToggle");
    }
    // Update search results AFTER pro is loaded so isHighValuePOI is available.
    applyToSearch(nextActive);
  };

  label.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const state = authService.getState();
    if (!state.authenticated || !state.isSubscriber) {
      AuthUI.showGetProModal();
      return;
    }
    const pop = (window as any).bootstrap?.Popover?.getInstance(label);
    if (pop) pop.hide();

    const alreadyActive = label.classList.contains("active");
    const next = !alreadyActive;
    applyActiveClass(next);

    // Keep focus on the search input so the overlay can open, and show an
    // immediate placeholder while the pro bundle / POI index catches up.
    if (next) {
      const searchInput = document.getElementById("unified-search-input") as HTMLInputElement | null;
      searchInput?.focus({ preventScroll: true });
      showHighValueLoading();
    }

    await toggleFilter(next);

    // Persist filter state to URL so reload / share-link works.
    const s = search ?? _activeSearch;
    if (s) updateURLWithSearch(s.searchInput.value, s.activeFilters);

    // If the index is still building, re-run when it becomes ready.
    if (next) {
      if (s && s.getIndexingState() !== "ready") {
        const off = s.onIndexingStateChange((st) => {
          if (st === "ready") {
            off();
            s.updateSearchResults();
          }
        });
      }
    }
  });

  filterBox.appendChild(label);

  // Restore from URL on rebuild (e.g., page load with ?f=hv,...).
  // Wait for auth to be definitively resolved before deciding. Pro users:
  // visually activate + invoke the pro toggle. Non-pro users: silently strip
  // "hv" from activeFilters AND refresh the search results so the user isn't
  // stuck looking at an empty list (matchesFilters returns false for every
  // POI when "hv" is set but the pro predicate isn't loaded).
  authService.ready.then((st) => {
    const s = search ?? _activeSearch;
    if (!s || !s.activeFilters.has("hv")) return;
    if (st.authenticated && st.isSubscriber) {
      applyActiveClass(true);
      toggleFilter(true);
    } else {
      s.activeFilters.delete("hv");
      updateURLWithSearch(s.searchInput.value, s.activeFilters);
      s.updateSearchResults();
    }
  });
}

const BOSS_TYPES = new Set([
  "triangle_boss",
  "alchemist_boss",
  "pyramid_boss",
  "dragon",
  "boss_wizard",
  "boss_ghost",
  "friend",
  "boss_sky",
  "islandspirit",
  "boss_centipede",
  "boss_robot",
  "boss_meat",
  "boss_pit",
  "boss_fish",
  "tiny",
]);

// Pillar requirement targetType -> CREATURE_DATA id, so boss segments index the
// same English aliases as the boss POIs (mirrors entityNameForSearch below).
const PILLAR_TARGET_CREATURE: Record<string, string> = {
  alchemist_boss: "boss_alchemist",
  pyramid_boss: "boss_limbs",
  dragon: "boss_dragon",
  triangle_boss: "boss_gate",
  boss_fish: "fish_giga",
  tiny: "maggot_tiny",
  islandspirit: "islandspirit",
  friend: "friend",
  boss_ghost: "boss_ghost",
  boss_sky: "boss_sky",
  boss_wizard: "boss_wizard",
  boss_centipede: "boss_centipede",
  boss_robot: "boss_robot",
  boss_meat: "boss_meat",
  boss_pit: "boss_pit",
};

/** Check if a POI matches any of the active filters. */
function matchesFilters(p: DynamicPOI, activeFilters: Set<string>): boolean {
  if (activeFilters.size === 0) return true;
  // Treat "hv" as a no-op while the pro predicate isn't loaded yet so the
  // user isn't stuck looking at an empty list during bundle load / before
  // the non-pro strip-from-URL fires.
  const hvPred = window.__noitamap?.isHighValuePOI;
  const hvIneffective = activeFilters.has("hv") && !hvPred;
  if (hvIneffective && activeFilters.size === 1) return true;
  if (activeFilters.has("hv") && hvPred) {
    if (hvPred(p)) return true;
    // Also match high-value inner items inside containers (chests, HM shops, etc.).
    if (Array.isArray(p.items)) {
      for (const ci of p.items) {
        if (ci && hvPred(ci)) return true;
      }
    }
  }
  if (activeFilters.has("w") && p.type === "wand") return true;
  if (activeFilters.has("s") && p.type === "item" && p.item === "spell") return true;
  if (
    activeFilters.has("i") &&
    p.type === "item" &&
    p.item !== "spell" &&
    p.item !== "perk" &&
    !isAchievementPillarSegment(p)
  )
    return true;
  if (activeFilters.has("pk") && p.type === "item" && p.item === "perk") return true;
  if (activeFilters.has("pi") && isAchievementPillarSegment(p)) return true;
  if (activeFilters.has("c") && CHEST_TYPES.has(p.type)) return true;
  if (activeFilters.has("hm") && HOLY_MOUNTAIN_TYPES.has(p.type)) return true;
  if (
    activeFilters.has("p") &&
    p.type === "item" &&
    (p.item === "potion" ||
      p.item === "potion_normal" ||
      p.item === "pouch" ||
      p.item === "powder_stash" ||
      p.item === "powder_stash_pouch")
  )
    return true;
  if (
    activeFilters.has("h") &&
    p.type === "item" &&
    (p.item === "heart" || p.item === "heart_bigger" || p.item === "full_heal")
  )
    return true;
  if (activeFilters.has("b") && BOSS_TYPES.has(p.type)) return true;
  if (activeFilters.has("e") && p.type === "entity") return true;
  if (activeFilters.has("or") && p.type === "item" && p.item === "orb") return true;
  return false;
}
export type UnifiedSearchCreateOptions = {
  currentMap: MapName;
  form: HTMLFormElement;
  initialFilters?: string[];
};

type UnifiedSearchConstructOptions = {
  currentMap: MapName;
  form: HTMLFormElement;
  searchInput: HTMLInputElement;
  searchResults: UnifiedSearchResults;
  initialFilters?: string[];
};

export interface UnifiedSearch {
  activeFilters: Set<string>;
  searchInput: HTMLInputElement;
  triggerSearch(value: string, selectIndex?: number): void;
  triggerSearchWithFallback(value: string, note: { text: string; telescopeUrl: string }, resultNotice?: string, rebuild?: () => string): void;
  setCategoryFilter(filter?: string): void;
  getCurrentQuery(): string;
  showOverlay(): void;
  on(event: "selected", listener: (target: TargetOfInterest | { type: "spell"; spell: any }) => void): this;
}

// FlexSearch Document factory — FlexSearch is loaded as a global via script tag
type DocumentFactory = (options: any) => any;

export class UnifiedSearch extends EventEmitter2 {
  private lastSearchText: string = "";
  private lastSearchFilters: string = "";
  private lastViewportKey: string = "";
  private isInteracting: boolean = false;

  public form: HTMLFormElement;
  public searchInput: HTMLInputElement;
  public activeFilters: Set<string> = new Set();
  private searchResults: UnifiedSearchResults;
  private dynamicPOIs: DynamicPOI[] = [];
  private dynamicIndex: any = null; // FlexSearch.Document index for dynamic POIs
  private dynamicPOIMap: Map<string, DynamicPOI> = new Map(); // fast id→POI lookup
  private indexingState: "idle" | "indexing" | "ready" = "idle";

  private _currentMap: MapName;
  /** When set, alchemy recipe is displayed; suppress text-query / viewport-based result refreshes. */
  private alchemyActive: boolean = false;
  private indexingListeners: Set<(s: "idle" | "indexing" | "ready") => void> = new Set();
  /** One-shot Telescope fallback note for the next no-results render (pillar search links). */
  private pendingNoResultNote: { text: string; telescopeUrl: string } | null = null;
  private activeResultNotice: { text: string; forQuery: string } | null = null;
  /**
   * When the active query came from a pillar search link, this rebuilds it in
   * the CURRENT language. Only the active i18n bundle is loaded, so a localized
   * query ("Сундук с сокровищами") can't match an index re-tokenized into
   * another language after a language switch — refreshTranslations() calls this
   * to re-translate the box query so results survive the switch.
   */
  private activeQueryRebuild: (() => string) | null = null;

  public getIndexingState(): "idle" | "indexing" | "ready" {
    return this.indexingState;
  }

  public onIndexingStateChange(cb: (s: "idle" | "indexing" | "ready") => void): () => void {
    this.indexingListeners.add(cb);
    return () => this.indexingListeners.delete(cb);
  }

  public setAlchemyActive(active: boolean): void {
    const wasActive = this.alchemyActive;
    this.alchemyActive = active;
    if (!active) {
      for (const b of document.querySelectorAll<HTMLLabelElement>(".alchemy-filter-btn")) {
        b.classList.remove("active");
      }
      // When exiting alchemy mode, repopulate the results so the overlay
      // isn't left empty and can show "10 nearest" / the active query.
      if (wasActive) {
        this.lastSearchText = "__force__";
        this.lastViewportKey = "";
        this.updateSearchResults();
      }
    }
  }

  private clearAlchemyIfActive(): void {
    if (!this.alchemyActive) return;
    this.alchemyActive = false;
    for (const b of document.querySelectorAll<HTMLLabelElement>(".alchemy-filter-btn")) {
      b.classList.remove("active");
    }
    const hooks = (window as any).__noitamap;
    if (hooks && typeof hooks.handleAlchemyRecipe === "function") {
      hooks.handleAlchemyRecipe(null);
    }
  }

  public get currentMap(): MapName {
    return this._currentMap;
  }
  public set currentMap(value: MapName) {
    const wasDynamic = this._currentMap === "dynamic-main-branch";
    const isDynamic = value === "dynamic-main-branch";
    this._currentMap = value;
    if (wasDynamic !== isDynamic) {
      this.rebuildFilters(value);
      // Clear search state so stale results don't persist
      this.searchInput.value = "";
      this.activeFilters.clear();
      this.lastSearchText = "__force__";
      this.lastSearchFilters = "";
      this.lastViewportKey = "";
      this.updateSearchResults();
    }
  }

  private constructor({ currentMap, form, searchInput, searchResults, initialFilters }: UnifiedSearchConstructOptions) {
    super();

    this._currentMap = currentMap;
    this.form = form;
    this.searchInput = searchInput;
    this.searchResults = searchResults;
    if (initialFilters) {
      initialFilters.forEach((f) => this.activeFilters.add(f));
    }

    _activeSearch = this;

    this.bindEvents();
  }

  /** Set interaction state (pause sorting during map move) */
  setInteracting(interacting: boolean): void {
    this.isInteracting = interacting;
    // When interaction ends, do one final sort
    if (!interacting) {
      this.notifyViewportChanged();
    }
  }

  /** Notify the search that the map viewport has moved. Re-sorts results by proximity. */
  notifyViewportChanged(): void {
    if (this.alchemyActive) return;
    if (this.currentMap !== "dynamic-main-branch") return;
    if (this.isInteracting) return; // Skip sorting while user is actively moving the map

    if (this.searchInput.value.trim() === "") {
      // Empty search on dynamic map: recalculate "10 nearest" with new viewport position
      this.lastViewportKey = ""; // force recalculation
      this.lastSearchText = "__force__"; // bypass dedup guard
      this.updateSearchResults();
      return;
    }

    // Non-empty search: just re-sort existing results by proximity
    const urlParams = new URLSearchParams(window.location.search);
    const x = parseInt(urlParams.get("x") ?? "", 10);
    const y = parseInt(urlParams.get("y") ?? "", 10);
    if (!isNaN(x) && !isNaN(y)) {
      this.searchResults.resortByProximity(x, y);
    }
  }

  private bindEvents() {
    this.searchResults.on("selected", (result: any) => {
      this.emit("selected", result);
    });

    const debounced = debounce(100, () => this.updateSearchResults());

    // never submit the form
    this.form.addEventListener("submit", (ev) => {
      ev.preventDefault();
      // if the "search" event isn't present, still update the search
      // results when the user hits enter in the search box
      debounced();
    });

    // nonstandard event for when user hits enter (or clicks the x) in
    // an <input type="search">
    this.searchInput.addEventListener("search", debounced);

    // "live" search - show list of results as the user types
    this.searchInput.addEventListener("keyup", (ev) => {
      if (!(ev.altKey || ev.shiftKey || ev.ctrlKey || ev.metaKey || ev.isComposing)) {
        switch (ev.key) {
          case "Escape":
            this.searchInput.value = "";
            this.clearAlchemyIfActive();
            this.updateSearchResults();
            break;
          case "ArrowDown":
            this.searchResults.focusNext();
            return;
          case "ArrowUp":
            this.searchResults.focusPrevious();
            return;
        }
      }
      // Any typed character should exit alchemy mode so the user can search.
      this.clearAlchemyIfActive();
      // Manual typing invalidates the pillar-search re-translation binding.
      this.activeQueryRebuild = null;
      debounced();
    });

    this.searchResults.on("blur", () => {
      this.searchInput.focus();
    });

    for (const filterCheckbox of document.querySelectorAll<HTMLInputElement>(
      '#unifiedSearchFilterBox input[type="checkbox"][data-filter]',
    )) {
      if (this.activeFilters.has(filterCheckbox.value)) {
        filterCheckbox.checked = true;
      }
      filterCheckbox.addEventListener("change", () => {
        if (filterCheckbox.checked) {
          this.activeFilters.add(filterCheckbox.value);
        } else {
          this.activeFilters.delete(filterCheckbox.value);
        }
        this.updateSearchResults();
      });
    }
  }

  /** Bind filter checkbox events. Must be called after filter DOM is created. */
  bindFilterEvents() {
    for (const filterCheckbox of document.querySelectorAll<HTMLInputElement>(
      '#unifiedSearchFilterBox input[type="checkbox"][data-filter]',
    )) {
      if (this.activeFilters.has(filterCheckbox.value)) {
        filterCheckbox.checked = true;
      }
      filterCheckbox.addEventListener("change", () => {
        if (filterCheckbox.checked) {
          this.activeFilters.add(filterCheckbox.value);
        } else {
          this.activeFilters.delete(filterCheckbox.value);
        }
        this.updateSearchResults();
      });
    }
  }

  /** Rebuild filter checkboxes when switching between dynamic and static map types. */
  private rebuildFilters(newMap: MapName): void {
    const filterBox = document.getElementById("unifiedSearchFilterBox");
    if (!filterBox) return;

    // Dispose existing popovers
    filterBox.querySelectorAll('[data-bs-toggle="popover"]').forEach((el: Element) => {
      const existing = (window as any).bootstrap?.Popover?.getInstance(el);
      if (existing) existing.dispose();
    });
    filterBox.replaceChildren();

    const isDynamicMap = newMap === "dynamic-main-branch";
    const filters: Array<{ type: string; iconSrc?: string; atlasKey?: string }> = isDynamicMap
      ? [
          { type: "w", atlasKey: "wand:handgun" },
          { type: "s", atlasKey: "spell:mana" },
          { type: "i", atlasKey: "item:wandstone" },
          { type: "c", atlasKey: "item:chest_random_super" },
          { type: "hm", iconSrc: "assets/icons/spatial_awareness/spatial_awareness_holy_mountain.png" },
          { type: "p", atlasKey: "item:potion:acid" },
          { type: "h", atlasKey: "item:heart_extrahp" },
          { type: "pk", atlasKey: "item:perks/critical_hit" },
          { type: "b", iconSrc: "assets/icons/overlay-toggles/icon-bosses.webp" },
          { type: "e", atlasKey: "spell:exploding_deer" },
          { type: "or", iconSrc: "assets/icons/overlay-toggles/icon-orbs.webp" },
          { type: "pi", atlasKey: "pillar:pillar_part_secretall" },
        ]
      : [
          { type: "s", iconSrc: "assets/icons/spells/light_bullet.png" },
          { type: "st", iconSrc: "assets/icons/overlay-toggles/icon-structures.svg" },
          { type: "b", iconSrc: "assets/icons/overlay-toggles/icon-bosses.webp" },
          { type: "i", iconSrc: "assets/icons/overlay-toggles/icon-items.webp" },
          { type: "or", iconSrc: "assets/icons/overlay-toggles/icon-orbs.webp" },
          { type: "sa", iconSrc: "assets/icons/overlay-toggles/icon-spatial-awareness.webp" },
          { type: "msg", iconSrc: "assets/icons/overlay-toggles/icon-hidden-messages.webp" },
        ];

    const FILTER_LABELS: Record<string, string> = {
      w: i18next.t("filterLabels.wands", "Wands"),
      s: i18next.t("filterLabels.spells", "Spells"),
      i: i18next.t("filterLabels.items", "Items"),
      c: i18next.t("filterLabels.chests", "Chests"),
      hm: i18next.t("filterLabels.holyMountains", "Holy Mountains"),
      p: i18next.t("filterLabels.potions", "Potions & Flasks"),
      h: i18next.t("filterLabels.hearts", "Hearts & Heals"),
      pk: i18next.t("filterLabels.perks", "Perks"),
      b: i18next.t("filterLabels.bosses", "Bosses"),
      e: i18next.t("filterLabels.creatures", "Enemies"),
      st: i18next.t("filterLabels.structures", "Structures"),
      or: i18next.t("filterLabels.orbs", "Orbs"),
      pi: i18next.t("filterLabels.pillars", "Achievement Pillars"),
      sa: i18next.t("filterLabels.spatialAwareness", "Spatial Awareness"),
      msg: i18next.t("filterLabels.hiddenMessages", "Hidden Messages"),
    };
    const FILTER_DESCRIPTIONS: Record<string, string> = {
      w: i18next.t("searchFilters.wands", "Filter results to show only wands"),
      s: i18next.t("searchFilters.spells", "Filter results to show only spells"),
      i: i18next.t("searchFilters.items", "Filter results to show only items"),
      c: i18next.t("searchFilters.chests", "Filter results to show only chests"),
      hm: i18next.t("searchFilters.holyMountains", "Filter results to show only Holy Mountain shops"),
      p: i18next.t("searchFilters.potions", "Filter results to show only potions"),
      h: i18next.t("searchFilters.hearts", "Filter results to show only hearts"),
      pk: i18next.t("searchFilters.perks", "Filter results to show only perks"),
      b: i18next.t("searchFilters.bosses", "Filter results to show only bosses"),
      e: i18next.t("searchFilters.creatures", "Filter results to show only creatures"),
      st: i18next.t("searchFilters.structures", "Filter results to show only structures"),
      or: i18next.t("searchFilters.orbs", "Filter results to show only orbs"),
      pi: i18next.t("searchFilters.pillars", "Filter results to show only Achievement Pillar segments"),
      sa: i18next.t("searchFilters.spatialAwareness", "Filter results to show only spatial awareness points"),
      msg: i18next.t("searchFilters.hiddenMessages", "Filter results to show only hidden messages"),
    };

    for (const filter of filters) {
      const filterLabel = document.createElement("label");
      filterLabel.tabIndex = 0;
      const labelText = FILTER_LABELS[filter.type] || filter.type;
      filterLabel.dataset.bsToggle = "popover";
      filterLabel.dataset.bsPlacement = "bottom";
      filterLabel.dataset.bsTrigger = "hover";
      filterLabel.dataset.bsHtml = "true";
      filterLabel.dataset.bsTitle = labelText;
      filterLabel.dataset.bsContent = FILTER_DESCRIPTIONS[filter.type] || labelText;
      filterLabel.dataset.filterType = filter.type;
      const filterCheckbox = document.createElement("input");
      filterCheckbox.type = "checkbox";
      filterCheckbox.value = filter.type;
      filterCheckbox.dataset.filter = "true";
      filterLabel.appendChild(filterCheckbox);
      const filterIcon = document.createElement("img");
      if (filter.atlasKey) {
        const key = filter.atlasKey;
        import("../telescope/poi-spatial-index").then((mod) => {
          mod.loadSpritesheetAndAtlas().then(({ atlas, spritesheet }: any) => {
            const entry = atlas[key];
            if (!entry) return;
            const frame = mod.FIRST_FRAME_SIZE[key];
            const srcW = frame ? frame.w : entry.w;
            const srcH = frame ? frame.h : entry.h;
            const canvas = document.createElement("canvas");
            canvas.width = srcW;
            canvas.height = srcH;
            const ctx = canvas.getContext("2d")!;
            ctx.imageSmoothingEnabled = false;
            ctx.drawImage(spritesheet, entry.x, entry.y, srcW, srcH, 0, 0, srcW, srcH);
            canvas.toBlob((blob) => {
              if (blob) filterIcon.src = URL.createObjectURL(blob);
            }, "image/png");
          });
        });
      } else {
        filterIcon.src = filter.iconSrc!;
      }
      filterIcon.alt = "";
      filterIcon.classList.add("pixelated-image");
      if (filter.type === "w") filterIcon.classList.add("filter-wand");
      filterIcon.draggable = false;
      filterLabel.appendChild(filterIcon);
      filterBox.appendChild(filterLabel);
    }

    if (isDynamicMap) appendAlchemyStubs(filterBox);
    if (isDynamicMap) appendHighValueStub(filterBox, this);

    // Initialize Bootstrap popovers
    // @ts-ignore
    filterBox.querySelectorAll('[data-bs-toggle="popover"]').forEach((el: HTMLElement) => new bootstrap.Popover(el));

    // Re-bind filter checkbox events
    this.bindFilterEvents();
  }

  /** Refresh filter popover translations after language change */
  refreshFilterTranslations() {
    const FILTER_LABELS: Record<string, string> = {
      w: i18next.t("filterLabels.wands", "Wands"),
      s: i18next.t("filterLabels.spells", "Spells"),
      i: i18next.t("filterLabels.items", "Items"),
      c: i18next.t("filterLabels.chests", "Chests"),
      hm: i18next.t("filterLabels.holyMountains", "Holy Mountains"),
      p: i18next.t("filterLabels.potions", "Potions & Flasks"),
      h: i18next.t("filterLabels.hearts", "Hearts & Heals"),
      pk: i18next.t("filterLabels.perks", "Perks"),
      b: i18next.t("filterLabels.bosses", "Bosses"),
      e: i18next.t("filterLabels.creatures", "Enemies"),
      st: i18next.t("filterLabels.structures", "Structures"),
      or: i18next.t("filterLabels.orbs", "Orbs"),
      pi: i18next.t("filterLabels.pillars", "Achievement Pillars"),
      sa: i18next.t("filterLabels.spatialAwareness", "Spatial Awareness"),
      msg: i18next.t("filterLabels.hiddenMessages", "Hidden Messages"),
    };
    const FILTER_DESCRIPTIONS: Record<string, string> = {
      w: i18next.t("searchFilters.wands", "Filter results to show only wands"),
      s: i18next.t("searchFilters.spells", "Filter results to show only spells"),
      i: i18next.t("searchFilters.items", "Filter results to show only items"),
      c: i18next.t("searchFilters.chests", "Filter results to show only chests"),
      hm: i18next.t("searchFilters.holyMountains", "Filter results to show only Holy Mountain shops"),
      p: i18next.t("searchFilters.potions", "Filter results to show only potions"),
      h: i18next.t("searchFilters.hearts", "Filter results to show only hearts"),
      pk: i18next.t("searchFilters.perks", "Filter results to show only perks"),
      b: i18next.t("searchFilters.bosses", "Filter results to show only bosses"),
      e: i18next.t("searchFilters.creatures", "Filter results to show only creatures"),
      st: i18next.t("searchFilters.structures", "Filter results to show only structures"),
      or: i18next.t("searchFilters.orbs", "Filter results to show only orbs"),
      pi: i18next.t("searchFilters.pillars", "Filter results to show only Achievement Pillar segments"),
      sa: i18next.t("searchFilters.spatialAwareness", "Filter results to show only spatial awareness points"),
      msg: i18next.t("searchFilters.hiddenMessages", "Filter results to show only hidden messages"),
    };

    for (const label of document.querySelectorAll<HTMLLabelElement>(
      "#unifiedSearchFilterBox label[data-filter-type]",
    )) {
      const type = label.dataset.filterType!;
      const title = FILTER_LABELS[type] || type;
      label.dataset.bsTitle = title;
      label.dataset.bsContent = FILTER_DESCRIPTIONS[type] || title;
      // Dispose and re-create popover with new content
      const existing = (window as any).bootstrap?.Popover?.getInstance(label);
      if (existing) existing.dispose();
      new (window as any).bootstrap.Popover(label);
    }
  }

  setSearchValueWithoutTriggering(value: string) {
    this.searchInput.value = value;
    this.lastSearchText = value;
  }

  getCurrentQuery(): string {
    return this.searchInput.value;
  }

  triggerSearch(value: string) {
    this.searchInput.value = value;
    (this as any).explicitShowRequested = true;
    // Bypass the dedup guard in updateSearchResults: a pillar link can fire
    // the SAME query that's already in the input (orb chips on two different
    // cards), and without this the guard would return early, never consuming
    // explicitShowRequested — so the results overlay wouldn't reopen.
    this.lastSearchText = "__force__";
    this.updateSearchResults();
  }

  /**
   * Pillar search link: run a query and, if it finds nothing on this seed's
   * visible map, show a Telescope fallback note (the target may still exist
   * off-screen or in a parallel world the map didn't render). The note is
   * consumed on the next render. `resultNotice` is the opposite case — an
   * info banner shown WITH the results (e.g. structure searches where only
   * the destination chamber exists on this seed); it stays attached to this
   * exact query and disappears once the query changes.
   */
  triggerSearchWithFallback(value: string, note: { text: string; telescopeUrl: string }, resultNotice?: string, rebuild?: () => string): void {
    this.pendingNoResultNote = note;
    this.activeResultNotice = resultNotice ? { text: resultNotice, forQuery: value } : null;
    this.activeQueryRebuild = rebuild ?? null;
    this.triggerSearch(value);
  }

  /**
   * Replace the active category filters with exactly `filter` (or none),
   * keeping the pro high-value overlay ("hv") untouched — pillar search links
   * co-activate the one filter that matches their target, and a lingering
   * filter from a previous link would hide the new results (e.g. a perks
   * filter left on while searching utility boxes). Checkbox UI is synced.
   */
  setCategoryFilter(filter?: string): void {
    for (const f of [...this.activeFilters]) if (f !== "hv") this.activeFilters.delete(f);
    if (filter) this.activeFilters.add(filter);
    for (const cb of document.querySelectorAll<HTMLInputElement>(
      '#unifiedSearchFilterBox input[type="checkbox"][data-filter]',
    )) {
      cb.checked = this.activeFilters.has(cb.value);
    }
  }

  /** Replace the dynamic POI index (called by the generation pipeline). */
  setDynamicPOIs(pois: DynamicPOI[]): void {
    // Append the true-orb synthetic POIs (see getTrueOrbPOIs) unless the
    // generation already carries real orb POIs (NG+ maps, where
    // biomeData.orbs is populated). Empty input means the map was cleared —
    // keep it empty.
    if (pois.length > 0 && !pois.some((p) => p.item === "orb")) {
      pois = pois.concat(getTrueOrbPOIs());
    }
    this.dynamicPOIs = pois;
    this.rebuildDynamicIndex(pois);
    // Always refresh search results — triggers initial "10 nearest" display
    // even when search box is empty
    this.lastSearchText = "__force__";
    this.lastViewportKey = "";
    this.updateSearchResults();
  }

  /** Set the search indexing state (idle | indexing | ready). */
  setIndexingState(state: "idle" | "indexing" | "ready"): void {
    const prev = this.indexingState;
    this.indexingState = state;
    if (prev !== state) {
      for (const cb of this.indexingListeners) {
        try {
          cb(state);
        } catch {
          /* ignore listener errors */
        }
      }
    }
    if (this.alchemyActive) return;
    // When transitioning to 'ready', force a search refresh so results appear
    if (state === "ready" && prev === "indexing") {
      this.lastSearchText = "__force__";
      this.lastViewportKey = "";
      this.updateSearchResults();
    }
    // When transitioning to 'indexing', update display immediately
    if (state === "indexing") {
      this.lastSearchText = "__force__";
      this.updateSearchResults();
    }
  }

  /** Build a FlexSearch Document index over the dynamic POI array for fast text queries. */
  private rebuildDynamicIndex(pois: DynamicPOI[]): void {
    // Build a compound searchable text field for each POI
    this.dynamicPOIMap = new Map();

    this.dynamicIndex = (FlexSearch.Document as DocumentFactory)({
      document: {
        id: "id",
        index: ["searchText"],
      },
      tokenize: "forward",
    });

    // Pre-build O(1) spell lookup to avoid O(N) spells.find() per spell reference
    const spellById = new Map<string, (typeof spells)[0]>();
    for (const s of spells) spellById.set(s.id, s);

    for (const p of pois) {
      this.dynamicPOIMap.set(p.id, p);

      // Concatenate all searchable fields into one text blob
      const parts: string[] = [p.name ?? "", p.type ?? "", p.item ?? "", p.enemy ?? "", p.material ?? ""];

      // POIs carrying an explicit in-game translation key (e.g. item_chest_dark,
      // item_chest_light, item_musicstone) are searchable by their localized name.
      if ((p as any).nameKey) {
        const t = gameTranslator.translateItem(String((p as any).nameKey));
        if (t && t !== (p as any).nameKey) parts.push(t);
      }

      // Pillar search links put a localized item name in the search bar. Index
      // that same name (keyed on POI type or item id, see ITEM_SEARCH_NAME_KEYS)
      // so multi-instance sacrifice items / orbs are found in every language.
      {
        const nameKey = ITEM_SEARCH_NAME_KEYS[p.type] ?? ITEM_SEARCH_NAME_KEYS[p.item ?? ""];
        if (nameKey) {
          const t = gameTranslator.translateItem(nameKey);
          if (t && t !== nameKey) parts.push(t);
        }
        // Props with no in-game name (statue_hand, sunstones): index the
        // approved pillar.item.* translation so the pillar link's query hits.
        const localeKey = ITEM_LOCALE_NAME_KEYS[p.item ?? ""] ?? ITEM_LOCALE_NAME_KEYS[p.type];
        if (localeKey) parts.push(resolvePillarItemName(localeKey, (k, dv) => String(i18next.t(k, dv))));
      }

      // Achievement pillar segments: index the curated title (p.name), the
      // localized pillar theme ("Pillar of Bosses") and, when the requirement
      // names a boss/essence via a common.csv key, that verified localized
      // name — so "Suomuhauki" or its translation finds the boss's segment.
      // Boss segments also index the English community alias ("Dragon"),
      // mirroring the boss POIs themselves.
      if (isAchievementPillarSegment(p)) {
        parts.push("pillar", "achievement");
        const theme = (p as any).theme;
        if (theme) {
          const t = i18next.t(String(theme), String(theme));
          if (t) parts.push(t);
        }
        // Localized title (common.csv name / pillar.title.<flag>); the English
        // curated title is already in the blob via p.name.
        const title = pillarSegmentTitle(
          p as any,
          (k) => gameTranslator.translateItem(k),
          (k, dv) => i18next.t(k, dv),
        );
        if (title) parts.push(title);
        const spec = pillarReqSpec(p as any);
        const cid = spec?.creatureId ?? (spec?.targetType ? PILLAR_TARGET_CREATURE[spec.targetType] : undefined);
        if (cid) {
          const alias = CREATURE_ALIASES[cid];
          if (alias) parts.push(alias);
          const data = CREATURE_DATA[cid];
          if (data?.name) parts.push(data.name);
          if (data?.alias) parts.push(data.alias);
        }
      }

      // Add entity name and translated name for creature search
      let entityNameForSearch = "";
      if (p.type === "entity" && (p as any).entity) {
        entityNameForSearch = canonicalEntityId(String((p as any).entity));
      } else if (p.type === "alchemist_boss") {
        entityNameForSearch = "boss_alchemist";
      } else if (p.type === "mestari_boss") {
        entityNameForSearch = "boss_wizard";
      } else if (p.type === "boss_ghost") {
        entityNameForSearch = "boss_ghost";
      } else if (p.type === "triangle_boss") {
        entityNameForSearch = "boss_gate";
      } else if (p.type === "pyramid_boss") {
        entityNameForSearch = "boss_limbs";
      } else if (p.type === "dragon") {
        entityNameForSearch = "boss_dragon";
      } else if (p.type === "friend") {
        entityNameForSearch = "friend";
      } else if (p.type === "boss_sky") {
        entityNameForSearch = "boss_sky";
      } else if (p.type === "boss_wizard" || p.type === "mestari_boss") {
        entityNameForSearch = "boss_wizard";
      } else if (p.type === "boss_centipede") {
        entityNameForSearch = "boss_centipede";
      } else if (p.type === "boss_robot") {
        entityNameForSearch = "boss_robot";
      } else if (p.type === "boss_meat") {
        entityNameForSearch = "boss_meat";
      } else if (p.type === "boss_pit") {
        entityNameForSearch = "boss_pit";
      } else if (p.type === "boss_fish") {
        entityNameForSearch = "fish_giga";
      } else if (p.type === "tiny") {
        entityNameForSearch = "maggot_tiny";
      } else if (p.type === "islandspirit") {
        entityNameForSearch = "boss_spirit";
      }

      if (entityNameForSearch) {
        parts.push(entityNameForSearch);
        const translated = gameTranslator.translateItem(`animal_${entityNameForSearch}`);
        if (translated !== `animal_${entityNameForSearch}`) {
          parts.push(translated);
        }
        // Add English alias so "Rat", "Tentacler" etc. work in any language
        const alias = CREATURE_ALIASES[entityNameForSearch];
        if (alias) parts.push(alias);
        // Add official Finnish name so it's always searchable
        const data = CREATURE_DATA[entityNameForSearch];
        if (data?.name) parts.push(data.name);
        if (data?.alias) parts.push(data.alias);
      }

      // Add "flask" alias for potions so old-school players can find them
      if (p.item === "potion" || p.item === "potion_normal") {
        parts.push("flask");
      }

      // "Alive" wands (Taikasauva): p.name was overwritten with the gun-name
      // adjective, so the display "Taikasauva <Adj> wand" never reaches the
      // index. Add the Taikasauva label (+ translated name) so text search hits.
      if ((p as any).isTaikasauva) {
        parts.push("Taikasauva", "alive wand");
        const tk = gameTranslator.translateItem("animal_wand_ghost");
        if (tk && tk !== "animal_wand_ghost") parts.push(tk);
      }

      // Paha Silmä (Evil Eye): the POI carries only its Finnish name. Add the
      // English aliases so "evil eye" / "eye" find it. Keyed on item id so it
      // works on both freshly generated and previously baked POIs.
      if (p.type === "item" && p.item === "paha_silma") {
        parts.push("Paha Silmä", "paha silma", "evil eye", "eye");
      }

      // Potion mimic (Henkevä potu): index its creature name + English aliases.
      if (p.type === "item" && p.item === "mimic_potion") {
        const t = gameTranslator.translateItem("animal_mimic_potion");
        if (t && t !== "animal_mimic_potion") parts.push(t);
        parts.push("Henkevä potu", "potion mimic", "mimic potion", "mimicium");
      }

      // Emerald Tablets: index the proper title ("Secretorum Hermetis",
      // "Tabula Smaragdina", "Emerald Tablet - volume II") so they are findable
      // by their in-game name, not just "tablet".
      if (p.type === "item" && p.item === "emerald_tablet") {
        parts.push("tablet", "emerald tablet");
        if ((p as any).titleKey) {
          const t = gameTranslator.translateItem(String((p as any).titleKey));
          if (t && t !== (p as any).titleKey) parts.push(t);
        }
      }

      // Special named wands (Huilu/Kantele) carry only their Finnish name. Add
      // the English alias so e.g. "flute" finds Huilu. Keyed by sprite (stable).
      if (p.type === "wand" && (p as any).sprite) {
        const alias = SPECIAL_WAND_ALIAS[String((p as any).sprite)];
        if (alias) parts.push(alias);
      }

      // Add translated material name for potions/pouches
      if (p.material) {
        parts.push(gameTranslator.translateMaterial(p.material));
      }

      // Essences: index the translated name (item_essence_<material>) so they
      // are searchable in every language, not just by the English name.
      if (p.item === "essence" && p.material) {
        const key = `item_essence_${p.material}`;
        const t = gameTranslator.translateItem(key);
        if (t && t !== key) parts.push(t);
      }

      // Perks: index the translated perk name (perk_<id>).
      if (p.item === "perk" && (p as any).perk) {
        const key = perkNameKey((p as any).perk);
        const t = gameTranslator.translateItem(key);
        if (t && t !== key) parts.push(t);
      }

      // Loose spell POI on the ground: { type: "spell", item: "LIGHT_BULLET" }.
      // Index the spell's English + translated name so users can search by
      // human label ("spark bolt") instead of just the raw id.
      if (p.type === "spell" && p.item) {
        const spell = spellById.get(p.item);
        if (spell) {
          parts.push(spell.name);
          parts.push(gameTranslator.translateSpell(spell.name));
        }
      }

      // Index spell names (both ids and translated names)
      for (const spellId of [...(p.cards || []), ...(p.always_casts || [])]) {
        parts.push(spellId);
        const spell = spellById.get(spellId);
        if (spell) {
          parts.push(spell.name);
          parts.push(gameTranslator.translateSpell(spell.name));
        }
      }

      // Index container item names
      if (p.items && Array.isArray(p.items)) {
        for (const ci of p.items) {
          if (ci.ignore) continue;
          if (ci.item) parts.push(ci.item);
          if (ci.name) parts.push(ci.name);
          if (ci.nameKey) {
            const t = gameTranslator.translateItem(String(ci.nameKey));
            if (t && t !== ci.nameKey) parts.push(t);
          }
          if (ci.material) {
            parts.push(ci.material);
            parts.push(gameTranslator.translateMaterial(ci.material));
          }
          if (ci.enemy) parts.push(ci.enemy);
          if (ci.spell) {
            parts.push(ci.spell);
            // Index the spell's English + translated name so a drop like
            // {spell:"MASS_POLYMORPH"} is findable by "Muodonmuutos".
            const sp = spellById.get(ci.spell) || spellById.get(String(ci.spell).toUpperCase());
            if (sp) {
              parts.push(sp.name);
              parts.push(gameTranslator.translateSpell(sp.name));
            }
          }
          // Essence / perk drops: index their translated names.
          if (ci.item === "essence" && ci.material) {
            const k = `item_essence_${ci.material}`;
            const t = gameTranslator.translateItem(k);
            if (t && t !== k) parts.push(t);
          }
          if (ci.item === "perk" && ci.perk) {
            const k = perkNameKey(ci.perk);
            const t = gameTranslator.translateItem(k);
            if (t && t !== k) parts.push(t);
          }
          if (ci.item === "potion" || ci.item === "potion_normal") {
            parts.push("flask");
          }
          for (const cSpellId of [...(ci.cards || []), ...(ci.always_casts || [])]) {
            parts.push(cSpellId);
            const spell = spellById.get(cSpellId);
            if (spell) {
              parts.push(spell.name);
              parts.push(gameTranslator.translateSpell(spell.name));
            }
          }
        }
      }

      this.dynamicIndex.add({
        id: p.id,
        searchText: parts.filter(Boolean).join(" "),
      });
    }
  }

  // Method to refresh search results with new translations
  refreshTranslations() {
    this.refreshFilterTranslations();

    // Rebuild the dynamic index: some POIs (orbs, sacrifice items) are only
    // searchable by their localized name (ITEM_SEARCH_NAME_KEYS), so the index
    // holds the previous language's tokens until rebuilt. Without this, a query
    // in the new language misses them.
    if (this.dynamicPOIs.length > 0) this.rebuildDynamicIndex(this.dynamicPOIs);

    // A pillar-search query is a localized item name; after the index is
    // re-tokenized into the new language the old-language text no longer
    // matches (only the active i18n bundle is loaded). Re-translate the box
    // query so the same search keeps working across a language switch.
    if (this.activeQueryRebuild) {
      const next = this.activeQueryRebuild();
      if (next) this.searchInput.value = next;
    }

    // Force update by ignoring last search state
    this.lastSearchText = "__force__";
    this.updateSearchResults();
  }

  /** Force a full re-render of search results (e.g. when spoiler-free toggles). */
  forceRefresh() {
    this.lastSearchText = "__force__";
    this.lastViewportKey = "";
    this.updateSearchResults();
  }

  public updateSearchResults() {
    if (this.alchemyActive) return;
    // Consume any pending pillar-search fallback note exactly once per render,
    // so a stale note can't leak onto a later hand-typed query that misses.
    const pillarNote = this.pendingNoResultNote ?? undefined;
    this.pendingNoResultNote = null;
    const searchText = this.searchInput.value;
    // Also check viewport position for dynamic map proximity sorting
    const urlParams = new URLSearchParams(window.location.search);
    const vpKey = `${urlParams.get("x") ?? ""},${urlParams.get("y") ?? ""}`;
    const filterKey = [...this.activeFilters].sort().join(",");
    if (this.lastSearchText === searchText && this.lastSearchFilters === filterKey && this.lastViewportKey === vpKey)
      return;
    this.lastSearchText = searchText;
    this.lastSearchFilters = filterKey;
    this.lastViewportKey = vpKey;

    const isDynamic = this.currentMap === "dynamic-main-branch";

    // Read player position from URL for proximity sorting (needed for both empty & non-empty search on dynamic map)
    // NB: use Number.isNaN, NOT `|| null` — `parseFloat("0") || null` is null,
    // which broke the "10 nearest" view whenever the viewport sat at x=0 or y=0
    // (the default whole-world baked-daily view).
    const px = parseFloat(urlParams.get("x") ?? "");
    const py = parseFloat(urlParams.get("y") ?? "");
    const playerX = Number.isNaN(px) ? null : px;
    const playerY = Number.isNaN(py) ? null : py;

    if (searchText === "") {
      resetBiomeOverlays();
      if (isDynamic && this.indexingState === "indexing") {
        // Show indexing placeholder
        this.searchResults.setIndexingPlaceholder();
        return;
      }
      if (isDynamic && playerX !== null && playerY !== null && this.dynamicPOIs && this.dynamicPOIs.length > 0) {
        // Find the 10 closest items using a fast O(N) array pass with squared distances
        const topK = 10;
        const closest: { poi: any; distSq: number }[] = [];

        for (let i = 0; i < this.dynamicPOIs.length; i++) {
          const p = this.dynamicPOIs[i];
          if (p.type === "enemies" || p.type === "props") continue;
          if (!matchesFilters(p, this.activeFilters)) continue;
          const dx = p.worldX - playerX;
          const dy = p.worldY - playerY;
          const distSq = dx * dx + dy * dy;

          if (closest.length < topK) {
            closest.push({ poi: p, distSq });
            closest.sort((a, b) => a.distSq - b.distSq);
          } else if (distSq < closest[topK - 1].distSq) {
            closest[topK - 1] = { poi: p, distSq };
            closest.sort((a, b) => a.distSq - b.distSq);
          }
        }

        const sortedPOIs = closest.map((c) => c.poi);
        const CHUNK_SIZE = 512;

        // Map to expected UnifiedSearchResult format (adding overlayType, chunksAway, etc)
        const displayResults = sortedPOIs.map((p) => {
          const chunksAway = Math.round(Math.hypot(p.worldX - playerX, p.worldY - playerY) / CHUNK_SIZE);
          return {
            id: p.id,
            overlayType: "poi" as const,
            name: p.name ?? p.type,
            displayName: p.name ?? p.type,
            x: p.worldX,
            y: p.worldY,
            maps: ["dynamic-main-branch" as any],
            chunksAway,
            isDynamic: true,
            type: p.type,
            sprite: p.sprite,
            wandName: p.name,
            isTaikasauva: (p as any).isTaikasauva === true,
            cards: p.cards,
            alwaysCasts: p.always_casts,
            item: p.item,
            material: p.material,
            enemy: p.enemy,
            entity: p.entity,
            items: p.items,
            amount: p.amount,
            spell: p.spell,
            nameKey: (p as any).nameKey,
            chestVariant: (p as any).chestVariant,
            perk: (p as any).perk,
            titleKey: (p as any).titleKey,
            orbIndex: (p as any).orbIndex,
            flag: (p as any).flag,
            segCode: (p as any).segCode,
            locked: (p as any).locked,
            pillarIndex: (p as any).pillarIndex,
            theme: (p as any).theme,
            reqSpec: pillarReqSpec(p as any),
            wiki: (p as any).wiki,
          };
        });

        this.searchResults.setResults(displayResults as any);
      } else {
        this.searchResults.setResults([]);
      }
      return;
    }

    if (isDynamic && this.indexingState === "indexing") {
      this.searchResults.setIndexingPlaceholder();
      return;
    }

    if (isDynamic) {
      // Dynamic map: search dynamic POIs via FlexSearch index
      const CHUNK_SIZE = 512;

      let matched: DynamicPOI[] = [];

      // "a | b | c" runs one search per term and unions the results (FlexSearch
      // has no OR inside a single query string — tokens are ANDed). Used by the
      // pillar transformation links; also works when typed by hand.
      const orTerms = searchText.includes("|")
        ? searchText.split("|").map((s) => s.trim()).filter(Boolean)
        : [searchText];

      if (this.dynamicIndex) {
        // Query the FlexSearch index for matching POI ids with a high limit (default is 100)
        const ids = new Set<string>();
        for (const term of orTerms) {
          const found = this.dynamicIndex.search(term, 10000).flatMap((v: any) => v.result);
          for (const id of found) ids.add(id);
        }
        matched = [...ids].map((id) => this.dynamicPOIMap.get(id)).filter(Boolean) as DynamicPOI[];
      } else {
        // Fallback: brute-force filter if index not built yet
        const termsLower = orTerms.map((t) => t.toLowerCase());
        matched = this.dynamicPOIs.filter((p) =>
          termsLower.some(
            (searchLower) =>
              (p.name ?? p.type ?? "").toLowerCase().includes(searchLower) ||
              (p.item ?? "").toLowerCase().includes(searchLower) ||
              p.type.toLowerCase().includes(searchLower),
          ),
        );
      }

      // Apply category filters
      if (this.activeFilters.size > 0) {
        matched = matched.filter((p) => matchesFilters(p, this.activeFilters));
      }

      // Sort by proximity using squared distance (no sqrt needed for ordering)
      if (playerX !== null && playerY !== null) {
        matched.sort((a, b) => {
          const dax = a.worldX - playerX,
            day = a.worldY - playerY;
          const dbx = b.worldX - playerX,
            dby = b.worldY - playerY;
          return dax * dax + day * day - (dbx * dbx + dby * dby);
        });
      }

      // Performance fix: Limit the results to render in UI to a reasonable number
      matched = matched.slice(0, 50);

      // Convert to UnifiedSearchResult shape (overlayType: 'poi')
      const dynamicResults: UnifiedSearchResult[] = matched.map((p) => {
        const chunksAway =
          playerX !== null && playerY !== null
            ? Math.round(Math.sqrt((p.worldX - playerX) ** 2 + (p.worldY - playerY) ** 2) / CHUNK_SIZE)
            : null;
        const entityName = p.type === "entity" ? String((p as any).entity).toLowerCase() : "";
        let finalName = p.name ?? p.type;
        if (entityName && CREATURE_DATA[entityName]?.name) {
          finalName = CREATURE_DATA[entityName].name;
        }

        return {
          id: p.id,
          overlayType: "poi" as const,
          name: finalName,
          displayName: finalName,
          x: p.worldX,
          y: p.worldY,
          maps: ["dynamic-main-branch" as MapName],
          chunksAway,
          isDynamic: true,
          type: p.type,
          sprite: p.sprite,
          wandName: p.name,
          isTaikasauva: (p as any).isTaikasauva === true,
          cards: p.cards,
          alwaysCasts: p.always_casts,
          item: p.item,
          material: p.material,
          enemy: p.enemy,
          entity: p.entity,
          items: p.items,
          amount: p.amount,
          spell: p.spell,
          nameKey: (p as any).nameKey,
          chestVariant: (p as any).chestVariant,
          perk: (p as any).perk,
          orbIndex: (p as any).orbIndex,
          flag: (p as any).flag,
          segCode: (p as any).segCode,
          locked: (p as any).locked,
          pillarIndex: (p as any).pillarIndex,
          theme: (p as any).theme,
          reqSpec: pillarReqSpec(p as any),
          wiki: (p as any).wiki,
        } as any;
      });

      const combinedResults: any[] = [...dynamicResults];

      if (combinedResults.length === 0) {
        // A pillar transformation/item search that found nothing on this seed's
        // rendered map: the perk/item may still exist off-screen or in a
        // parallel world the map didn't draw, so point the user at Telescope
        // (seed baked into the URL, mirroring the toolbar Telescope button).
        this.searchResults.setNoResults(pillarNote);
      } else {
        // Structure searches (Buried Eye / Meditation Cube) attach an info
        // banner to their exact query while it stays in the bar.
        const notice =
          this.activeResultNotice && this.activeResultNotice.forQuery === searchText
            ? this.activeResultNotice.text
            : undefined;
        this.searchResults.setResults(combinedResults, notice);
      }
      return;
    }

    // Static map path
    // Search for map overlays (these will be translated by the overlay search function)
    const mapResults = searchOverlays(this.currentMap, searchText, this.activeFilters);

    // Combine results, prioritizing map results first
    const combinedResults: any[] = [...mapResults];

    if (this.activeFilters.has("s") || this.activeFilters.size === 0) {
      // Search for spells with translation support
      const spellResults = spells
        .filter((spell) => {
          const translatedName = gameTranslator.translateSpell(spell.name);
          const originalName = spell.name.toLowerCase();
          const translatedNameLower = translatedName.toLowerCase();
          const searchLower = searchText.toLowerCase();

          return (
            originalName.includes(searchLower) ||
            translatedNameLower.includes(searchLower) ||
            spell.id.toLowerCase().includes(searchLower)
          );
        })
        .map((spell) => {
          const translatedName = gameTranslator.translateSpell(spell.name);
          const currentLang = i18next.language;

          // Create display text with English fallback for non-English languages
          let spellDisplayName = translatedName;
          if (currentLang !== "en" && translatedName !== spell.name) {
            spellDisplayName = `${translatedName} (${spell.name})`;
          }

          return {
            type: "spell" as const,
            spell,
            displayName: translatedName,
            displayText: `${i18next.t("spell_prefix", "Spell")}: ${spellDisplayName} (${i18next.t("tiers_prefix", "Tiers")}: ${Object.keys(spell.spawnProbabilities).join(", ")})`,
          };
        });

      combinedResults.push(...spellResults);
    }

    if (combinedResults.length === 0) {
      this.searchResults.setNoResults();
    } else {
      this.searchResults.setResults(combinedResults);
    }
  }

  static create({ currentMap, form, initialFilters }: UnifiedSearchCreateOptions) {
    // Use the existing search input from HTML instead of creating a new one
    const searchInput = document.getElementById("unified-search-input") as HTMLInputElement;
    if (!searchInput) {
      throw new Error("Search input element not found. Make sure #unified-search-input exists in the HTML.");
    }

    // Create an absolutely-positioned overlay container for search results
    let searchResultsOverlay = document.getElementById("unifiedSearchResultsOverlay");
    if (!searchResultsOverlay) {
      searchResultsOverlay = document.createElement("div");
      searchResultsOverlay.id = "unifiedSearchResultsOverlay";
      document.body.appendChild(searchResultsOverlay);
    } else {
      searchResultsOverlay.replaceChildren();
    }
    // Type assertion to satisfy linter
    const overlayDiv = searchResultsOverlay as HTMLDivElement;

    const filterBox = document.createElement("div");
    filterBox.id = "unifiedSearchFilterBox";

    const isDynamicMap = currentMap === "dynamic-main-branch";
    const filters: Array<{
      type: string;
      iconSrc?: string;
      atlasKey?: string;
    }> = isDynamicMap
      ? [
          { type: "w", atlasKey: "wand:handgun" },
          { type: "s", atlasKey: "spell:mana" },
          { type: "i", atlasKey: "item:wandstone" },
          { type: "c", atlasKey: "item:chest_random_super" },
          { type: "hm", iconSrc: "assets/icons/spatial_awareness/spatial_awareness_holy_mountain.png" },
          { type: "p", atlasKey: "item:potion:acid" },
          { type: "h", atlasKey: "item:heart_extrahp" },
          { type: "pk", atlasKey: "item:perks/critical_hit" },
          { type: "b", iconSrc: "assets/icons/overlay-toggles/icon-bosses.webp" },
          { type: "e", atlasKey: "spell:exploding_deer" },
          { type: "or", iconSrc: "assets/icons/overlay-toggles/icon-orbs.webp" },
          { type: "pi", atlasKey: "pillar:pillar_part_secretall" },
        ]
      : [
          { type: "s", iconSrc: "assets/icons/spells/light_bullet.png" },
          { type: "st", iconSrc: "assets/icons/overlay-toggles/icon-structures.svg" },
          { type: "b", iconSrc: "assets/icons/overlay-toggles/icon-bosses.webp" },
          { type: "i", iconSrc: "assets/icons/overlay-toggles/icon-items.webp" },
          { type: "or", iconSrc: "assets/icons/overlay-toggles/icon-orbs.webp" },
          { type: "sa", iconSrc: "assets/icons/overlay-toggles/icon-spatial-awareness.webp" },
          { type: "msg", iconSrc: "assets/icons/overlay-toggles/icon-hidden-messages.webp" },
        ];

    const FILTER_LABELS: Record<string, string> = {
      w: i18next.t("filterLabels.wands", "Wands"),
      s: i18next.t("filterLabels.spells", "Spells"),
      i: i18next.t("filterLabels.items", "Items"),
      c: i18next.t("filterLabels.chests", "Chests"),
      hm: i18next.t("filterLabels.holyMountains", "Holy Mountains"),
      p: i18next.t("filterLabels.potions", "Potions & Flasks"),
      h: i18next.t("filterLabels.hearts", "Hearts & Heals"),
      pk: i18next.t("filterLabels.perks", "Perks"),
      b: i18next.t("filterLabels.bosses", "Bosses"),
      e: i18next.t("filterLabels.creatures", "Enemies"),
      st: i18next.t("filterLabels.structures", "Structures"),
      or: i18next.t("filterLabels.orbs", "Orbs"),
      pi: i18next.t("filterLabels.pillars", "Achievement Pillars"),
      sa: i18next.t("filterLabels.spatialAwareness", "Spatial Awareness"),
      msg: i18next.t("filterLabels.hiddenMessages", "Hidden Messages"),
    };

    const FILTER_DESCRIPTIONS: Record<string, string> = {
      w: i18next.t("searchFilters.wands", "Filter results to show only wands"),
      s: i18next.t("searchFilters.spells", "Filter results to show only spells"),
      i: i18next.t("searchFilters.items", "Filter results to show only items"),
      c: i18next.t("searchFilters.chests", "Filter results to show only chests"),
      hm: i18next.t("searchFilters.holyMountains", "Filter results to show only Holy Mountain shops"),
      p: i18next.t("searchFilters.potions", "Filter results to show only potions"),
      h: i18next.t("searchFilters.hearts", "Filter results to show only hearts"),
      pk: i18next.t("searchFilters.perks", "Filter results to show only perks"),
      b: i18next.t("searchFilters.bosses", "Filter results to show only bosses"),
      e: i18next.t("searchFilters.creatures", "Filter results to show only creatures"),
      st: i18next.t("searchFilters.structures", "Filter results to show only structures"),
      or: i18next.t("searchFilters.orbs", "Filter results to show only orbs"),
      pi: i18next.t("searchFilters.pillars", "Filter results to show only Achievement Pillar segments"),
      sa: i18next.t("searchFilters.spatialAwareness", "Filter results to show only spatial awareness points"),
      msg: i18next.t("searchFilters.hiddenMessages", "Filter results to show only hidden messages"),
    };

    for (const filter of filters) {
      const filterLabel = document.createElement("label");
      filterLabel.tabIndex = 0;
      const labelText = FILTER_LABELS[filter.type] || filter.type;
      // Use Bootstrap popover instead of plain title
      filterLabel.dataset.bsToggle = "popover";
      filterLabel.dataset.bsPlacement = "bottom";
      filterLabel.dataset.bsTrigger = "hover";
      filterLabel.dataset.bsHtml = "true";
      filterLabel.dataset.bsTitle = labelText;
      filterLabel.dataset.bsContent = FILTER_DESCRIPTIONS[filter.type] || labelText;
      filterLabel.dataset.filterType = filter.type;
      const filterCheckbox = document.createElement("input");
      filterCheckbox.type = "checkbox";
      filterCheckbox.value = filter.type;
      filterCheckbox.dataset.filter = "true";
      filterLabel.appendChild(filterCheckbox);
      const filterIcon = document.createElement("img");
      if (filter.atlasKey) {
        // Extract a single sprite from the spritesheet by atlas key
        const key = filter.atlasKey;
        import("../telescope/poi-spatial-index").then((mod) => {
          mod.loadSpritesheetAndAtlas().then(({ atlas, spritesheet }) => {
            const entry = atlas[key];
            if (!entry) return;
            const frame = mod.FIRST_FRAME_SIZE[key];
            const srcW = frame ? frame.w : entry.w;
            const srcH = frame ? frame.h : entry.h;
            const canvas = document.createElement("canvas");
            canvas.width = srcW;
            canvas.height = srcH;
            const ctx = canvas.getContext("2d")!;
            ctx.imageSmoothingEnabled = false;
            ctx.drawImage(spritesheet, entry.x, entry.y, srcW, srcH, 0, 0, srcW, srcH);
            canvas.toBlob((blob) => {
              if (blob) filterIcon.src = URL.createObjectURL(blob);
            }, "image/png");
          });
        });
      } else {
        filterIcon.src = filter.iconSrc!;
      }
      filterIcon.alt = "";
      filterIcon.classList.add("pixelated-image");
      if (filter.type === "w") filterIcon.classList.add("filter-wand");
      filterIcon.draggable = false;
      filterLabel.appendChild(filterIcon);
      filterBox.appendChild(filterLabel);
    }

    if (isDynamicMap) appendAlchemyStubs(filterBox);
    // Note: `this` in this static factory is the class itself, not an instance.
    // The stub is appended without a search-ref here; the instance's constructor
    // calls rebuildFilters(), which re-creates the stub with `this` bound.
    if (isDynamicMap) appendHighValueStub(filterBox);

    overlayDiv.appendChild(filterBox);

    // Initialize Bootstrap popovers on all filter labels
    // @ts-ignore
    filterBox.querySelectorAll('[data-bs-toggle="popover"]').forEach((el: HTMLElement) => new bootstrap.Popover(el));

    const searchResultsUL = document.createElement("ul");
    searchResultsUL.id = "unifiedSearchResults";
    overlayDiv.appendChild(searchResultsUL);

    // Target width for the overlay — wide enough to keep every filter
    // (including AP/LC) on one line. Clamped to avoid overflowing the
    // viewport on narrow screens.

    // Position overlay below the input. Width is locked to the natural
    // (un-wrapped) width of the filter row + a small padding so all filters
    // stay on one line and the panel never resizes when results change.
    function positionOverlay() {
      const rect = searchInput.getBoundingClientRect();
      const filterBox = document.getElementById("unifiedSearchFilterBox");
      overlayDiv.style.left = `${rect.left + window.scrollX}px`;
      overlayDiv.style.top = `${rect.bottom + window.scrollY}px`;
      let desired = rect.width;
      if (filterBox && filterBox.children.length > 0) {
        // Compute the natural width arithmetically from the filter box's
        // fixed-size children. Measuring via scrollWidth fails when the
        // overlay is display:none (focus → positionOverlay → display=block)
        // and over-reports when the results UL has wide content.
        const cs = getComputedStyle(filterBox);
        const gap = parseFloat(cs.columnGap) || parseFloat(cs.gap) || 0;
        const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
        const borderX = (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.borderRightWidth) || 0);
        let buttonsTotal = 0;
        let n = 0;
        for (const child of Array.from(filterBox.children)) {
          if (!(child instanceof HTMLElement)) continue;
          if (getComputedStyle(child).display === "none") continue;
          const ccs = getComputedStyle(child);
          const w = parseFloat(ccs.width) || child.offsetWidth || 32;
          const ml = parseFloat(ccs.marginLeft) || 0;
          const mr = parseFloat(ccs.marginRight) || 0;
          buttonsTotal += w + ml + mr;
          n++;
        }
        const natural = buttonsTotal + Math.max(0, n - 1) * gap + padX + borderX;
        // +4px safety margin so subpixel rounding doesn't wrap the last button.
        desired = Math.max(rect.width, Math.ceil(natural) + 4);
      }
      const cap = Math.max(0, window.innerWidth - rect.left - 8);
      const fixed = Math.min(desired, cap);
      overlayDiv.style.width = `${fixed}px`;
      overlayDiv.style.minWidth = `${fixed}px`;
      overlayDiv.style.maxWidth = `${fixed}px`;
    }

    let isOverlayVisible = false;

    searchInput.addEventListener("focus", () => {
      positionOverlay();
      overlayDiv.style.display = "block";
      isOverlayVisible = true;
      searchResults.resetScroll();
    });

    searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        overlayDiv.style.display = "none";
        isOverlayVisible = false;
        searchInput.blur();
      }
    });

    const hideOverlay = () => {
      setTimeout(() => {
        if (!overlayDiv.matches(":focus-within") && document.activeElement !== searchInput) {
          overlayDiv.style.display = "none";
          isOverlayVisible = false;
        }
      }, 200);
    };

    searchInput.addEventListener("blur", hideOverlay);
    overlayDiv.addEventListener("blur", hideOverlay);

    // Close overlay when clicking outside
    // Use capture phase to intercept pointerdown before OpenSeadragon stops propagation
    document.addEventListener(
      "pointerdown",
      (e) => {
        if (isOverlayVisible && !overlayDiv.contains(e.target as Node) && e.target !== searchInput) {
          overlayDiv.style.display = "none";
          isOverlayVisible = false;
          searchInput.blur();
        }
      },
      true,
    );

    // Close overlay when language changes
    i18next.on("languageChanged", () => {
      overlayDiv.style.display = "none";
      isOverlayVisible = false;
      searchInput.blur();
    });

    // Close overlay when clicking outside, use capture to bypass OpenSeadragon swallowing pointer events
    document.addEventListener(
      "pointerdown",
      (e) => {
        if (isOverlayVisible && !overlayDiv.contains(e.target as Node) && e.target !== searchInput) {
          overlayDiv.style.display = "none";
          isOverlayVisible = false;
          searchInput.blur();
        }
      },
      true,
    );

    // Close overlay when language changes
    i18next.on("languageChanged", () => {
      overlayDiv.style.display = "none";
      isOverlayVisible = false;
      searchInput.blur();
    });

    window.addEventListener("resize", () => {
      if (isOverlayVisible) positionOverlay();
    });
    window.addEventListener(
      "scroll",
      () => {
        if (isOverlayVisible) positionOverlay();
      },
      true,
    );

    const searchResults = new UnifiedSearchResults(searchResultsUL);

    // Show overlay when results are updated
    const origSetResults = searchResults.setResults.bind(searchResults);
    searchResults.setResults = (...args) => {
      origSetResults(...args);
      if (args[0].length > 0 && (document.activeElement === searchInput || (instance as any).explicitShowRequested)) {
        positionOverlay();
        overlayDiv.style.display = "block";
        isOverlayVisible = true;
        (instance as any).explicitShowRequested = false; // consume it
      }
    };

    // Show overlay for "Nothing found" state too
    const origSetNoResults = searchResults.setNoResults.bind(searchResults);
    searchResults.setNoResults = (...args) => {
      origSetNoResults(...args);
      if (document.activeElement === searchInput || (instance as any).explicitShowRequested) {
        positionOverlay();
        overlayDiv.style.display = "block";
        isOverlayVisible = true;
        (instance as any).explicitShowRequested = false;
      }
    };

    const instance = new UnifiedSearch({
      currentMap,
      form,
      searchInput,
      searchResults,
      initialFilters,
    });

    // allow programmatically opening the overlay without focusing
    (instance as any).showOverlay = () => {
      (instance as any).explicitShowRequested = true;
      if (searchInput.value.length > 0) {
        instance.triggerSearch(searchInput.value);
      }
    };
    instance.bindFilterEvents();
    return instance;
  }
}
