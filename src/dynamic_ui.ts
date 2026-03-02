/**
 * dynamic_ui.ts
 *
 * Builds and manages the dynamic map toolbar.
 * Shown only when the active map is 'dynamic-main-branch'.
 *
 * Layout (left to right in the navbar button strip):
 *   [Daily Seed's Map] [seed input] [Generate] [Nerd Mode]
 *
 * The toolbar is inserted as a sibling of the standard controls
 * inside `.d-flex.flex-wrap` and hidden/shown based on map state.
 */

import { fetchDailySeed } from './data_sources/daily_seed';
import { updateURLWithSeed } from './data_sources/url';
import { getCurrentDynamicSeed, getCurrentIsDaily, runDynamicMap } from './dynamic-map';
import type { DynamicMapOptions } from './dynamic-map';

const NERD_MODE_URL = 'https://lymm37.github.io/noita-telescope/';
const DYNAMIC_MAP_NAME = 'dynamic-main-branch';

// ─── State ───────────────────────────────────────────────────────────────────

let toolbarEl: HTMLElement | null = null;
let seedInput: HTMLInputElement | null = null;
let generateBtn: HTMLButtonElement | null = null;
let dailySeedBtn: HTMLButtonElement | null = null;
let dynamicOpts: DynamicMapOptions | null = null;
let isBusy = false;

// ─── Build ───────────────────────────────────────────────────────────────────

/**
 * Create and inject the dynamic map toolbar into the nav button container.
 * Call once after DOMContentLoaded.
 *
 * @param opts - Dynamic map options (viewer, callbacks) used when Generate is clicked
 */
export function createDynamicUI(opts: DynamicMapOptions): void {
  dynamicOpts = opts;

  const buttonContainer = document.querySelector<HTMLElement>(
    '.collapse.navbar-collapse .d-flex.flex-wrap',
  );
  if (!buttonContainer) {
    console.error('[DynamicUI] Could not find button container');
    return;
  }

  // Wrapper — hidden by default, shown when on dynamic map
  toolbarEl = document.createElement('div');
  toolbarEl.id = 'dynamic-map-toolbar';
  toolbarEl.className = 'd-none d-flex flex-wrap align-items-center gap-1 me-1';

  // ── Daily Seed's Map button ────────────────────────────────────────────────
  dailySeedBtn = document.createElement('button');
  dailySeedBtn.id = 'dynamicDailySeedButton';
  dailySeedBtn.className = 'btn btn-sm btn-outline-info text-nowrap';
  dailySeedBtn.title = "Load today's daily seed map";
  dailySeedBtn.innerHTML = '<i class="bi bi-calendar-day"></i><span class="ms-1 d-none d-xl-inline">Daily</span>';
  dailySeedBtn.addEventListener('click', () => onDailySeedClick());
  toolbarEl.appendChild(dailySeedBtn);

  // ── Custom seed input ──────────────────────────────────────────────────────
  seedInput = document.createElement('input');
  seedInput.id = 'dynamicSeedInput';
  seedInput.type = 'text';
  seedInput.inputMode = 'numeric';
  seedInput.pattern = '[0-9]*';
  seedInput.className = 'form-control form-control-sm';
  seedInput.placeholder = 'Custom seed…';
  seedInput.style.width = '110px';
  seedInput.title = 'Enter a custom seed number';
  seedInput.addEventListener('keydown', ev => {
    if (ev.key === 'Enter') onGenerateClick();
  });
  toolbarEl.appendChild(seedInput);

  // ── Generate button ────────────────────────────────────────────────────────
  generateBtn = document.createElement('button');
  generateBtn.id = 'dynamicGenerateButton';
  generateBtn.className = 'btn btn-sm btn-outline-light text-nowrap';
  generateBtn.title = 'Generate map for this seed';
  generateBtn.innerHTML = '<i class="bi bi-play-fill"></i><span class="ms-1 d-none d-xl-inline">Generate</span>';
  generateBtn.addEventListener('click', () => onGenerateClick());
  toolbarEl.appendChild(generateBtn);

  // ── Nerd Mode button ───────────────────────────────────────────────────────
  const nerdBtn = document.createElement('a');
  nerdBtn.id = 'dynamicNerdModeButton';
  nerdBtn.className = 'btn btn-sm btn-outline-secondary text-nowrap';
  nerdBtn.href = NERD_MODE_URL;
  nerdBtn.target = '_blank';
  nerdBtn.rel = 'noopener noreferrer';
  nerdBtn.title = 'Open Telescope (advanced mode) in a new tab';
  nerdBtn.innerHTML = '<i class="bi bi-code-slash"></i><span class="ms-1 d-none d-xl-inline">Nerd Mode</span>';
  toolbarEl.appendChild(nerdBtn);

  // Insert BEFORE the overlay-selector group so it appears right after the search
  const overlaySel = buttonContainer.querySelector('#overlay-selector');
  if (overlaySel) {
    buttonContainer.insertBefore(toolbarEl, overlaySel);
  } else {
    buttonContainer.appendChild(toolbarEl);
  }
}

// ─── Visibility ──────────────────────────────────────────────────────────────

/**
 * Show or hide the toolbar depending on whether the dynamic map is active.
 * Call this on every map-change event and on initial load.
 */
export function updateDynamicUIVisibility(currentMap: string): void {
  if (!toolbarEl) return;

  const isDynamic = currentMap === DYNAMIC_MAP_NAME;
  toolbarEl.classList.toggle('d-none', !isDynamic);
  toolbarEl.classList.toggle('d-flex', isDynamic);

  if (isDynamic) {
    // Reflect the current seed in the input field
    const seed = getCurrentDynamicSeed();
    if (seed !== null && seedInput) {
      seedInput.value = String(seed);
    }
  }
}

// ─── Handlers ────────────────────────────────────────────────────────────────

async function onDailySeedClick(): Promise<void> {
  if (isBusy || !dynamicOpts) return;
  setBusy(true);
  try {
    const seed = await fetchDailySeed();
    if (seedInput) seedInput.value = String(seed);
    updateURLWithSeed(seed, true);
    await runDynamicMap(seed, true, dynamicOpts);
  } catch (e) {
    console.error('[DynamicUI] Daily seed fetch failed:', e);
  } finally {
    setBusy(false);
  }
}

async function onGenerateClick(): Promise<void> {
  if (isBusy || !dynamicOpts || !seedInput) return;

  const rawVal = seedInput.value.trim();
  if (!rawVal) {
    // No seed typed — fall back to daily
    await onDailySeedClick();
    return;
  }

  const seed = parseInt(rawVal, 10);
  if (isNaN(seed)) {
    seedInput.classList.add('is-invalid');
    setTimeout(() => seedInput?.classList.remove('is-invalid'), 1500);
    return;
  }

  setBusy(true);
  try {
    updateURLWithSeed(seed, false);
    await runDynamicMap(seed, false, dynamicOpts);
  } catch (e) {
    console.error('[DynamicUI] Generate failed:', e);
  } finally {
    setBusy(false);
  }
}

function setBusy(busy: boolean): void {
  isBusy = busy;
  if (generateBtn) {
    generateBtn.disabled = busy;
    generateBtn.innerHTML = busy
      ? '<span class="spinner-border spinner-border-sm" role="status"></span>'
      : '<i class="bi bi-play-fill"></i><span class="ms-1 d-none d-xl-inline">Generate</span>';
  }
  if (dailySeedBtn) dailySeedBtn.disabled = busy;
}

/**
 * Pre-fill the seed input with a given seed (called by the pipeline after
 * resolving the daily seed so the UI reflects what was generated).
 */
export function setDynamicUISeed(seed: number, isDaily: boolean): void {
  if (seedInput) seedInput.value = String(seed);
}
