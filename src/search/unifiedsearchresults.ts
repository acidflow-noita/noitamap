import { TargetOfInterest } from "../data_sources/overlays";
import { Spell } from "../data_sources/overlays";
import { EventEmitter2 } from "eventemitter2";
import i18next from "../i18n";
import { getSpellAvailability } from "../util";
import { getPOISpriteFirstFrame, getTaikasauvaIcon } from "../telescope/telescope-osd-bridge";
import { perkNameKey } from "../telescope/perk-i18n";
import { canonicalEntityId } from "../telescope/entity-canonical";
import spells from "../data/spells.json";
import { gameTranslator } from "../game-translations/translator";
import { isSpoilerFree } from "../spoiler-free";
import { attachAlwaysCastPopover, dismissPopovers } from "../popover-util";
import { CREATURE_DATA } from "../data/creature-data";

export type UnifiedSearchResult =
  | TargetOfInterest
  | { type: "spell"; spell: Spell; displayName: string; displayText: string };

export interface UnifiedSearchResults {
  on(event: "selected", listener: (target: UnifiedSearchResult) => void): this;
  on(event: "blur", listener: () => void): this;
}

export class UnifiedSearchResults extends EventEmitter2 {
  private targetByElement = new WeakMap<Element, UnifiedSearchResult>();
  private elementByTarget = new Map<UnifiedSearchResult, HTMLElement>();
  private currentElement: Element | null = null;

  private wrapper: HTMLUListElement;
  private lastSortedOrder: string = "";
  private lastSortX: number = 0;
  private lastSortY: number = 0;

  constructor(wrapper: HTMLUListElement) {
    super();

    this.wrapper = wrapper;
    this.wrapper.replaceChildren();
    this.bindEvents();

    // Re-translate proximity hints when language changes without recreating elements
    i18next.on("languageChanged", () => {
      const proximitySpans = this.wrapper.querySelectorAll(".proximity-hint");
      proximitySpans.forEach((span) => {
        const chunksAway = parseInt((span as HTMLElement).dataset.chunksAway || "0", 10);
        span.textContent = i18next.t("search.chunksAway", "~{{count}} chunks away", { count: chunksAway });
      });
    });
  }

  /** Efficiently re-sort existing result elements by proximity to (x, y) */
  resortByProximity(playerX: number, playerY: number): void {
    const CHUNK_SIZE = 512;
    const items = Array.from(this.elementByTarget.entries());
    if (items.length === 0) return;

    // Only sort dynamic POIs that have x/y coordinates
    const sortable = items.filter(([target]) => "x" in target && (target as any).isDynamic);
    if (sortable.length === 0) return;

    // Optimization: Skip if we haven't moved much
    const distMoved = Math.hypot(playerX - this.lastSortX, playerY - this.lastSortY);
    if (distMoved < 128 && this.lastSortedOrder !== "") return;

    this.lastSortX = playerX;
    this.lastSortY = playerY;

    sortable.sort(([targetA], [targetB]) => {
      const pA = targetA as any;
      const pB = targetB as any;
      const da = Math.hypot(pA.x - playerX, pA.y - playerY);
      const db = Math.hypot(pB.x - playerX, pB.y - playerY);
      return da - db;
    });

    // Check if the order has actually changed
    const currentOrder = sortable.map(([target]) => (target as any).x + "," + (target as any).y).join("|");
    if (currentOrder === this.lastSortedOrder) return;
    this.lastSortedOrder = currentOrder;

    // Use a fragment to avoid layout thrashing
    const fragment = document.createDocumentFragment();
    for (const [target, el] of sortable) {
      fragment.appendChild(el);
      // Update the "chunks away" text if it exists
      const p = target as any;
      const chunksAway = Math.round(Math.hypot(p.x - playerX, p.y - playerY) / CHUNK_SIZE);
      const proximitySpan = el.querySelector(".proximity-hint");
      if (proximitySpan) {
        proximitySpan.textContent = i18next.t("search.chunksAway", "~{{count}} chunks away", { count: chunksAway });
      }
    }
    this.wrapper.appendChild(fragment);
  }

  private bindEvents() {
    this.wrapper.addEventListener("keyup", (ev) => {
      if (ev.altKey || ev.shiftKey || ev.ctrlKey || ev.metaKey || ev.isComposing) return;

      let handled = true;
      switch (ev.key) {
        case "Escape":
          this.blur();
          break;
        case "Enter":
          this.onSelected(ev);
          break;
        case "ArrowDown":
          this.focusNext();
          break;
        case "ArrowUp":
          this.focusPrevious();
          break;
        default:
          handled = false;
          break;
      }

      if (handled) ev.stopPropagation();
    });

    this.wrapper.addEventListener("click", (ev) => this.onSelected(ev));
  }

  private onSelected(ev: MouseEvent | KeyboardEvent) {
    if (!ev.target) return;

    const listItem = ev.target instanceof HTMLLIElement ? ev.target : (ev.target as Element).closest("li");

    if (!(listItem instanceof HTMLLIElement)) return;

    // when we've selected an element, find the data
    // we stored for that element, and emit it
    const target = this.targetByElement.get(listItem);
    if (!target) return;

    ev.stopPropagation();

    this.emit("selected", target);

    // Hide the search results overlay after selection
    const overlay = document.getElementById("unifiedSearchResultsOverlay");
    if (overlay) {
      overlay.style.display = "none";
    }
  }

  private blur() {
    this.currentElement = null;
    this.emit("blur");
  }

  private focus(target: Element | null) {
    if (!(target instanceof HTMLElement)) return;
    this.currentElement = target;
    target.focus();
  }

  focusPrevious() {
    // when we select the previous and we're already at the top, allow
    // the search input to retrieve the focus
    if (this.currentElement === this.wrapper.firstElementChild) {
      this.blur();
    } else {
      this.focus(this.currentElement?.previousElementSibling ?? null);
    }
  }

  focusNext() {
    this.focus(this.currentElement ? this.currentElement.nextElementSibling : this.wrapper.firstElementChild);
  }

  private clearResults(hide: boolean = true) {
    this.currentElement = null;
    this.elementByTarget.clear();
    this.lastSortedOrder = "";
    dismissPopovers(this.wrapper);
    this.wrapper.replaceChildren();
    this.wrapper.scrollTop = 0;
    this.elementByTarget.clear();
    this.lastSortedOrder = "";
    this.lastSortX = 0;
    this.lastSortY = 0;
    // this.wrapper.style.display = hide ? 'none' : 'block';
  }

  /** Reset scroll position to top. */
  resetScroll(): void {
    this.wrapper.scrollTop = 0;
  }

  /** Return the current result objects in display order. */
  getRawResults(): UnifiedSearchResult[] {
    return Array.from(this.elementByTarget.keys());
  }

  /** Show a "search is being indexed" placeholder with skeleton loaders. */
  setIndexingPlaceholder(): void {
    this.clearResults(false);

    // Render 6 skeleton rows mimicking real search result items
    for (let i = 0; i < 6; i++) {
      const li = document.createElement("li");
      li.className = "list-group-item search-result d-flex align-items-center";
      li.style.pointerEvents = "none";

      // Skeleton icon
      const iconSkel = document.createElement("div");
      iconSkel.className = "skeleton-pulse me-2 flex-shrink-0";
      iconSkel.style.width = "32px";
      iconSkel.style.height = "32px";
      iconSkel.style.borderRadius = "4px";
      li.appendChild(iconSkel);

      // Skeleton text lines
      const textCol = document.createElement("div");
      textCol.style.flex = "1";
      textCol.style.minWidth = "0";

      const line1 = document.createElement("div");
      line1.className = "skeleton-pulse";
      line1.style.height = "12px";
      // Vary widths so it looks natural
      line1.style.width = [70, 55, 80, 60, 45, 65][i] + "%";
      line1.style.marginBottom = "6px";
      textCol.appendChild(line1);

      const line2 = document.createElement("div");
      line2.className = "skeleton-pulse";
      line2.style.height = "10px";
      line2.style.width = [40, 30, 50, 35, 25, 45][i] + "%";
      textCol.appendChild(line2);

      li.appendChild(textCol);
      this.wrapper.appendChild(li);
    }

    // "Indexing" notice at the bottom
    const notice = document.createElement("li");
    notice.className = "search-indexing-notice";
    notice.innerHTML = `<span class="spinner-border spinner-border-sm text-secondary" role="status"></span><span>Loading data…</span>`;
    this.wrapper.appendChild(notice);
  }

  /**
   * Show a "no results" placeholder when search yields nothing. When `note` is
   * given (pillar search links that found nothing on this seed's visible map),
   * append an explanatory line plus a seeded Telescope link — the target might
   * still exist off-screen / in a parallel world the map didn't render.
   */
  setNoResults(note?: { text: string; telescopeUrl: string }): void {
    this.clearResults(false);
    const li = document.createElement("li");
    li.className = "search-no-results";
    li.textContent = i18next.t("search.noResults", "Nothing found");
    this.wrapper.appendChild(li);

    if (note) {
      const noteLi = document.createElement("li");
      noteLi.className = "search-no-results-note";
      noteLi.style.cssText = "padding:0.4em 0.75em;color:#aaa;font-size:0.85em;line-height:1.4";
      noteLi.appendChild(document.createTextNode(note.text + " "));
      const a = document.createElement("a");
      a.href = note.telescopeUrl;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.style.cssText = "color:#7ab8ff;text-decoration:underline";
      a.textContent = i18next.t("search.openTelescope", "Open in Telescope");
      noteLi.appendChild(a);
      this.wrapper.appendChild(noteLi);
    }
  }

  setResults(results: UnifiedSearchResult[], notice?: string) {
    this.clearResults(results.length === 0);

    // Info banner shown WITH results (pillar structure searches where the
    // seed spawned no structure — only its destination chamber matched).
    if (notice && results.length > 0) {
      const noteLi = document.createElement("li");
      noteLi.className = "search-result-notice";
      noteLi.style.cssText = "padding:0.4em 0.75em;color:var(--warning-fg,#d9b44a);font-size:0.85em;line-height:1.4";
      noteLi.textContent = notice;
      this.wrapper.appendChild(noteLi);
    }

    for (const [idx, result] of results.entries()) {
      const listItem = document.createElement("li");
      listItem.classList.add("list-group-item", "search-result");
      listItem.tabIndex = idx;
      this.targetByElement.set(listItem, result);
      this.elementByTarget.set(result, listItem);

      if ("type" in result && result.type === "spell") {
        // Handle spell results with image
        listItem.classList.add("d-flex", "align-items-center");
        const img = document.createElement("img");
        img.classList.add("pixelated-image", "me-2", "flex-shrink-0");
        img.alt = result.spell.name;
        img.style.width = "32px";
        img.style.height = "32px";
        listItem.appendChild(img);

        // Try to use atlas for spell icon
        getPOISpriteFirstFrame({ type: "spell", item: result.spell.id }).then((url) => {
          if (url) {
            img.src = url;
          } else {
            img.src = `./assets/icons/spells/${result.spell.sprite}`;
            img.onerror = () => {
              img.src = "./assets/icons/spells/missing.png";
              img.alt = "Missing";
            };
          }
        });

        // Create content container
        const contentDiv = document.createElement("div");
        contentDiv.className = "spell-search-content";

        // Parse the displayText to extract components
        const currentLang = i18next.language;
        const spellPrefix = i18next.t("spell_prefix", "Spell");
        const tiersPrefix = i18next.t("tiers_prefix", "Tiers");
        const availabilityString = getSpellAvailability(result.spell, i18next);
        const translatedName = result.displayName;
        const tiers = Object.keys(result.spell.spawnProbabilities).join(", ");

        // Main spell line with translated name
        const mainDiv = document.createElement("div");
        mainDiv.className = "spell-main-line";
        mainDiv.textContent = `${spellPrefix}: ${translatedName}`;
        contentDiv.appendChild(mainDiv);

        // English name on second line if not in English and different
        if (currentLang !== "en" && translatedName !== result.spell.name) {
          const englishDiv = document.createElement("div");
          englishDiv.className = "spell-english-line";
          englishDiv.textContent = result.spell.name;
          englishDiv.style.fontSize = "0.85em";
          englishDiv.style.color = "#888";
          englishDiv.style.fontStyle = "italic";
          contentDiv.appendChild(englishDiv);
        }

        // Tiers and availability on third line
        const infoDiv = document.createElement("div");
        infoDiv.className = "spell-info-line";

        const tiersSpan = document.createElement("span");
        tiersSpan.className = "spell-tiers-line";
        tiersSpan.textContent = `${tiersPrefix}: ${tiers}`;
        infoDiv.appendChild(tiersSpan);

        const availabilitySpan = document.createElement("span");
        availabilitySpan.className = "spell-availability-line";
        availabilitySpan.textContent = availabilityString;
        infoDiv.appendChild(availabilitySpan);

        contentDiv.appendChild(infoDiv);

        listItem.appendChild(contentDiv);
      } else if ("overlayType" in result) {
        // Handle map overlay results with translated names
        switch (result.overlayType) {
          case "poi":
            // Use displayName if available (translated), otherwise fall back to name
            const displayName = ("displayName" in result ? (result as any).displayName : result.name) as string;
            const currentLang = i18next.language;

            // Handle Wands specifically with sprites (UNROTATED)
            if ((result as any).type === "wand" && (result as any).sprite) {
              listItem.classList.add("d-flex", "align-items-center");
              const img = document.createElement("img");
              img.classList.add("pixelated-image", "me-2", "flex-shrink-0");
              img.style.width = "32px";
              img.style.height = "32px";
              img.style.objectFit = "contain";
              const isTaikasauvaResult = (result as any).isTaikasauva === true;
              img.style.transform = "rotate(90deg)";
              getPOISpriteFirstFrame({ type: "wand", sprite: (result as any).sprite }).then((url) => {
                if (url) img.src = url;
              });
              if (isTaikasauvaResult) {
                // "Alive" wand: keep the real wand sprite (its silhouette is
                // identifying info) and add a Taikasauva ghost badge in the
                // corner to flag it as alive — like the AC badge, but bigger so
                // the ghost stays recognizable. search.css forces `flex:1` on
                // every `> div` of a d-flex row, so the wrapper MUST override
                // flex (else it stretches full-width and the badge flies off).
                img.classList.remove("me-2");
                img.style.display = "block";
                const wandWrap = document.createElement("div");
                wandWrap.className = "me-2";
                wandWrap.style.cssText = "position:relative;flex:0 0 32px;width:32px;height:32px;overflow:visible";
                wandWrap.appendChild(img);
                const ghost = document.createElement("img");
                ghost.className = "pixelated-image";
                ghost.title = "Alive wand";
                ghost.style.cssText =
                  "position:absolute;right:-4px;bottom:-4px;width:16px;height:16px;object-fit:contain;z-index:2;pointer-events:none";
                getTaikasauvaIcon().then((url) => {
                  if (url) ghost.src = url;
                });
                wandWrap.appendChild(ghost);
                listItem.appendChild(wandWrap);
              } else {
                listItem.appendChild(img);
              }
            } else if ((result as any).isDynamic && (result as any).type) {
              // Non-wand POIs: use atlas for fast image loading
              listItem.classList.add("d-flex", "align-items-center");
              const img = document.createElement("img");
              img.classList.add("pixelated-image", "me-2", "flex-shrink-0");
              img.style.width = "32px";
              img.style.height = "32px";
              img.style.objectFit = "contain";
              img.style.display = "none";
              getPOISpriteFirstFrame(result as any).then((url) => {
                if (url) {
                  img.src = url;
                } else {
                  // Fallback for POIs or entities missing a sprite
                  img.src = "./assets/icons/no_image_available.png";
                  img.style.opacity = "0.5";
                }
                img.style.display = "";
              });
              listItem.appendChild(img);
            }

            // Create content container for multi-line display
            const contentDiv = document.createElement("div");
            contentDiv.className = "overlay-search-content";

            // Main name line with translated name
            const nameDiv = document.createElement("div");
            nameDiv.className = "overlay-main-line";

            // For dynamic POIs, show "~X chunks away" proximity hint
            if ((result as any).isDynamic) {
              if ((result as any).type === "wand") {
                if (isSpoilerFree()) {
                  nameDiv.textContent = "Wand";
                } else {
                  const wandName = (result as any).wandName || (result as any).name || "Magic";
                  if ((result as any).isTaikasauva === true) {
                    // "Alive" wand: "Taikasauva <Adj> wand" (adj from adapter override).
                    const tk = gameTranslator.translateItem("animal_wand_ghost");
                    const baseName = tk !== "animal_wand_ghost" ? tk : "Taikasauva";
                    const adj = wandName && wandName !== "Taikasauva" ? wandName : "";
                    if (adj) {
                      nameDiv.textContent = /\bwand\b\s*$/i.test(adj) ? `${baseName} ${adj}` : `${baseName} ${adj} wand`;
                    } else {
                      nameDiv.textContent = baseName;
                    }
                    const sub = document.createElement("div");
                    sub.style.cssText = "color:#9a9;font-size:0.82em;font-style:italic";
                    sub.textContent = '"Alive wand"';
                    nameDiv.appendChild(sub);
                  } else {
                    nameDiv.textContent = /\bwand\b\s*$/i.test(wandName) ? wandName : `${wandName} wand`;
                  }
                }
              } else {
                if (isSpoilerFree()) {
                  const r = result as any;
                  if (r.type === "spell" || (r.type === "item" && r.item === "spell")) {
                    nameDiv.textContent = "Spell";
                  } else {
                    nameDiv.textContent = "Something";
                  }
                } else {
                // Non-wand dynamic POI: show meaningful name
                const r = result as any;
                let label = displayName;
                if (r.type === "item") {
                  const itemName = r.item || "item";
                  if ((itemName === "potion" || itemName === "potion_normal" || itemName === "pouch") && r.material) {
                    const matName = gameTranslator.translateMaterial(r.material);
                    label = `${matName} ${itemName === "pouch" ? "pouch" : "potion"}`;
                  } else if (itemName === "spell" && r.spell) {
                    const spell = spells.find((s: any) => s.id === r.spell || s.id === String(r.spell).toUpperCase());
                    label = gameTranslator.translateSpell(spell ? spell.name : r.spell);
                  } else if (itemName === "essence" && r.material) {
                    const key = `item_essence_${r.material}`;
                    const translated = gameTranslator.translateItem(key);
                    label = translated !== key ? translated : (r.name || "Essence");
                  } else if (itemName === "perk" && r.perk) {
                    const key = perkNameKey(r.perk);
                    const translated = gameTranslator.translateItem(key);
                    label = translated !== key ? translated : (r.name || "Perk");
                  } else if (itemName === "gold" && r.amount) {
                    label = `Gold $${r.amount}`;
                  } else if (itemName === "heart") {
                    label = "Heart (+25 HP)";
                  } else if (itemName === "heart_bigger") {
                    label = "Heart (+50 HP)";
                  } else if (itemName === "full_heal") {
                    label = "Full Heal";
                  } else if (itemName === "mimic_potion") {
                    const t = gameTranslator.translateItem("animal_mimic_potion");
                    label = t !== "animal_mimic_potion" ? t : "Henkevä potu";
                  } else if (itemName === "emerald_tablet") {
                    // Carries a descriptive per-location name ("Emerald Tablet
                    // (Holy Bomb)"); use it instead of the humanized item id.
                    label = r.name || "Emerald Tablet";
                  } else if (itemName === "pillar_segment") {
                    // Achievement subject's verified common.csv name when the
                    // spec has one (bosses/essences), else the curated title.
                    // (Locked state only affects rendering colour — the card
                    // openly shows the requirement, so no need to hide names.)
                    let nm = r.name && r.name !== "pillar_segment" ? r.name : "";
                    const nameKey = r.reqSpec?.nameKey;
                    if (nameKey) {
                      const t = gameTranslator.translateItem(String(nameKey));
                      if (t && t !== nameKey) nm = t;
                    }
                    label = nm || i18next.t("poi.pillars", "Achievement Pillars");
                  } else if (itemName === "orb") {
                    // True orbs carry a descriptive name ("Orb: Sea of Lava").
                    label = r.name && r.name !== "orb" ? r.name : "Orb";
                  } else if (r.nameKey) {
                    const t = gameTranslator.translateItem(String(r.nameKey));
                    label = t !== r.nameKey ? t : (r.name || itemName.replace(/_/g, " "));
                  } else {
                    label = itemName.replace(/_/g, " ");
                  }
                } else if (r.type === "entity" && r.entity) {
                  const translationKey = `animal_${canonicalEntityId(String(r.entity))}`;
                  const translated = gameTranslator.translateItem(translationKey);
                  // Prefer the creature translation; else the POI's explicit
                  // name (e.g. boss reward "Sampo"); else humanized entity id.
                  label =
                    translated !== translationKey
                      ? translated
                      : (r.name || String(r.entity).replace(/_/g, " "));
                } else if (r.type === "enemy") {
                  label = r.enemy || r.type;
                } else {
                  // Containers and bosses: translate via the creature key in
                  // common.csv (animal_<id>), mirroring the boss card. Most boss
                  // types map 1:1 (animal_boss_meat, etc.); a few need remapping
                  // to their actual creature id. Falls back to the POI name, then
                  // a humanized type.
                  const BOSS_ANIMAL_ID: Record<string, string> = {
                    alchemist_boss: "boss_alchemist",
                    pyramid_boss: "boss_limbs",
                    dragon: "boss_dragon",
                    triangle_boss: "boss_gate",
                    boss_pit: "boss_pit",
                    boss_fish: "fish_giga",
                    tiny: "maggot_tiny",
                  };
                  const animalId = BOSS_ANIMAL_ID[r.type] || r.type;
                  const animalKey = `animal_${animalId}`;
                  const animalName = gameTranslator.translateItem(animalKey);
                  if (animalName !== animalKey) {
                    label = animalName;
                  } else if (r.name && r.name !== r.type) {
                    const translated = gameTranslator.translateItem(r.name);
                    label = translated !== r.name ? translated : r.name;
                  } else {
                    label = (r.type || displayName)
                      .replace(/_/g, " ")
                      .replace(/\b\w/g, (c: string) => c.toUpperCase());
                  }
                }
                nameDiv.textContent = label;

                // Emerald Tablet proper title (e.g. "Secretorum Hermetis")
                // shown as a subtitle under the location name.
                if (r.type === "item" && r.item === "emerald_tablet" && r.titleKey) {
                  const t = gameTranslator.translateItem(String(r.titleKey));
                  if (t && t !== r.titleKey) {
                    const titleLine = document.createElement("div");
                    titleLine.textContent = t;
                    titleLine.style.fontSize = "0.82em";
                    titleLine.style.color = "#9a9";
                    titleLine.style.fontStyle = "italic";
                    nameDiv.appendChild(titleLine);
                  }
                }

                // Pillar segment: localized pillar theme ("Pillar of Bosses")
                // as a subtitle under the achievement title.
                if (r.type === "item" && r.item === "pillar_segment" && r.theme) {
                  const themeLine = document.createElement("div");
                  themeLine.textContent = i18next.t(String(r.theme), String(r.theme));
                  themeLine.style.fontSize = "0.82em";
                  themeLine.style.color = "#9a9";
                  themeLine.style.fontStyle = "italic";
                  nameDiv.appendChild(themeLine);
                }

                // Show creature alias subtitle for entities
                if (r.type === "entity" && r.entity && !isSpoilerFree()) {
                  const entityId = canonicalEntityId(String(r.entity));
                  const creatureInfo = CREATURE_DATA[entityId];
                  if (creatureInfo) {
                    const currentLang = i18next.language || "en";
                    const aliasParts: string[] = [];
                    // If not English, add the official Finnish name
                    if (currentLang !== "en" && creatureInfo.name) {
                      aliasParts.push(`"${creatureInfo.name}"`);
                    }
                    // Always add the English alias if present
                    if (creatureInfo.alias) {
                      aliasParts.push(`"${creatureInfo.alias}"`);
                    }
                    if (aliasParts.length > 0) {
                      const aliasLine = document.createElement("div");
                      aliasLine.className = "creature-alias-line";
                      aliasLine.textContent = aliasParts.join(", ");
                      aliasLine.style.fontSize = "0.82em";
                      aliasLine.style.color = "#9a9";
                      aliasLine.style.fontStyle = "italic";
                      nameDiv.appendChild(aliasLine);
                    }
                  }
                }
              }
            }
            } else {
              nameDiv.textContent = displayName;
            }
            contentDiv.appendChild(nameDiv);

            if ((result as any).chunksAway != null && !isNaN((result as any).chunksAway)) {
              const chunksAway = Number((result as any).chunksAway) || 0;
              const proximitySpan = document.createElement("span");
              proximitySpan.className = "ms-2 text-secondary proximity-hint";
              proximitySpan.style.fontSize = "0.8em";
              proximitySpan.dataset.chunksAway = String(chunksAway);
              proximitySpan.textContent = i18next.t("search.chunksAway", "~{{count}} chunks away", { count: chunksAway });
              contentDiv.appendChild(proximitySpan);
            }

            // English name on second line if not in English and different
            if (!isSpoilerFree() && currentLang !== "en" && displayName !== result.name) {
              const englishDiv = document.createElement("div");
              englishDiv.className = "overlay-english-line";
              englishDiv.textContent = result.name;
              englishDiv.style.fontSize = "0.85em";
              englishDiv.style.color = "#888";
              englishDiv.style.fontStyle = "italic";
              contentDiv.appendChild(englishDiv);
            }

            // Aliases on third line if they exist
            if (!isSpoilerFree() && "aliases" in result && result.aliases) {
              const aliasDiv = document.createElement("div");
              aliasDiv.className = "overlay-aliases-line";
              aliasDiv.textContent = `(${result.aliases.join(", ")})`;
              aliasDiv.style.fontSize = "0.85em";
              aliasDiv.style.color = "#666";
              contentDiv.appendChild(aliasDiv);
            }

            // Wand spells display (hidden in spoiler-free mode)
            if (
              !isSpoilerFree() &&
              (result as any).type === "wand" &&
              ((result as any).cards?.length > 0 || (result as any).alwaysCasts?.length > 0)
            ) {
              const spellsDiv = document.createElement("div");
              spellsDiv.className = "wand-spells-container mt-1 d-flex flex-wrap gap-1";
              spellsDiv.style.alignItems = "center";
              // Leave room for the AC badge that overhangs the first icon's top-left
              spellsDiv.style.marginLeft = "6px";

              const addSpellIcons = (spellNames: string[], isAlwaysCast: boolean) => {
                for (const spellName of spellNames) {
                  const spell = spells.find((s) => s.id === spellName);
                  if (spell) {
                    const imgContainer = document.createElement("div");
                    imgContainer.style.position = "relative";
                    imgContainer.style.display = "inline-block";
                    imgContainer.style.backgroundColor = "#1a1a1a";
                    imgContainer.style.borderRadius = "2px";
                    imgContainer.style.padding = "1px";
                    imgContainer.style.border = "1px solid #333";
                    if (isAlwaysCast) {
                      const acBadge = document.createElement("div");
                      acBadge.textContent = "AC";
                      acBadge.style.position = "absolute";
                      acBadge.style.top = "-4px";
                      acBadge.style.left = "-4px";
                      acBadge.style.width = "12px";
                      acBadge.style.height = "12px";
                      acBadge.style.display = "flex";
                      acBadge.style.alignItems = "center";
                      acBadge.style.justifyContent = "center";
                      acBadge.style.fontSize = "7px";
                      acBadge.style.fontWeight = "bold";
                      acBadge.style.backgroundColor = "white";
                      acBadge.style.color = "black";
                      acBadge.style.borderRadius = "50%";
                      acBadge.style.lineHeight = "1";
                      acBadge.style.border = "1px solid #333";
                      acBadge.style.zIndex = "2";
                      attachAlwaysCastPopover(acBadge);
                      imgContainer.appendChild(acBadge);
                    }

                    const img = document.createElement("img");
                    img.className = "pixelated-image";
                    img.style.display = "block";
                    img.title = gameTranslator.translateSpell(spell.name);
                    // 2x native for crisp integer scaling (matches the POI card).
                    img.onload = () => {
                      img.style.width = `${img.naturalWidth * 2}px`;
                      img.style.height = `${img.naturalHeight * 2}px`;
                    };

                    getPOISpriteFirstFrame({ type: "spell", item: spell.id }).then((url) => {
                      if (url) {
                        img.src = url;
                      } else {
                        img.src = `./assets/icons/spells/${spell.sprite}`;
                        img.onerror = () => {
                          img.src = "./assets/icons/no_image_available.png";
                        };
                      }
                    });

                    imgContainer.appendChild(img);
                    spellsDiv.appendChild(imgContainer);
                  }
                }
              };

              if ((result as any).alwaysCasts) {
                addSpellIcons((result as any).alwaysCasts, true);
              }
              if ((result as any).cards) {
                addSpellIcons((result as any).cards, false);
              }

              contentDiv.appendChild(spellsDiv);
            }

            // Container contents (hidden in spoiler-free mode)
            if (!isSpoilerFree() && (result as any).isDynamic && (result as any).items?.length > 0) {
              const itemsDiv = document.createElement("div");
              itemsDiv.className = "container-items-row mt-1 d-flex flex-wrap gap-1";
              itemsDiv.style.alignItems = "center";

              const items = (result as any).items as any[];
              for (const item of items) {
                if (item.ignore) continue;
                if (item.type === "wand" || item.item === "wand") {
                  // Show wand sprite + its spells
                  const wandContainer = document.createElement("div");
                  wandContainer.style.display = "flex";
                  wandContainer.style.alignItems = "center";
                  wandContainer.style.gap = "2px";
                  wandContainer.style.backgroundColor = "#1a1a1a";
                  wandContainer.style.borderRadius = "3px";
                  wandContainer.style.padding = "2px 4px";
                  wandContainer.style.border = "1px solid #333";

                  if (item.sprite) {
                    const wandImg = document.createElement("img");
                    wandImg.classList.add("pixelated-image");
                    wandImg.style.objectFit = "contain";
                    wandImg.style.transform = "rotate(90deg)";
                    // 2x native for crisp integer scaling (matches the POI card).
                    wandImg.onload = () => {
                      wandImg.style.width = `${wandImg.naturalWidth * 2}px`;
                      wandImg.style.height = `${wandImg.naturalHeight * 2}px`;
                    };
                    getPOISpriteFirstFrame({ type: "wand", sprite: item.sprite }).then((url) => {
                      if (url) wandImg.src = url;
                    });
                    wandContainer.appendChild(wandImg);
                  }

                  // Show spells in the wand
                  const allSpells = [...(item.always_casts || []), ...(item.cards || [])];
                  for (const spellName of allSpells.slice(0, 6)) {
                    const spell = spells.find((s) => s.id === spellName);
                    if (spell) {
                      const spellImg = document.createElement("img");
                      spellImg.className = "pixelated-image";
                      spellImg.onload = () => {
                        spellImg.style.width = `${spellImg.naturalWidth * 2}px`;
                        spellImg.style.height = `${spellImg.naturalHeight * 2}px`;
                      };
                      spellImg.title = gameTranslator.translateSpell(spell.name);

                      getPOISpriteFirstFrame({ type: "spell", item: spell.id }).then((url) => {
                        if (url) {
                          spellImg.src = url;
                        } else {
                          spellImg.src = `./assets/icons/spells/${spell.sprite}`;
                          spellImg.onerror = () => {
                            spellImg.src = "./assets/icons/spells/missing.png";
                          };
                        }
                      });
                      wandContainer.appendChild(spellImg);
                    }
                  }
                  if (allSpells.length > 6) {
                    const more = document.createElement("span");
                    more.style.fontSize = "10px";
                    more.style.color = "#888";
                    more.textContent = `+${allSpells.length - 6}`;
                    wandContainer.appendChild(more);
                  }
                  itemsDiv.appendChild(wandContainer);
                } else {
                  // Non-wand item: show sprite icon
                  const itemImg = document.createElement("img");
                  itemImg.classList.add("pixelated-image");
                  itemImg.style.backgroundColor = "#1a1a1a";
                  itemImg.style.borderRadius = "2px";
                  itemImg.style.padding = "1px";
                  itemImg.style.border = "1px solid #333";
                  itemImg.onload = () => {
                    itemImg.style.width = `${itemImg.naturalWidth * 2}px`;
                    itemImg.style.height = `${itemImg.naturalHeight * 2}px`;
                  };
                  const itemName = item.item || item.type || "";
                  itemImg.title = itemName;
                  getPOISpriteFirstFrame(item).then((url) => {
                    if (url) itemImg.src = url;
                  });
                  itemsDiv.appendChild(itemImg);
                }
              }

              contentDiv.appendChild(itemsDiv);
            }

            listItem.appendChild(contentDiv);
            break;

          case "aoi":
            // Use displayText if available (translated), otherwise fall back to text
            const displayText = ("displayText" in result ? (result as any).displayText : result.text) as
              | string
              | string[];
            if (Array.isArray(displayText)) {
              listItem.textContent = displayText.join("; ");
            } else {
              listItem.textContent = displayText || result.text.join("; ");
            }
            break;
        }
      }

      this.wrapper.appendChild(listItem);
    }
  }
}
