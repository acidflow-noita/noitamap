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
]);
export type UnifiedSearchCreateOptions = {
  currentMap: MapName;
  form: HTMLFormElement;
};

type UnifiedSearchConstructOptions = {
  currentMap: MapName;
  form: HTMLFormElement;
  searchInput: HTMLInputElement;
  searchResults: UnifiedSearchResults;
};

export interface UnifiedSearch {
  on(event: "selected", listener: (target: TargetOfInterest | { type: "spell"; spell: any }) => void): this;
}

// FlexSearch Document factory — FlexSearch is loaded as a global via script tag
type DocumentFactory = (options: any) => any;

export class UnifiedSearch extends EventEmitter2 {
  private lastSearchText: string = "";
  private lastSearchFilters: Set<string> = new Set();
  private lastViewportKey: string = "";
  private isInteracting: boolean = false;

  private form: HTMLFormElement;
  private searchInput: HTMLInputElement;
  private activeFilters: Set<string> = new Set();
  private searchResults: UnifiedSearchResults;
  private dynamicPOIs: DynamicPOI[] = [];
  private dynamicIndex: any = null; // FlexSearch.Document index for dynamic POIs
  private dynamicPOIMap: Map<string, DynamicPOI> = new Map(); // fast id→POI lookup
  private indexingState: 'idle' | 'indexing' | 'ready' = 'idle';

  public currentMap: MapName;

  private constructor({ currentMap, form, searchInput, searchResults }: UnifiedSearchConstructOptions) {
    super();

    this.currentMap = currentMap;
    this.form = form;
    this.searchInput = searchInput;
    this.searchResults = searchResults;

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
      debounced();
    });

    this.searchResults.on("blur", () => {
      this.searchInput.focus();
    });

    for (const filterCheckbox of document.querySelectorAll<HTMLInputElement>(
      '#unifiedSearchFilterBox input[type="checkbox"][data-filter]',
    )) {
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

  setSearchValueWithoutTriggering(value: string) {
    this.searchInput.value = value;
    this.lastSearchText = value;
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
  setIndexingState(state: 'idle' | 'indexing' | 'ready'): void {
    const prev = this.indexingState;
    this.indexingState = state;
    // When transitioning to 'ready', force a search refresh so results appear
    if (state === 'ready' && prev === 'indexing') {
      this.lastSearchText = "__force__";
      this.lastViewportKey = "";
      this.updateSearchResults();
    }
    // When transitioning to 'indexing', update display immediately
    if (state === 'indexing') {
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
      if (p.type === "entity" && (p as any).entity) {
        const entityName = String((p as any).entity);
        parts.push(entityName);
        const translated = gameTranslator.translateItem(`animal_${entityName.toLowerCase()}`);
        if (translated !== `animal_${entityName.toLowerCase()}`) {
          parts.push(translated);
        }
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
    if (this.searchInput.value.trim() !== "") {
      // Force update by clearing lastSearchText and calling updateSearchResults
      this.lastSearchText = "";
      this.updateSearchResults();
    }
  }

  /** Force a full re-render of search results (e.g. when spoiler-free toggles). */
  forceRefresh() {
    this.lastSearchText = "__force__";
    this.lastViewportKey = "";
    this.updateSearchResults();
  }

  private updateSearchResults() {
    const searchText = this.searchInput.value;
    // Also check viewport position for dynamic map proximity sorting
    const urlParams = new URLSearchParams(window.location.search);
    const vpKey = `${urlParams.get("x") ?? ""},${urlParams.get("y") ?? ""}`;
    if (
      this.lastSearchText === searchText &&
      this.lastSearchFilters === this.activeFilters &&
      this.lastViewportKey === vpKey
    )
      return;
    this.lastSearchText = searchText;
    this.lastSearchFilters = new Set(this.activeFilters);
    this.lastViewportKey = vpKey;

    const isDynamic = this.currentMap === "dynamic-main-branch";

    // Read player position from URL for proximity sorting (needed for both empty & non-empty search on dynamic map)
    const playerX = parseFloat(urlParams.get("x") ?? "") || null;
    const playerY = parseFloat(urlParams.get("y") ?? "") || null;

    if (searchText === "") {
      resetBiomeOverlays();
      if (isDynamic && this.indexingState === 'indexing') {
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

      if (isDynamic && this.indexingState === 'indexing') {
        this.searchResults.setIndexingPlaceholder();
        return;
      }

    if (isDynamic) {
      // Dynamic map: search dynamic POIs via FlexSearch index
      const CHUNK_SIZE = 512;

      let matched: DynamicPOI[] = [];

      if (this.dynamicIndex) {
        // Query the FlexSearch index for matching POI ids
        const found = this.dynamicIndex.search(searchText).flatMap((v: any) => v.result);
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
        matched = matched.filter((p) => {
          if (this.activeFilters.has("wands") && p.type === "wand") return true;
          if (this.activeFilters.has("items") && p.type === "item") return true;
          if (this.activeFilters.has("chests") && CONTAINER_TYPES.has(p.type)) return true;
          if (
            this.activeFilters.has("potions") &&
            p.type === "item" &&
            (p.item === "potion" ||
              p.item === "potion_normal" ||
              p.item === "pouch" ||
              p.item === "powder_stash" ||
              p.item === "powder_stash_pouch")
          )
            return true;
          if (
            this.activeFilters.has("hearts") &&
            p.type === "item" &&
            (p.item === "heart" || p.item === "heart_bigger" || p.item === "full_heal")
          )
            return true;
          if (
            this.activeFilters.has("bosses") &&
            (p.type === "triangle_boss" ||
              p.type === "alchemist_boss" ||
              p.type === "pyramid_boss" ||
              p.type === "dragon")
          )
            return true;
          if (this.activeFilters.has("enemies") && p.type === "entity") return true;
          return false;
        });
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

      // Convert to UnifiedSearchResult shape (overlayType: 'poi')
      const dynamicResults: UnifiedSearchResult[] = matched.map((p) => {
        const chunksAway =
          playerX !== null && playerY !== null
            ? Math.round(Math.sqrt((p.worldX - playerX) ** 2 + (p.worldY - playerY) ** 2) / CHUNK_SIZE)
            : null;
        return {
          overlayType: "poi" as const,
          name: p.name ?? p.type,
          displayName: p.name ?? p.type,
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

      this.searchResults.setResults(combinedResults);
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

    this.searchResults.setResults(combinedResults);
  }

  static create({ currentMap, form }: UnifiedSearchCreateOptions) {
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
          { type: "wands", atlasKey: "wand:custom/good_01" },
          { type: "spells", atlasKey: "spell:mana" },
          { type: "items", atlasKey: "item:wandstone" },
          { type: "chests", atlasKey: "item:chest_random_super" },
          { type: "potions", atlasKey: "item:potion:acid" },
          { type: "hearts", atlasKey: "item:heart_extrahp" },
          { type: "bosses", iconSrc: "assets/icons/overlay-toggles/icon-bosses.webp" },
          { type: "enemies", atlasKey: "spell:exploding_deer" },
        ]
      : [
          { type: "spells", iconSrc: "assets/icons/spells/light_bullet.png" },
          { type: "structures", iconSrc: "assets/icons/overlay-toggles/icon-structures.svg" },
          { type: "bosses", iconSrc: "assets/icons/overlay-toggles/icon-bosses.webp" },
          { type: "items", iconSrc: "assets/icons/overlay-toggles/icon-items.webp" },
          { type: "orbs", iconSrc: "assets/icons/overlay-toggles/icon-orbs.webp" },
          { type: "spatialAwareness", iconSrc: "assets/icons/overlay-toggles/icon-spatial-awareness.webp" },
          { type: "hiddenMessages", iconSrc: "assets/icons/overlay-toggles/icon-hidden-messages.webp" },
        ];

    for (const filter of filters) {
      const filterLabel = document.createElement("label");
      filterLabel.tabIndex = 0;
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
      filterIcon.draggable = false;
      if (filter.type === "wands") {
        filterIcon.style.transform = "rotate(90deg)";
      }
      filterLabel.appendChild(filterIcon);
      filterBox.appendChild(filterLabel);
    }

    overlayDiv.appendChild(filterBox);

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
      if (args[0].length > 0 && document.activeElement === searchInput) {
        positionOverlay();
        overlayDiv.style.display = "block";
        isOverlayVisible = true;
      }
    };

    return new UnifiedSearch({
      currentMap,
      form,
      searchInput,
      searchResults,
    });
  }
}
