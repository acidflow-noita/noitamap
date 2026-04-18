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
import { authService } from "../auth/auth-service";
import { AuthUI } from "../auth/auth-ui";

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
  "friend",
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
    ul.innerHTML = "";
    overlay.style.display = "none";
    return;
  }
  ul.innerHTML = "";
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
    overlay.style.width = `${rect.width}px`;
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
      label.dataset.bsContent = i18next.t(
        locked ? proOnlyKey : contentKey,
        locked
          ? `${defaultTitle} recipe finder. Pro feature — sign in with Patreon to unlock.`
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
  ensureAlchemyStubStyles();
}

function ensureAlchemyStubStyles(): void {
  if (document.getElementById("alchemy-stub-style")) return;
  const s = document.createElement("style");
  s.id = "alchemy-stub-style";
  s.textContent = `
#unifiedSearchFilterBox .alchemy-filter-btn {
  position: relative;
  width: 32px; height: 32px;
  display: inline-flex; align-items: center; justify-content: center;
  border-radius: 4px;
  background: linear-gradient(180deg, #3a2d0d 0%, #241a05 100%);
  border: 1px solid #b08a2a;
  box-shadow: 0 0 0 1px rgba(255, 211, 110, 0.08) inset, 0 0 6px rgba(176, 138, 42, 0.25);
  color: #ffd36e;
  cursor: pointer; user-select: none;
  transition: box-shadow 0.15s, transform 0.15s, background 0.15s;
}
#unifiedSearchFilterBox .alchemy-filter-btn .alchemy-filter-icon {
  width: 22px; height: 22px;
}
#unifiedSearchFilterBox .alchemy-filter-btn .alchemy-filter-badge {
  position: absolute; bottom: -2px; right: -2px;
  font: bold 9px/1 monospace; color: #ffd36e;
  background: #241a05; border: 1px solid #b08a2a;
  border-radius: 3px; padding: 1px 3px;
  pointer-events: none;
}
#unifiedSearchFilterBox .alchemy-filter-btn:hover {
  background: linear-gradient(180deg, #5a4418 0%, #362605 100%);
  box-shadow: 0 0 0 1px rgba(255, 211, 110, 0.2) inset, 0 0 10px rgba(255, 211, 110, 0.35);
  transform: translateY(-1px);
}
#unifiedSearchFilterBox .alchemy-filter-btn.active {
  background: linear-gradient(180deg, #8a6a20 0%, #5a4418 100%);
  border-color: #ffd36e;
  box-shadow: 0 0 0 2px rgba(255, 211, 110, 0.45), 0 0 12px rgba(255, 211, 110, 0.5);
}
#unifiedSearchFilterBox .alchemy-filter-btn--locked {
  opacity: 0.55;
  filter: grayscale(0.4);
}
#unifiedSearchFilterBox .alchemy-filter-btn--locked:hover {
  opacity: 0.75;
  transform: none;
}

/* Shared pro-accent treatment for Pro-gated buttons (Get Pro, Drawing toggle). */
.pro-accent.icon-button,
.pro-accent.btn-outline-light,
#auth-container .pro-accent {
  border-color: #b08a2a !important;
  color: #ffd36e !important;
  background: linear-gradient(180deg, rgba(90,68,24,0.35) 0%, rgba(36,26,5,0.35) 100%) !important;
  box-shadow: 0 0 0 1px rgba(255, 211, 110, 0.1) inset, 0 0 6px rgba(176, 138, 42, 0.25) !important;
  transition: box-shadow 0.15s, background 0.15s !important;
}
.pro-accent.icon-button:hover,
.pro-accent.btn-outline-light:hover,
#auth-container .pro-accent:hover {
  background: linear-gradient(180deg, rgba(138,106,32,0.55) 0%, rgba(90,68,24,0.45) 100%) !important;
  border-color: #ffd36e !important;
  color: #ffd36e !important;
  box-shadow: 0 0 0 1px rgba(255, 211, 110, 0.25) inset, 0 0 10px rgba(255, 211, 110, 0.35) !important;
}
.pro-accent .pro-icon { filter: drop-shadow(0 0 3px rgba(255, 211, 110, 0.5)); }
  `;
  document.head.appendChild(s);
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
]);

/** Check if a POI matches any of the active filters. */
function matchesFilters(p: DynamicPOI, activeFilters: Set<string>): boolean {
  if (activeFilters.size === 0) return true;
  if (activeFilters.has("w") && p.type === "wand") return true;
  if (activeFilters.has("s") && p.type === "item" && p.item === "spell") return true;
  if (activeFilters.has("i") && p.type === "item") return true;
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

  public get currentMap(): MapName { return this._currentMap; }
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
    filterBox.innerHTML = "";

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
          { type: "b", iconSrc: "assets/icons/overlay-toggles/icon-bosses.webp" },
          { type: "e", atlasKey: "spell:exploding_deer" },
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
      b: i18next.t("filterLabels.bosses", "Bosses"),
      e: i18next.t("filterLabels.creatures", "Enemies"),
      st: i18next.t("filterLabels.structures", "Structures"),
      or: i18next.t("filterLabels.orbs", "Orbs"),
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
      b: i18next.t("searchFilters.bosses", "Filter results to show only bosses"),
      e: i18next.t("searchFilters.creatures", "Filter results to show only creatures"),
      st: i18next.t("searchFilters.structures", "Filter results to show only structures"),
      or: i18next.t("searchFilters.orbs", "Filter results to show only orbs"),
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
      b: i18next.t("filterLabels.bosses", "Bosses"),
      e: i18next.t("filterLabels.creatures", "Enemies"),
      st: i18next.t("filterLabels.structures", "Structures"),
      or: i18next.t("filterLabels.orbs", "Orbs"),
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
      b: i18next.t("searchFilters.bosses", "Filter results to show only bosses"),
      e: i18next.t("searchFilters.creatures", "Filter results to show only creatures"),
      st: i18next.t("searchFilters.structures", "Filter results to show only structures"),
      or: i18next.t("searchFilters.orbs", "Filter results to show only orbs"),
      sa: i18next.t("searchFilters.spatialAwareness", "Filter results to show only spatial awareness points"),
      msg: i18next.t("searchFilters.hiddenMessages", "Filter results to show only hidden messages"),
    };

    for (const label of document.querySelectorAll<HTMLLabelElement>('#unifiedSearchFilterBox label[data-filter-type]')) {
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
    this.updateSearchResults();
  }

  /** Replace the dynamic POI index (called by the generation pipeline). */
  setDynamicPOIs(pois: DynamicPOI[]): void {
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
        try { cb(state); } catch { /* ignore listener errors */ }
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

      // Add entity name and translated name for creature search
      let entityNameForSearch = "";
      if (p.type === "entity" && (p as any).entity) {
        entityNameForSearch = String((p as any).entity).toLowerCase();
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

      // Add translated material name for potions/pouches
      if (p.material) {
        parts.push(gameTranslator.translateMaterial(p.material));
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
          if (ci.material) {
            parts.push(ci.material);
            parts.push(gameTranslator.translateMaterial(ci.material));
          }
          if (ci.enemy) parts.push(ci.enemy);
          if (ci.spell) parts.push(ci.spell);
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

  private updateSearchResults() {
    if (this.alchemyActive) return;
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
    const playerX = parseFloat(urlParams.get("x") ?? "") || null;
    const playerY = parseFloat(urlParams.get("y") ?? "") || null;

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
            cards: p.cards,
            alwaysCasts: p.always_casts,
            item: p.item,
            material: p.material,
            enemy: p.enemy,
            entity: p.entity,
            items: p.items,
            amount: p.amount,
            spell: p.spell,
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

      if (this.dynamicIndex) {
        // Query the FlexSearch index for matching POI ids with a high limit (default is 100)
        const found = this.dynamicIndex.search(searchText, 10000).flatMap((v: any) => v.result);
        const ids = new Set<string>(found);
        matched = [...ids].map((id) => this.dynamicPOIMap.get(id)).filter(Boolean) as DynamicPOI[];
      } else {
        // Fallback: brute-force filter if index not built yet
        const searchLower = searchText.toLowerCase();
        matched = this.dynamicPOIs.filter(
          (p) =>
            (p.name ?? p.type ?? "").toLowerCase().includes(searchLower) ||
            (p.item ?? "").toLowerCase().includes(searchLower) ||
            p.type.toLowerCase().includes(searchLower),
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
          cards: p.cards,
          alwaysCasts: p.always_casts,
          item: p.item,
          material: p.material,
          enemy: p.enemy,
          entity: p.entity,
          items: p.items,
          amount: p.amount,
          spell: p.spell,
        } as any;
      });

      const combinedResults: any[] = [...dynamicResults];

      if (combinedResults.length === 0) {
        this.searchResults.setNoResults();
      } else {
        this.searchResults.setResults(combinedResults);
      }
      return;
    }

    // Static map path
    // Search for map overlays (these will be translated by the overlay search function)
    const mapResults = searchOverlays(this.currentMap, searchText, this.activeFilters);

    // Combine results, prioritizing map results first
    const combinedResults: any[] = [...mapResults];

    if (this.activeFilters.has("spells") || this.activeFilters.size === 0) {
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
      searchResultsOverlay.innerHTML = "";
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
          { type: "b", iconSrc: "assets/icons/overlay-toggles/icon-bosses.webp" },
          { type: "e", atlasKey: "spell:exploding_deer" },
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
      b: i18next.t("filterLabels.bosses", "Bosses"),
      e: i18next.t("filterLabels.creatures", "Enemies"),
      st: i18next.t("filterLabels.structures", "Structures"),
      or: i18next.t("filterLabels.orbs", "Orbs"),
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
      b: i18next.t("searchFilters.bosses", "Filter results to show only bosses"),
      e: i18next.t("searchFilters.creatures", "Filter results to show only creatures"),
      st: i18next.t("searchFilters.structures", "Filter results to show only structures"),
      or: i18next.t("searchFilters.orbs", "Filter results to show only orbs"),
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

    overlayDiv.appendChild(filterBox);

    // Initialize Bootstrap popovers on all filter labels
    // @ts-ignore
    filterBox.querySelectorAll('[data-bs-toggle="popover"]').forEach((el: HTMLElement) => new bootstrap.Popover(el));

    const searchResultsUL = document.createElement("ul");
    searchResultsUL.id = "unifiedSearchResults";
    overlayDiv.appendChild(searchResultsUL);

    // Position overlay below the input
    function positionOverlay() {
      const rect = searchInput.getBoundingClientRect();
      overlayDiv.style.left = `${rect.left + window.scrollX}px`;
      overlayDiv.style.top = `${rect.bottom + window.scrollY}px`;
      overlayDiv.style.width = `${rect.width}px`;
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
    document.addEventListener("pointerdown", (e) => {
      if (isOverlayVisible && !overlayDiv.contains(e.target as Node) && e.target !== searchInput) {
        overlayDiv.style.display = "none";
        isOverlayVisible = false;
        searchInput.blur();
      }
    }, true);

    // Close overlay when language changes
    i18next.on("languageChanged", () => {
      overlayDiv.style.display = "none";
      isOverlayVisible = false;
      searchInput.blur();
    });

    // Close overlay when clicking outside, use capture to bypass OpenSeadragon swallowing pointer events
    document.addEventListener("pointerdown", (e) => {
      if (isOverlayVisible && !overlayDiv.contains(e.target as Node) && e.target !== searchInput) {
        overlayDiv.style.display = "none";
        isOverlayVisible = false;
        searchInput.blur();
      }
    }, true);

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
    searchResults.setNoResults = () => {
      origSetNoResults();
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
