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

  const checkboxes: Record<string, boolean> = {
    'clear-spawn-pixels': cfg.clearSpawnPixels,
    'recolor-materials': cfg.recolorMaterials,
    'debug-enable-edge-noise': cfg.enableEdgeNoise,
    'debug-fix-holy-mountain-edge-noise': cfg.fixHolyMountainEdgeNoise,
    // Additional IDs telescope may read (safe no-ops)
    'debug-hide-pois': true,
    'debug-draw': false,
    'debug-path': false,
    'debug-rng-info': false,
    'debug-original-biome-map': false,
    'debug-small-pois': false,
    'debug-edge-noise': false,
    'skip-cosmetic-scenes': false,
    'exclude-taikasauva': false,
    'exclude-edge-cases': false,
    'visited-coalmine-alt-shrine': false,
  };

  const container = document.createElement('div');
  container.id = 'telescope-shim';
  container.style.display = 'none';

  for (const [id, checked] of Object.entries(checkboxes)) {
    if (document.getElementById(id)) continue; // already exists
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.id = id;
    cb.checked = checked;
    container.appendChild(cb);
  }

  // Also add text inputs telescope may read
  const textInputs: Record<string, string> = {
    'debug-extra-rerolls': '0',
    'debug-biome-overlay-mode': 'none',
  };
  for (const [id, value] of Object.entries(textInputs)) {
    if (document.getElementById(id)) continue;
    const input = document.createElement('input');
    input.type = 'text';
    input.id = id;
    input.value = value;
    container.appendChild(input);
  }

  document.body.appendChild(container);
}
