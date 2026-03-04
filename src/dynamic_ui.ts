/**
 * dynamic_ui.ts
 *
 * Builds and manages the dynamic map toolbar.
 * Shown only when the active map is 'dynamic-main-branch'.
 */

import i18next from "i18next";
import { fetchDailySeed } from "./data_sources/daily_seed";
import { updateURLWithSeed } from "./data_sources/url";
import { getCurrentDynamicSeed, runDynamicMap } from "./dynamic-map";
import type { DynamicMapOptions } from "./dynamic-map";

const NERD_MODE_URL = "https://lymm37.github.io/noita-telescope/";
const DYNAMIC_MAP_NAME = "dynamic-main-branch";

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
 */
export function createDynamicUI(opts: DynamicMapOptions): void {
  dynamicOpts = opts;

  const buttonContainer = document.querySelector<HTMLElement>(".collapse.navbar-collapse .d-flex.flex-wrap");
  if (!buttonContainer) return;

  toolbarEl = document.createElement("div");
  toolbarEl.id = "dynamic-map-toolbar";
  toolbarEl.className = "d-none d-flex flex-wrap align-items-center gap-1 me-1";

  // ── Daily Seed button ──
  dailySeedBtn = document.createElement("button");
  dailySeedBtn.id = "dynamicDailySeedButton";
  dailySeedBtn.className = "btn btn-sm btn-outline-info text-nowrap";
  // Tooltip only for daily
  dailySeedBtn.setAttribute("data-bs-toggle", "tooltip");
  dailySeedBtn.setAttribute("data-bs-placement", "bottom");
  dailySeedBtn.setAttribute("data-i18n-title", "dynamicMap.daily");
  dailySeedBtn.title = i18next.t("dynamicMap.daily");
  dailySeedBtn.innerHTML = `<i class="bi bi-calendar-day"></i><span class="ms-1 d-none d-xl-inline" data-i18n="dynamicMap.daily">${i18next.t("dynamicMap.daily")}</span>`;
  dailySeedBtn.addEventListener("click", () => onDailySeedClick());
  toolbarEl.appendChild(dailySeedBtn);

  // ── Seed input ──
  seedInput = document.createElement("input");
  seedInput.id = "dynamicSeedInput";
  seedInput.type = "text";
  seedInput.inputMode = "numeric";
  seedInput.pattern = "[0-9]*";
  seedInput.className = "form-control form-control-sm";
  seedInput.style.width = "110px";
  seedInput.setAttribute("data-i18n-placeholder", "dynamicMap.placeholder");
  seedInput.placeholder = i18next.t("dynamicMap.placeholder");
  seedInput.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") onGenerateClick();
  });
  seedInput.addEventListener("input", () => {
    // Strip non-numeric characters
    if (seedInput) seedInput.value = seedInput.value.replace(/\D/g, "");
    updateGenerateButtonState();
  });
  toolbarEl.appendChild(seedInput);

  generateBtn = document.createElement("button");
  generateBtn.id = "dynamicGenerateButton";
  generateBtn.className = "btn btn-sm btn-outline-light text-nowrap";
  generateBtn.innerHTML = `<i class="bi bi-play-fill"></i><span class="ms-1 d-none d-xl-inline" data-i18n="dynamicMap.generate.label">${i18next.t("dynamicMap.generate.label")}</span>`;
  generateBtn.addEventListener("click", () => onGenerateClick());

  toolbarEl.appendChild(generateBtn);

  // ── Nerd Mode button ──
  const nerdBtn = document.createElement("a");
  nerdBtn.id = "dynamicNerdModeButton";
  nerdBtn.className = "btn btn-sm btn-outline-secondary text-nowrap";
  nerdBtn.href = NERD_MODE_URL;
  nerdBtn.target = "_blank";
  nerdBtn.rel = "noopener noreferrer";
  nerdBtn.innerHTML = `<i class="bi bi-code-slash"></i><span class="ms-1 d-none d-xl-inline" data-i18n="dynamicMap.nerdMode.label">${i18next.t("dynamicMap.nerdMode.label")}</span>`;
  toolbarEl.appendChild(nerdBtn);

  const overlaySel = buttonContainer.querySelector("#overlay-selector");
  if (overlaySel) {
    buttonContainer.insertBefore(toolbarEl, overlaySel);
  } else {
    buttonContainer.appendChild(toolbarEl);
  }

  // Initialize tooltips
  // @ts-ignore
  new bootstrap.Tooltip(dailySeedBtn);

  // Initial state for buttons
  updateGenerateButtonState();
}

// ─── Visibility ──────────────────────────────────────────────────────────────

export function updateDynamicUIVisibility(currentMap: string): void {
  if (!toolbarEl) return;
  const isDynamic = currentMap === DYNAMIC_MAP_NAME;
  toolbarEl.classList.toggle("d-none", !isDynamic);
  toolbarEl.classList.toggle("d-flex", isDynamic);

  if (isDynamic) {
    const seed = getCurrentDynamicSeed();
    if (seed !== null && seedInput) {
      seedInput.value = String(seed);
    }
    updateGenerateButtonState();
  }
}

// ─── Handlers ────────────────────────────────────────────────────────────────

async function onDailySeedClick(): Promise<void> {
  if (isBusy || !dynamicOpts) return;
  setBusy(true);
  try {
    const seed = await fetchDailySeed();
    if (seedInput) seedInput.value = String(seed);
    const currentSeed = getCurrentDynamicSeed();

    if (seed !== currentSeed) {
      updateURLWithSeed(seed, true);
      await runDynamicMap(seed, true, dynamicOpts);
    } else {
      console.log("[DynamicUI] Daily seed matches current seed, skipping.");
    }
  } catch (e) {
    console.error("[DynamicUI] Daily seed fetch failed:", e);
  } finally {
    setTimeout(() => {
      setBusy(false);
      updateGenerateButtonState();
    }, 300);
  }
}

async function onGenerateClick(): Promise<void> {
  if (isBusy || !dynamicOpts || !seedInput) return;
  const rawVal = seedInput.value.trim();
  if (!rawVal) {
    await onDailySeedClick();
    return;
  }
  const seed = parseInt(rawVal, 10);
  if (isNaN(seed)) {
    seedInput.classList.add("is-invalid");
    setTimeout(() => seedInput?.classList.remove("is-invalid"), 1500);
    return;
  }

  const currentSeed = getCurrentDynamicSeed();
  if (seed === currentSeed) return;

  setBusy(true);
  try {
    updateURLWithSeed(seed, false);
    await runDynamicMap(seed, false, dynamicOpts);
  } catch (e) {
    console.error("[DynamicUI] Generate failed:", e);
  } finally {
    setTimeout(() => {
      setBusy(false);
      updateGenerateButtonState();
    }, 300);
  }
}

function setBusy(busy: boolean): void {
  isBusy = busy;
  if (generateBtn) {
    generateBtn.disabled = busy;
    generateBtn.innerHTML = busy
      ? '<span class="spinner-border spinner-border-sm" role="status"></span>'
      : `<i class="bi bi-play-fill"></i><span class="ms-1 d-none d-xl-inline" data-i18n="dynamicMap.generate.label">${i18next.t("dynamicMap.generate.label")}</span>`;
  }
  if (dailySeedBtn) dailySeedBtn.disabled = busy;
}

function updateGenerateButtonState(): void {
  if (!generateBtn || !seedInput) return;
  const currentSeed = getCurrentDynamicSeed();
  const inputSeed = parseInt(seedInput.value || "", 10);
  const isMatch = !isNaN(inputSeed) && inputSeed === currentSeed;

  generateBtn.disabled = isMatch || isBusy;
}

export function setDynamicUISeed(seed: number, isDaily: boolean): void {
  if (seedInput) seedInput.value = String(seed);
  updateGenerateButtonState();
}
