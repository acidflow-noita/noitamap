/**
 * telescope-dom-shim.ts
 *
 * Injects fake DOM checkbox elements that telescope's JS reads via
 * document.getElementById().  Must be called BEFORE any telescope
 * module that references the DOM (poi_scanner, pixel_scene_generation,
 * utils / getBiomeAtWorldCoordinates).
 *
 * The shim creates hidden checkboxes with the IDs telescope expects
 * and sets their .checked / .value to the defaults we want for noitamap.
 */

let installed = false;

export interface TelescopeShimOptions {
  clearSpawnPixels?: boolean;
  recolorMaterials?: boolean;
  enableEdgeNoise?: boolean;
  fixHolyMountainEdgeNoise?: boolean;
}

const DEFAULTS: Required<TelescopeShimOptions> = {
  clearSpawnPixels: true,
  recolorMaterials: false,
  enableEdgeNoise: true,
  fixHolyMountainEdgeNoise: true,
};

/**
 * Install hidden checkbox stubs so telescope code can call
 * `document.getElementById('clear-spawn-pixels').checked` etc.
 */
export function installTelescopeShim(opts?: TelescopeShimOptions): void {
  if (installed) return;
  installed = true;

  const cfg = { ...DEFAULTS, ...opts };

  // Checkbox inputs — telescope reads these via .checked
  const checkboxes: Record<string, boolean> = {
    "clear-spawn-pixels": cfg.clearSpawnPixels,
    "recolor-materials": cfg.recolorMaterials,
    "debug-enable-edge-noise": cfg.enableEdgeNoise,
    "debug-fix-holy-mountain-edge-noise": cfg.fixHolyMountainEdgeNoise,
    // Additional IDs telescope may read (safe no-ops)
    "debug-hide-pois": true,
    "debug-draw": false,
    "debug-path": false,
    "debug-rng-info": false,
    "debug-original-biome-map": false,
    "debug-small-pois": false,
    "debug-edge-noise": false,
    "debug-block-edge-spawns": false,
    "skip-cosmetic-scenes": false,
    "exclude-taikasauva": false,
    "exclude-edge-cases": false,
    "visited-coalmine-alt-shrine": false,
    // Search-related checkboxes
    "search-all-pw": false,
    "search-vertical-pw": false,
    "show-wand-sprite-rarity": false,
    // App UI checkboxes
    "custom-art": false,
    "debug-show-path": false,
    "debug-show-tile-bounds": false,
    "show-enemy-spawns": true,
    "greed-curse": false,
    "no-more-shuffle": false,
    "auto-increment-seed": false,
    "enable-edge-noise": false,
    "fix-holy-mountain-edge-noise": false,
    "enable-hamis-hints": false,
    "exclude-negative-verticals": false,
    "rng-info": false,
    // New upstream UI settings; our generator does not enable these views.
    "debug-pois-zoom": false,
    "debug-highlight-pois-zoom": false,
    "accessibility-mode": false,
    "debug-simple-poi-symbols": false,
    "show-always-casts": false,
    "progress-show-missing": false,
  };

  const container = document.createElement("div");
  container.id = "telescope-shim";
  container.style.display = "none";

  for (const [id, checked] of Object.entries(checkboxes)) {
    if (document.getElementById(id)) continue; // already exists
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.id = id;
    cb.checked = checked;
    container.appendChild(cb);
  }

  // Text/number inputs — telescope reads these via .value
  const textInputs: Record<string, string> = {
    "debug-extra-rerolls": "0",
    "debug-biome-overlay-mode": "none",
    "enable-static-pixel-scenes": "all",
    // Navigation inputs
    "seed": "0",
    "pw": "0",
    "pw-vertical": "0",
    // Search inputs
    "search-input": "",
    "search-name": "",
    // Wand tier dual slider (search_manager reads these; 0..19 = full WAND_TIERS range = no filter)
    "tier-min-range": "0",
    "tier-max-range": "19",
    "search-sprite": "",
    "search-ac": "",
    "search-ac-mode": "any",
    "search-shuffle-mode": "any",
    "search-pw-limit": "1",
    "search-pw-vertical-limit": "1",
    // Wand stat filter inputs (min/max ranges)
    "cap-max-num": "99999",
    "cap-min-num": "0",
    "delay-max-num": "99999",
    "delay-min-num": "-99999",
    "len-max-num": "99999",
    "len-min-num": "0",
    "mana-max-num": "99999",
    "mana-min-num": "0",
    "manarech-max-num": "99999",
    "manarech-min-num": "0",
    "rarity-max-num": "99999",
    "rarity-min-num": "0",
    "rech-max-num": "99999",
    "rech-min-num": "-99999",
    "speed-max-num": "99999",
    "speed-min-num": "0",
    "spells-max-num": "99999",
    "spells-min-num": "0",
    "spread-max-num": "99999",
    "spread-min-num": "-99999",
    // App UI inputs
    "ng": "0",
    "extra-shop-items": "0",
    "game-mode": "normal",
    "local-search-mode": "global",
    "search-radius-num": "0",
    "debug-poi-scale": "1",
    "debug-highlight-poi-scale": "1",
    "lottery-count": "0",
  };
  for (const [id, value] of Object.entries(textInputs)) {
    if (document.getElementById(id)) continue;
    const input = document.createElement("input");
    input.type = "text";
    input.id = id;
    input.value = value;
    container.appendChild(input);
  }

  // Container/display elements — telescope accesses .innerHTML, .innerText, .style, or .getBoundingClientRect
  const displayElements: Record<string, string> = {
    "search-results": "div",
    "search-nav": "div",
    "search-count": "span",
    "cancel-search": "button",
    "view": "div",
    // App UI containers, canvases, and buttons
    "advanced-ui": "div",
    "canvas": "canvas",
    "coords": "div",
    "copy-path-btn": "button",
    "daily-run-button": "button",
    "debug-noise-canvas": "canvas",
    "debug-options": "div",
    "gen-btn": "button",
    "loading-overlay": "div",
    "loading-text": "div",
    "overlay": "canvas",
    "pw-dec": "button",
    "pw-dec-vertical": "button",
    "pw-inc": "button",
    "pw-inc-vertical": "button",
    "pw-set-max": "span",
    "pw-set-max-vertical": "span",
    "regions-all": "button",
    "regions-list": "div",
    "regions-none": "button",
    "regions-useful": "button",
    "search-all-pw-label": "label",
    "search-background": "div",
    "search-btn": "button",
    "search-label": "span",
    "search-next": "button",
    "search-prev": "button",
    "search-status": "span",
    "search-status-container": "div",
    "status": "div",
    "tooltip": "div",
    "unlock-all": "button",
    "unlock-folder-picker": "input",
    "unlock-none": "button",
    "unlocks-list": "div",
    "search-rare-btn": "button",
    "fungal-shifts-overlay": "div",
    "fungal-shifts-button": "button",
    "fungal-shifts-close": "button",
    "perk-deck-overlay": "div",
    "perk-deck-button": "button",
    "perk-deck-close": "button",
    "search-missing-progress-btn": "button",
    "progress-overlay": "div",
    "player-copy-path-btn": "button",
    "player-file-picker": "input",
    "alchemy-list": "div",
    "alchemy-label": "label",
    "debug-poi-scale-value": "span",
    "debug-highlight-poi-scale-value": "span",
    "shifts-list": "div",
    "temple-list": "div",
    "pw-label": "span",
    "prev-pw": "button",
    "next-pw": "button",
    "reset-btn": "button",
    "reroll-deck-toggle": "button",
    "reroll-deck-list": "div",
    "progress-lists": "div",
    "progress-close": "button",
    "progress-button": "button",
  };
  for (const [id, tagName] of Object.entries(displayElements)) {
    if (document.getElementById(id)) continue;
    const el = document.createElement(tagName);
    el.id = id;
    container.appendChild(el);
  }

  document.body.appendChild(container);
}
