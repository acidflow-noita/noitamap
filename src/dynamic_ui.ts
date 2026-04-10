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
let generatePopoverInstance: any = null;

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
  // Popover (same style as share button / overlay toggles)
  dailySeedBtn.setAttribute("data-bs-toggle", "popover");
  dailySeedBtn.setAttribute("data-bs-placement", "bottom");
  dailySeedBtn.setAttribute("data-bs-trigger", "hover focus");
  dailySeedBtn.setAttribute("data-i18n-title", "dynamicMap.daily");
  dailySeedBtn.setAttribute("data-bs-title", i18next.t("dynamicMap.daily"));
  dailySeedBtn.setAttribute("data-i18n-content", "dynamicMap.dailyDescription");
  dailySeedBtn.setAttribute("data-bs-content", i18next.t("dynamicMap.dailyDescription"));
  dailySeedBtn.setAttribute("tabindex", "0");
  dailySeedBtn.innerHTML = `<i class="bi bi-calendar-day me-1"></i><span class="d-none d-xl-inline" data-i18n="dynamicMap.daily">${i18next.t("dynamicMap.daily")}</span>`;
  dailySeedBtn.addEventListener("click", () => onDailySeedClick());
  toolbarEl.appendChild(dailySeedBtn);

  // ── Seed input ──
  seedInput = document.createElement("input");
  seedInput.id = "dynamicSeedInput";
  seedInput.type = "text";
  seedInput.inputMode = "numeric";
  seedInput.pattern = "[0-9]*";
  seedInput.className = "form-control form-control-sm";
  seedInput.setAttribute("data-i18n-placeholder", "dynamicMap.placeholder");
  seedInput.placeholder = i18next.t("dynamicMap.placeholder");
  // Popover -- title is the section, content is set dynamically by updateSeedTooltip()
  seedInput.setAttribute("data-bs-toggle", "popover");
  seedInput.setAttribute("data-bs-placement", "bottom");
  seedInput.setAttribute("data-bs-trigger", "hover focus");
  seedInput.setAttribute("data-bs-title", i18next.t("dynamicMap.placeholder"));
  seedInput.setAttribute("data-bs-content", i18next.t("dynamicMap.seedTooltipCustom"));
  seedInput.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") onGenerateClick();
  });
  seedInput.addEventListener("input", () => {
    // Strip non-numeric characters
    if (seedInput) {
      seedInput.value = seedInput.value.replace(/\D/g, "");
      seedInput.classList.remove("seed-daily");
      updateSeedTooltip(false);
    }
    updateGenerateButtonState();
  });
  toolbarEl.appendChild(seedInput);

  // Wrapper span so popover works even when button is disabled (Bootstrap requirement)
  const generateWrapper = document.createElement("span");
  generateWrapper.id = "dynamicGenerateWrapper";
  generateWrapper.setAttribute("data-bs-toggle", "popover");
  generateWrapper.setAttribute("data-bs-placement", "bottom");
  generateWrapper.setAttribute("data-bs-trigger", "hover focus");
  generateWrapper.setAttribute("data-bs-html", "true");
  generateWrapper.setAttribute("data-i18n-title", "dynamicMap.generate.label");
  generateWrapper.setAttribute("data-bs-title", i18next.t("dynamicMap.generate.label"));
  generateWrapper.setAttribute("data-bs-content", "");
  generateWrapper.setAttribute("tabindex", "0");

  generateBtn = document.createElement("button");
  generateBtn.id = "dynamicGenerateButton";
  generateBtn.className = "btn btn-sm btn-outline-light text-nowrap";
  generateBtn.innerHTML = `<i class="bi bi-play-fill me-1"></i><span class="d-none d-xl-inline" data-i18n="dynamicMap.generate.label">${i18next.t("dynamicMap.generate.label")}</span>`;
  generateBtn.addEventListener("click", () => onGenerateClick());

  generateWrapper.appendChild(generateBtn);
  toolbarEl.appendChild(generateWrapper);

  // ── Lymm's Telescope button ──
  const nerdBtn = document.createElement("a");
  nerdBtn.id = "dynamicNerdModeButton";
  nerdBtn.className = "btn btn-sm btn-outline-secondary text-nowrap";
  nerdBtn.href = NERD_MODE_URL;
  nerdBtn.target = "_blank";
  nerdBtn.rel = "noopener noreferrer";
  nerdBtn.innerHTML = `<i class="bi bi-box-arrow-up-right me-1"></i><span class="d-none d-xl-inline" data-i18n="dynamicMap.nerdMode.label">${i18next.t("dynamicMap.nerdMode.label")}</span>`;
  nerdBtn.addEventListener("click", () => {
    const seed = new URLSearchParams(window.location.search).get("se");
    nerdBtn.href = seed ? `${NERD_MODE_URL}?seed=${seed}` : NERD_MODE_URL;
  });
  toolbarEl.appendChild(nerdBtn);

  const overlaySel = buttonContainer.querySelector("#overlay-selector");
  if (overlaySel) {
    buttonContainer.insertBefore(toolbarEl, overlaySel);
  } else {
    buttonContainer.appendChild(toolbarEl);
  }

  // Initialize popovers and tooltips
  // @ts-ignore
  new bootstrap.Popover(dailySeedBtn);
  // @ts-ignore
  seedTooltipInstance = new bootstrap.Popover(seedInput);
  // @ts-ignore
  generatePopoverInstance = new bootstrap.Popover(generateWrapper);

  // Initial state for buttons
  updateGenerateButtonState();

  // Re-translate the entire toolbar whenever the language changes
  i18next.on("languageChanged", refreshDynamicUITranslations);
}

// ─── Translation Refresh ─────────────────────────────────────────────────────

function refreshDynamicUITranslations(): void {
  if (!toolbarEl) return;

  // Daily seed button
  if (dailySeedBtn) {
    dailySeedBtn.setAttribute("data-bs-title", i18next.t("dynamicMap.daily"));
    dailySeedBtn.setAttribute("data-bs-content", i18next.t("dynamicMap.dailyDescription"));
    const span = dailySeedBtn.querySelector("span[data-i18n]");
    if (span) span.textContent = i18next.t("dynamicMap.daily");
  }

  // Seed input
  if (seedInput) {
    seedInput.placeholder = i18next.t("dynamicMap.placeholder");
    seedInput.setAttribute("data-bs-title", i18next.t("dynamicMap.placeholder"));
    // Determine current tooltip flavour (daily or custom)
    const isDaily = seedInput.classList.contains("seed-daily");
    const contentKey = isDaily ? "dynamicMap.seedTooltipDaily" : "dynamicMap.seedTooltipCustom";
    seedInput.setAttribute("data-bs-content", i18next.t(contentKey));
  }

  // Generate button text + wrapper popover
  if (generateBtn && !isBusy) {
    const genSpan = generateBtn.querySelector("span[data-i18n]");
    if (genSpan) genSpan.textContent = i18next.t("dynamicMap.generate.label");
  }
  // Update generate wrapper popover (handles both active and "already generated" states)
  updateGenerateButtonState();

  // Nerd mode / telescope button
  const nerdBtn = document.getElementById("dynamicNerdModeButton");
  if (nerdBtn) {
    const nerdSpan = nerdBtn.querySelector("span[data-i18n]");
    if (nerdSpan) nerdSpan.textContent = i18next.t("dynamicMap.nerdMode.label");
  }

  // Dispose and reinitialize ALL popovers in the toolbar
  toolbarEl.querySelectorAll('[data-bs-toggle="popover"]').forEach(el => {
    // @ts-ignore
    const existing = bootstrap.Popover.getInstance(el);
    if (existing) existing.dispose();
    // @ts-ignore
    new bootstrap.Popover(el);
  });
}

// ─── Visibility ──────────────────────────────────────────────────────────────

export function updateDynamicUIVisibility(currentMap: string): void {
  if (!toolbarEl) return;
  const isDynamic = currentMap === DYNAMIC_MAP_NAME;
  toolbarEl.classList.toggle("d-none", !isDynamic);
  toolbarEl.classList.toggle("d-flex", isDynamic);

  // Hide overlay toggles on dynamic map, except those that work on the dynamic map.
  const overlaySelector = document.getElementById("overlay-selector");
  if (overlaySelector) {
    const dynamicOverlayKeys = new Set(["biomeBoundaries"]);
    const togglers = overlaySelector.querySelectorAll<HTMLInputElement>("input.overlayToggler");
    for (const toggler of togglers) {
      const label = overlaySelector.querySelector<HTMLLabelElement>(`label[for="${toggler.id}"]`);
      const key = toggler.dataset.overlayKey;
      const shouldHide = isDynamic && !dynamicOverlayKeys.has(key || "");
      toggler.classList.toggle("d-none", shouldHide);
      if (label) label.classList.toggle("d-none", shouldHide);
    }
  }

  if (isDynamic) {
    // Pre-initialize telescope modules in background so first generation is faster
    import("./telescope/telescope-adapter").then((m) => m.initTelescope()).catch(() => {});
    // Only populate seedInput from last-known seed if the input is empty.
    // setSeedParams may have already written the pending seed here;
    // overwriting it with getCurrentDynamicSeed() would show the OLD seed.
    const seed = getCurrentDynamicSeed();
    if (seed !== null && seedInput && !seedInput.value) {
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
      showLoadingStrip();
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
    showLoadingStrip();
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
      ? `<span class="spinner-border spinner-border-sm me-1" role="status"></span><span class="d-none d-xl-inline" data-i18n="dynamicMap.generate.label">${i18next.t("dynamicMap.generate.label")}</span>`
      : `<i class="bi bi-play-fill me-1"></i><span class="d-none d-xl-inline" data-i18n="dynamicMap.generate.label">${i18next.t("dynamicMap.generate.label")}</span>`;
  }
  if (dailySeedBtn) dailySeedBtn.disabled = busy;
}

function updateGenerateButtonState(): void {
  if (!generateBtn || !seedInput) return;
  const currentSeed = getCurrentDynamicSeed();
  const inputSeed = parseInt(seedInput.value || "", 10);
  const isMatch = !isNaN(inputSeed) && inputSeed === currentSeed;

  generateBtn.disabled = isMatch || isBusy;

  // Update popover on the wrapper (works even when button is disabled)
  const wrapper = document.getElementById("dynamicGenerateWrapper");
  if (!wrapper) return;
  const content = isMatch
    ? i18next.t("dynamicMap.generate.alreadyGeneratedContent")
    : "";
  const title = isMatch
    ? i18next.t("dynamicMap.generate.alreadyGeneratedTitle")
    : i18next.t("dynamicMap.generate.label");
  wrapper.setAttribute("data-bs-content", content);
  wrapper.setAttribute("data-bs-title", title);

  // @ts-ignore Update active popover DOM if it is currently visible
  const instance = bootstrap.Popover.getInstance(wrapper);
  if (instance && instance.tip) {
    const header = instance.tip.querySelector('.popover-header');
    if (header) header.innerHTML = title;
    const body = instance.tip.querySelector('.popover-body');
    if (body) body.innerHTML = content;
  }
}

/** Show the non-blocking loading strip with download already complete. */
export function showLoadingStrip(): void {
  const strip = document.getElementById("map-loading-strip");
  if (!strip) return;
  strip.classList.remove("fade-out");
  strip.classList.add("visible");
  // Skip download phase (data.zip already loaded)
  const dl = document.getElementById("loading-bar-download") as HTMLElement | null;
  if (dl) dl.style.width = "100%";
  // Reset generation and items bars
  const gen = document.getElementById("loading-bar-generation") as HTMLElement | null;
  const items = document.getElementById("loading-bar-items") as HTMLElement | null;
  if (gen) gen.style.width = "0%";
  if (items) items.style.width = "0%";
  const title = document.getElementById("map-loading-title");
  if (title) title.textContent = i18next.t("loading.mapData.generating");
  const status = document.getElementById("map-loading-status");
  if (status) status.textContent = "33%";
}

/** Hide the loading strip with a fade-out. */
export function hideLoadingStrip(): void {
  const strip = document.getElementById("map-loading-strip");
  if (!strip) return;
  strip.classList.add("fade-out");
  // After the CSS transition completes, fully hide
  setTimeout(() => {
    strip.classList.remove("visible", "fade-out");
  }, 400);
}

export function setDynamicUISeed(seed: number, isDaily: boolean): void {
  if (seedInput) {
    seedInput.value = ""; // Force clear first to prevent any visual appending bugs
    seedInput.value = String(seed);
    seedInput.classList.toggle("seed-daily", isDaily);
    updateSeedTooltip(isDaily);
  }
  updateGenerateButtonState();
}

// ─── Seed Tooltip ────────────────────────────────────────────────────────────

let seedTooltipInstance: any = null;

function updateSeedTooltip(isDaily: boolean): void {
  if (!seedInput) return;
  const key = isDaily ? "dynamicMap.seedTooltipDaily" : "dynamicMap.seedTooltipCustom";
  const text = i18next.t(key);
  seedInput.setAttribute("data-bs-content", text);
  
  // @ts-ignore Update active popover DOM if it is currently visible
  const instance = bootstrap.Popover.getInstance(seedInput);
  if (instance && instance.tip) {
    const body = instance.tip.querySelector('.popover-body');
    if (body) body.innerHTML = text;
  }
}
