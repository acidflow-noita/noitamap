import { TargetOfInterest } from "../data_sources/overlays";
import { Spell } from "../data_sources/overlays";
import { EventEmitter2 } from "eventemitter2";
import i18next from "../i18n";
import { getSpellAvailability } from "../util";
import { getWandSprite, getPOISpriteFirstFrame } from "../telescope/telescope-osd-bridge";
import spells from "../data/spells.json";
import { gameTranslator } from "../game-translations/translator";

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
    this.wrapper.innerHTML = "";
    this.bindEvents();
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
        proximitySpan.textContent = `~${chunksAway} chunks away`;
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
    this.wrapper.innerHTML = "";
    // this.wrapper.style.display = hide ? 'none' : 'block';
  }

  setResults(results: UnifiedSearchResult[]) {
    this.clearResults(results.length === 0);

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
              getWandSprite((result as any).sprite).then((url) => {
                if (url) img.src = url;
              });
              listItem.appendChild(img);
            } else if ((result as any).isDynamic && (result as any).type) {
              // Non-wand POIs: use atlas for fast image loading
              listItem.classList.add("d-flex", "align-items-center");
              const img = document.createElement("img");
              img.classList.add("pixelated-image", "me-2", "flex-shrink-0");
              img.style.width = "32px";
              img.style.height = "32px";
              img.style.objectFit = "contain";
              getPOISpriteFirstFrame(result as any).then((url) => {
                if (url) img.src = url;
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
                const wandName = (result as any).wandName || (result as any).name || "Magic";
                if (wandName.toUpperCase() === "TAIKASAUVA") {
                  const aliveWandText = i18next.t("alive_wand", "(alive wand)");
                  nameDiv.textContent = `TAIKASAUVA ${aliveWandText}`;
                } else {
                  nameDiv.textContent = `${wandName} wand`;
                }
              } else {
                nameDiv.textContent = displayName;
              }

              if ((result as any).chunksAway !== null) {
                const chunksAway = (result as any).chunksAway as number;
                const proximitySpan = document.createElement("span");
                proximitySpan.className = "ms-2 text-secondary";
                proximitySpan.style.fontSize = "0.8em";
                proximitySpan.textContent = `~${chunksAway} chunks away`;
                nameDiv.appendChild(proximitySpan);
              }
            } else {
              nameDiv.textContent = displayName;
            }
            contentDiv.appendChild(nameDiv);

            // English name on second line if not in English and different
            if (currentLang !== "en" && displayName !== result.name) {
              const englishDiv = document.createElement("div");
              englishDiv.className = "overlay-english-line";
              englishDiv.textContent = result.name;
              englishDiv.style.fontSize = "0.85em";
              englishDiv.style.color = "#888";
              englishDiv.style.fontStyle = "italic";
              contentDiv.appendChild(englishDiv);
            }

            // Aliases on third line if they exist
            if ("aliases" in result && result.aliases) {
              const aliasDiv = document.createElement("div");
              aliasDiv.className = "overlay-aliases-line";
              aliasDiv.textContent = `(${result.aliases.join(", ")})`;
              aliasDiv.style.fontSize = "0.85em";
              aliasDiv.style.color = "#666";
              contentDiv.appendChild(aliasDiv);
            }

            // ADD THIS FOR WANDS:
            if (
              (result as any).type === "wand" &&
              ((result as any).cards?.length > 0 || (result as any).alwaysCasts?.length > 0)
            ) {
              const spellsDiv = document.createElement("div");
              spellsDiv.className = "wand-spells-container mt-1 d-flex flex-wrap gap-1";
              spellsDiv.style.alignItems = "center";

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
                      imgContainer.appendChild(acBadge);
                    }

                    const img = document.createElement("img");
                    img.src = `./assets/icons/spells/${spell.sprite}`;
                    img.className = "pixelated-image";
                    img.style.width = "20px";
                    img.style.height = "20px";
                    img.style.display = "block";
                    img.title = gameTranslator.translateSpell(spell.name);

                    img.onerror = () => {
                      img.src = "./assets/icons/spells/missing.png";
                    };

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
