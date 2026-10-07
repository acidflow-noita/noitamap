/**
 * dynamic_ui.ts
 *
 * Builds and manages the dynamic map toolbar.
 * Shown only when the active map is 'dynamic-main-branch'.
 */

import i18next from "i18next";
import { fetchDailySeed, fetchPreviousDailySeed, getCachedDailySeedIdentity, subscribeDailySeedIdentity } from "./data_sources/daily_seed";
import { updateURLWithSeed } from "./data_sources/url";
import { getCurrentDynamicSeed, getCompletedDynamicSeed, runDynamicMap } from "./dynamic-map";
import type { DynamicMapOptions } from "./dynamic-map";
import { isSpoilerFree } from "./spoiler-free";
import { updateOverflowMenu } from "./overflow-menu";

const NERD_MODE_URL = "https://lymm37.github.io/noita-telescope/";
const DYNAMIC_MAP_NAME = "dynamic-main-branch";

// Noita seeds are 32-bit signed ints; valid range is 1 .. 2147483647.
const MIN_SEED = 1;
const MAX_SEED = 2147483647;

/** Tri-state for seed-input flavouring. "daily" = today's daily, drawn teal.
 *  "previousDaily" = yesterday's daily, drawn yellow. "custom" = arbitrary
 *  user-entered seed, default colour. */
export type SeedKind = "daily" | "previousDaily" | "custom";

// ─── State ───────────────────────────────────────────────────────────────────

let toolbarEl: HTMLElement | null = null;
let toolbarItems: HTMLElement[] = [];
let seedInput: HTMLInputElement | null = null;
let generateBtn: HTMLButtonElement | null = null;
let dailySeedBtn: HTMLButtonElement | null = null;
let prevDailySeedBtn: HTMLButtonElement | null = null;
let dynamicOpts: DynamicMapOptions | null = null;
let isBusy = false;
let toolbarRequestId = 0;
let generatePopoverInstance: any = null;
let resolvedInputSeed: number | null = null;
let unsubscribeDailyIdentity: (() => void) | undefined;
let loadingStripRevision = 0;
let loadingStripHideTimer: ReturnType<typeof setTimeout> | undefined;
let loadingStripHideElement: HTMLElement | undefined;

// ─── Build ───────────────────────────────────────────────────────────────────

/**
 * Create and inject the dynamic map toolbar into the nav button container.
 */
export function createDynamicUI(opts: DynamicMapOptions): void {
  dynamicOpts = opts;

  const buttonContainer = document.querySelector<HTMLElement>(".collapse.navbar-collapse .d-flex.flex-wrap");
  if (!buttonContainer) return;

  // An invisible anchor comment marks where the dynamic buttons get inserted.
  // Buttons are inserted as DIRECT children of the navbar row (no wrapper div)
  // so every gap between every pair of adjacent items comes from the single
  // `gap` on the navbar row — no nested flex-container/flex-item discrepancy.
  toolbarEl = document.createElement("span");
  toolbarEl.id = "dynamic-map-toolbar";
  toolbarEl.style.display = "none"; // keep for translation-refresh queries below (no-op in layout)

  // ── Previous Daily Seed button (icon-only, sits to the left of Daily) ──
  prevDailySeedBtn = document.createElement("button");
  prevDailySeedBtn.id = "dynamicPrevDailySeedButton";
  prevDailySeedBtn.className = "icon-button btn btn-sm btn-outline-warning text-nowrap";
  prevDailySeedBtn.setAttribute("data-bs-toggle", "popover");
  prevDailySeedBtn.setAttribute("data-bs-placement", "bottom");
  prevDailySeedBtn.setAttribute("data-bs-trigger", "hover focus");
  prevDailySeedBtn.setAttribute("data-i18n-title", "dynamicMap.previousDaily");
  prevDailySeedBtn.setAttribute("data-bs-title", i18next.t("dynamicMap.previousDaily"));
  prevDailySeedBtn.setAttribute("data-i18n-content", "dynamicMap.previousDailyDescription");
  prevDailySeedBtn.setAttribute("data-bs-content", i18next.t("dynamicMap.previousDailyDescription"));
  prevDailySeedBtn.setAttribute("tabindex", "0");
  prevDailySeedBtn.innerHTML = `<i class="bi bi-calendar2-event"></i>`;
  prevDailySeedBtn.addEventListener("click", () => onPrevDailySeedClick());
  toolbarItems.push(prevDailySeedBtn);

  // ── Daily Seed button ──
  dailySeedBtn = document.createElement("button");
  dailySeedBtn.id = "dynamicDailySeedButton";
  dailySeedBtn.className = "icon-button btn btn-sm btn-outline-info text-nowrap";
  // Popover (same style as share button / overlay toggles)
  dailySeedBtn.setAttribute("data-bs-toggle", "popover");
  dailySeedBtn.setAttribute("data-bs-placement", "bottom");
  dailySeedBtn.setAttribute("data-bs-trigger", "hover focus");
  dailySeedBtn.setAttribute("data-i18n-title", "dynamicMap.daily");
  dailySeedBtn.setAttribute("data-bs-title", i18next.t("dynamicMap.daily"));
  dailySeedBtn.setAttribute("data-i18n-content", "dynamicMap.dailyDescription");
  dailySeedBtn.setAttribute("data-bs-content", i18next.t("dynamicMap.dailyDescription"));
  dailySeedBtn.setAttribute("tabindex", "0");
  dailySeedBtn.innerHTML = `<i class="bi bi-calendar-heart"></i><span class="d-none d-xl-inline" data-i18n="dynamicMap.daily">${i18next.t("dynamicMap.daily")}</span>`;
  dailySeedBtn.addEventListener("click", () => onDailySeedClick());
  toolbarItems.push(dailySeedBtn);

  // ── Seed input ──
  seedInput = document.createElement("input");
  seedInput.id = "dynamicSeedInput";
  seedInput.type = "text";
  seedInput.inputMode = "numeric";
  seedInput.pattern = "[0-9]*";
  seedInput.maxLength = 10;
  seedInput.size = 10;
  seedInput.min = String(MIN_SEED);
  seedInput.max = String(MAX_SEED);
  seedInput.className = "form-control form-control-sm";
  if (isSpoilerFree()) {
    seedInput.style.webkitTextSecurity = "disc";
  }
  seedInput.setAttribute("data-i18n-placeholder", "dynamicMap.placeholder");
  seedInput.placeholder = i18next.t("dynamicMap.placeholder");
  // Popover -- title is the section, content is set dynamically by updateSeedTooltip()
  seedInput.setAttribute("data-bs-toggle", "popover");
  seedInput.setAttribute("data-popover-owner", "dynamic-seed");
  seedInput.setAttribute("data-bs-placement", "bottom");
  seedInput.setAttribute("data-bs-trigger", "hover");
  seedInput.setAttribute("data-bs-title", i18next.t("dynamicMap.placeholder"));
  seedInput.setAttribute("data-bs-content", i18next.t("dynamicMap.seedTooltipCustom"));
  seedInput.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") onGenerateClick();
  });
  seedInput.addEventListener("input", () => {
    resolvedInputSeed = null;
    if (seedInput) {
      let digits = seedInput.value.replace(/\D/g, "");
      // Clamp to the valid Noita seed range (1 .. 2147483647).
      if (digits) {
        const n = parseInt(digits, 10);
        if (n > MAX_SEED) digits = String(MAX_SEED);
      }
      seedInput.value = digits;
      seedInput.classList.remove("seed-daily");
      seedInput.classList.remove("seed-prev-daily");
      updateSeedTooltip("custom");
    }
    updateGenerateButtonState();
  });
  toolbarItems.push(seedInput);

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
  generateBtn.className = "icon-button btn btn-sm btn-outline-light text-nowrap";
  generateBtn.innerHTML = `<i class="bi bi-play-fill"></i><span class="d-none d-xl-inline" data-i18n="dynamicMap.generate.label">${i18next.t("dynamicMap.generate.label")}</span>`;
  generateBtn.addEventListener("click", () => onGenerateClick());

  generateWrapper.appendChild(generateBtn);
  toolbarItems.push(generateWrapper);

  // ── Lymm's Telescope button ──
  const nerdBtn = document.createElement("a");
  nerdBtn.id = "dynamicNerdModeButton";
  nerdBtn.className = "icon-button btn btn-sm btn-outline-secondary text-nowrap";
  nerdBtn.href = NERD_MODE_URL;
  nerdBtn.target = "_blank";
  nerdBtn.rel = "noopener noreferrer";
  nerdBtn.innerHTML = `<i class="bi bi-box-arrow-up-right"></i><span class="d-none d-xl-inline" data-i18n="dynamicMap.nerdMode.label">${i18next.t("dynamicMap.nerdMode.label")}</span>`;
  nerdBtn.addEventListener("click", () => {
    const seed = new URLSearchParams(window.location.search).get("se");
    nerdBtn.href = seed ? `${NERD_MODE_URL}?seed=${seed}` : NERD_MODE_URL;
  });
  toolbarItems.push(nerdBtn);

  // Hide items initially; updateDynamicUIVisibility flips them on for dynamic maps.
  toolbarItems.forEach(el => { el.style.display = "none"; });

  const overlaySel = buttonContainer.querySelector("#overlay-selector");
  for (const el of toolbarItems) {
    if (overlaySel) buttonContainer.insertBefore(el, overlaySel);
    else buttonContainer.appendChild(el);
  }

  // Initialize popovers and tooltips
  // @ts-ignore
  new bootstrap.Popover(dailySeedBtn);
  // @ts-ignore
  if (prevDailySeedBtn) new bootstrap.Popover(prevDailySeedBtn);
  // @ts-ignore -- html+no-sanitize so the inline-coloured "teal"/"dark yellow" words render
  seedTooltipInstance = new bootstrap.Popover(seedInput, { html: true, sanitize: false });
  // @ts-ignore
  generatePopoverInstance = new bootstrap.Popover(generateWrapper);

  // Initial state for buttons
  updateGenerateButtonState();
  resolvedInputSeed = null;
  unsubscribeDailyIdentity?.();
  unsubscribeDailyIdentity = subscribeDailySeedIdentity(refreshSeedIdentity);

  // Re-translate the entire toolbar whenever the language changes
  i18next.on("languageChanged", refreshDynamicUITranslations);
}

// ─── Translation Refresh ─────────────────────────────────────────────────────

function refreshDynamicUITranslations(): void {
  if (!toolbarItems.length) return;

  // Daily seed button
  if (dailySeedBtn) {
    dailySeedBtn.setAttribute("data-bs-title", i18next.t("dynamicMap.daily"));
    dailySeedBtn.setAttribute("data-bs-content", i18next.t("dynamicMap.dailyDescription"));
    const span = dailySeedBtn.querySelector("span[data-i18n]");
    if (span) span.textContent = i18next.t("dynamicMap.daily");
  }

  // Previous daily seed button (icon-only, no inner span to refresh)
  if (prevDailySeedBtn) {
    prevDailySeedBtn.setAttribute("data-bs-title", i18next.t("dynamicMap.previousDaily"));
    prevDailySeedBtn.setAttribute("data-bs-content", i18next.t("dynamicMap.previousDailyDescription"));
  }

  // Seed input -- popover always describes the valid seed range, regardless
  // of daily/previous/custom flavour (that distinction is conveyed by colour).
  if (seedInput) {
    seedInput.placeholder = i18next.t("dynamicMap.placeholder");
    seedInput.setAttribute("data-bs-title", i18next.t("dynamicMap.placeholder"));
    seedInput.setAttribute("data-bs-content", i18next.t("dynamicMap.seedTooltipCustom"));
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

  // Dispose and reinitialize ALL popovers in the toolbar items
  toolbarItems.forEach(item => {
    const targets: Element[] = [];
    if (item.matches('[data-bs-toggle="popover"]')) targets.push(item);
    item.querySelectorAll('[data-bs-toggle="popover"]').forEach(el => targets.push(el));
    targets.forEach(el => {
      // @ts-ignore
      const existing = bootstrap.Popover.getInstance(el);
      if (existing) existing.dispose();
      // @ts-ignore -- seed input needs html+no-sanitize to colour the swatch words
      new bootstrap.Popover(el, el === seedInput ? { html: true, sanitize: false } : undefined);
    });
  });
}

// ─── Visibility ──────────────────────────────────────────────────────────────

/**
 * Restore btn-group corner rounding on the first and last VISIBLE labels.
 *
 * Bootstrap squares off the inner edges of every button in a .btn-group via
 * :first-child/:last-child, which are blind to .d-none — so once buttons are
 * hidden per map the surviving ends keep their square inner corners. Exported
 * because the sideworld toggle can appear/disappear independently of a map
 * change, and it is the last button in the group when present.
 */
export function roundVisibleOverlayGroupEdges(): void {
  const overlaySelector = document.getElementById("overlay-selector");
  if (!overlaySelector) return;
  const labels = overlaySelector.querySelectorAll<HTMLLabelElement>("label.btn");
  for (const label of labels) label.style.borderRadius = "";
  const visible = overlaySelector.querySelectorAll<HTMLLabelElement>("label.btn:not(.d-none)");
  if (!visible.length) return;
  const r = "var(--bs-border-radius)";
  visible[0].style.borderTopLeftRadius = r;
  visible[0].style.borderBottomLeftRadius = r;
  visible[visible.length - 1].style.borderTopRightRadius = r;
  visible[visible.length - 1].style.borderBottomRightRadius = r;
}

export function updateDynamicUIVisibility(currentMap: string): void {
  if (!toolbarItems.length) return;
  const isDynamic = currentMap === DYNAMIC_MAP_NAME;
  if (!isDynamic) setDynamicUIBusy(false);
  toolbarItems.forEach(el => { el.style.display = isDynamic ? "" : "none"; });

  // Toggle any dynamic-map-only controls outside the toolbar (e.g. light-mode switch in navbar)
  document.querySelectorAll(".dynamic-map-only").forEach((el) => {
    (el as HTMLElement).classList.toggle("d-none", !isDynamic);
  });

  // Hide overlay toggles that do nothing on the current map.
  //
  // This deliberately does NOT decide visibility on its own for static maps:
  // App.updateOverlaySelectors already hid every toggler whose overlay data
  // has no entry for the current map, and this function runs afterwards. Using
  // `isDynamic` as the only input re-showed all seven on maps like ups-main,
  // undoing that work — and then computed the btn-group corner rounding from
  // the wrong visible set. Respect the disabled flag App set, and only add the
  // dynamic map's extra restriction on top.
  const overlaySelector = document.getElementById("overlay-selector");
  if (overlaySelector) {
    const dynamicOverlayKeys = new Set(["biomeBoundaries"]);
    const togglers = overlaySelector.querySelectorAll<HTMLInputElement>("input.overlayToggler");
    for (const toggler of togglers) {
      const label = overlaySelector.querySelector<HTMLLabelElement>(`label[for="${toggler.id}"]`);
      const key = toggler.dataset.overlayKey;
      const unavailableForMap = toggler.disabled;
      const hiddenByDynamicMap = isDynamic && !dynamicOverlayKeys.has(key || "");
      const shouldHide = unavailableForMap || hiddenByDynamicMap;
      toggler.classList.toggle("d-none", shouldHide);
      if (label) {
        label.classList.toggle("d-none", shouldHide);
        // Reset any previously set border-radius
        label.style.borderRadius = "";
      }
    }

    roundVisibleOverlayGroupEdges();
  }

  // Relocate secondary controls into the "..." menu on the dynamic map;
  // restore them to the navbar on static maps.
  updateOverflowMenu(currentMap);

  if (isDynamic) {
    // Do not initialize the generator on baked views. runDynamicMap loads it
    // on demand for a custom seed; an idle prewarm still starves daily tiles.
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

/** Daily navigation leaves an explicitly forced live preview. Renderer and
 * camera preferences remain unchanged; only the baked-map bypass is reset. */
function restoreBakedDailyRoute(): boolean {
  const url = new URL(window.location.href);
  if (!url.searchParams.has('nb')) return false;
  url.searchParams.delete('nb');
  window.history.replaceState(window.history.state, '', url);
  return true;
}

async function onDailySeedClick(): Promise<void> {
  if (isBusy || !dynamicOpts) return;
  const isCurrent = beginToolbarRequest();
  try {
    const seed = await fetchDailySeed(true);
    if (!isCurrent()) return;
    if (seedInput) {
      seedInput.value = String(seed);
      resolvedInputSeed = seed;
      // Apply the colour immediately. onSeedResolved would do this after
      // runDynamicMap finishes, but that's seconds later — by then the user
      // has already seen the wrong colour.
      seedInput.classList.add("seed-daily");
      seedInput.classList.remove("seed-prev-daily");
      updateSeedTooltip("daily");
    }
    const currentSeed = getCompletedDynamicSeed();
    const routeChanged = restoreBakedDailyRoute();

    if (seed !== currentSeed || routeChanged) {
      updateURLWithSeed(seed, true);
      showLoadingStrip();
      await runDynamicMap(seed, true, dynamicOpts);
    } else {
      console.log("[DynamicUI] Daily seed matches current seed, skipping.");
    }
  } catch (e) {
    console.error("[DynamicUI] Daily seed fetch failed:", e);
  } finally {
    if (isCurrent()) setDynamicUIBusy(false);
  }
}

async function onPrevDailySeedClick(): Promise<void> {
  if (isBusy || !dynamicOpts) return;
  const isCurrent = beginToolbarRequest();
  try {
    const seed = await fetchPreviousDailySeed(true);
    if (!isCurrent()) return;
    if (seed === null) {
      console.warn("[DynamicUI] Previous daily seed unavailable.");
      return;
    }
    if (seedInput) {
      seedInput.value = String(seed);
      resolvedInputSeed = seed;
      seedInput.classList.add("seed-prev-daily");
      seedInput.classList.remove("seed-daily");
      updateSeedTooltip("previousDaily");
    }
    const currentSeed = getCompletedDynamicSeed();
    const routeChanged = restoreBakedDailyRoute();

    if (seed !== currentSeed || routeChanged) {
      // Previous daily renders as a daily (all-unlocked, baked DZIs available
      // on the previous-daily-* workers).
      updateURLWithSeed(seed, true);
      showLoadingStrip();
      await runDynamicMap(seed, true, dynamicOpts);
    } else {
      console.log("[DynamicUI] Previous daily seed matches current seed, skipping.");
    }
  } catch (e) {
    console.error("[DynamicUI] Previous daily seed fetch failed:", e);
  } finally {
    if (isCurrent()) setDynamicUIBusy(false);
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
  if (isNaN(seed) || seed < MIN_SEED || seed > MAX_SEED) {
    seedInput.classList.add("is-invalid");
    setTimeout(() => seedInput?.classList.remove("is-invalid"), 1500);
    return;
  }

  const currentSeed = getCompletedDynamicSeed();
  if (seed === currentSeed) return;

  const isCurrent = beginToolbarRequest();
  try {
    updateURLWithSeed(seed, false);
    showLoadingStrip();
    await runDynamicMap(seed, false, dynamicOpts);
  } catch (e) {
    console.error("[DynamicUI] Generate failed:", e);
  } finally {
    if (isCurrent()) setDynamicUIBusy(false);
  }
}

/** The current pipeline owns busy state; first paint alone does not finish it. */
export function setDynamicUIBusy(busy: boolean): void {
  toolbarRequestId++;
  setBusy(busy);
  updateGenerateButtonState();
}

/** Daily lookup belongs to the toolbar until it hands off to the map pipeline. */
function beginToolbarRequest(): () => boolean {
  setDynamicUIBusy(true);
  const requestId = toolbarRequestId;
  return () => requestId === toolbarRequestId;
}

function setBusy(busy: boolean): void {
  isBusy = busy;
  if (generateBtn) {
    generateBtn.disabled = busy;
    generateBtn.innerHTML = busy
      ? `<span class="spinner-border spinner-border-sm" role="status"></span><span class="d-none d-xl-inline" data-i18n="dynamicMap.generate.label">${i18next.t("dynamicMap.generate.label")}</span>`
      : `<i class="bi bi-play-fill"></i><span class="d-none d-xl-inline" data-i18n="dynamicMap.generate.label">${i18next.t("dynamicMap.generate.label")}</span>`;
  }
  if (dailySeedBtn) dailySeedBtn.disabled = busy;
  if (prevDailySeedBtn) prevDailySeedBtn.disabled = busy;
}

function updateGenerateButtonState(): void {
  if (!generateBtn || !seedInput) return;
  const currentSeed = getCompletedDynamicSeed();
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

  const tip = (bootstrap.Popover.getInstance(wrapper) as unknown as { tip?: HTMLElement } | null)?.tip;
  if (tip) {
    const header = tip.querySelector('.popover-header');
    if (header) header.textContent = title;
    const body = tip.querySelector('.popover-body');
    if (body) body.textContent = content;
  }
}

/** Show a new load, or preserve the phase values when publishing an update. */
export function showLoadingStrip(reset = true): void {
  loadingStripRevision++;
  clearTimeout(loadingStripHideTimer);
  loadingStripHideTimer = undefined;
  loadingStripHideElement = undefined;
  const strip = document.getElementById("map-loading-strip");
  if (!strip) return;
  strip.classList.remove("fade-out");
  strip.classList.add("visible");
  if (!reset) return;
  for (const phase of ['download', 'generation', 'items']) {
    const bar = document.getElementById(`loading-bar-${phase}`);
    if (bar) bar.style.width = '0%';
  }
  const title = document.getElementById("map-loading-title");
  if (title) title.textContent = i18next.t("loading.maps");
  const status = document.getElementById("map-loading-status");
  if (status) status.textContent = '';
  document.querySelector('.loading-strip-bar-track')?.classList.add('indeterminate');
}

type LoadingPhase = 'download' | 'generation' | 'items';

/** The strip reports ordered phases of the selected map, never background work. */
export function createLoadingStripProgress() {
  const phases: LoadingPhase[] = ['download', 'generation', 'items'];
  let active = false, finished = true;
  let baked: boolean | undefined;
  let phase: LoadingPhase | undefined, percentage = 0;

  const render = () => {
    showLoadingStrip(false);
    const index = phase ? phases.indexOf(phase) : -1;
    const itemsOnly = baked === true;
    const values = phases.map((_, i) => itemsOnly
      ? (i === 2 && phase === 'items' ? percentage : 0)
      : (i < index ? 100 : i === index ? percentage : 0));
    const weight = itemsOnly ? 1 : 3;
    phases.forEach((name, i) => {
      const bar = document.getElementById(`loading-bar-${name}`);
      if (bar) bar.style.width = `${values[i] / weight}%`;
    });
    const title = document.getElementById('map-loading-title');
    const key = phase === 'items' ? 'loading.mapData.addingItems'
      : phase === 'download' && percentage < 100 ? 'loading.mapData.downloading'
      : baked === false ? 'loading.mapData.generating' : 'loading.maps';
    if (title) title.textContent = i18next.t(key);
    const status = document.getElementById('map-loading-status');
    const complete = phase === 'items' && percentage === 100;
    const overall = Math.round(values.reduce((a, b) => a + b, 0) / weight);
    if (status) status.textContent = phase ? `${complete ? 100 : Math.min(99, overall)}%` : '';
    document.querySelector('.loading-strip-bar-track')?.classList.toggle('indeterminate',
      !phase || (phase !== 'items' && percentage === 100));
  };

  return {
    start() {
      active = true; finished = false; baked = undefined; phase = undefined; percentage = 0;
    },
    settle() {
      active = false;
      // OSD may still owe the current marker layer's completion callback.
      if (phase !== 'items') { finished = true; hideLoadingStrip(); }
    },
    cancel() {
      active = false; finished = true; hideLoadingStrip();
    },
    show() {
      if (active && !finished) render();
    },
    setBaked(value: boolean) {
      baked = value;
      if (!active || finished) return;
      if (value && phase !== 'items') {
        phase = undefined; percentage = 0;
        for (const name of phases) {
          const bar = document.getElementById(`loading-bar-${name}`);
          if (bar) bar.style.width = '0%';
        }
        document.querySelector('.loading-strip-bar-track')?.classList.remove('indeterminate');
        hideLoadingStrip();
      } else if (document.getElementById('map-loading-strip')?.classList.contains('visible')) render();
    },
    update(next: LoadingPhase, value: number) {
      if (!Number.isFinite(value) || finished) return;
      if (!active && !(phase === 'items' && next === 'items')) return;
      if (baked === true && next !== 'items') return;
      if (phase && phases.indexOf(next) < phases.indexOf(phase)) return;
      const nextPercentage = Math.min(100, Math.max(0, value));
      if (phase === next && nextPercentage < percentage) return;
      phase = next; percentage = nextPercentage;
      if (next === 'generation') baked = false;
      render();
      if (next === 'items' && percentage === 100) {
        finished = true;
        finishLoadingStrip();
      }
    },
  };
}

/** Hide the loading strip with a fade-out. */
export function hideLoadingStrip(): void {
  const strip = document.getElementById("map-loading-strip");
  if (!strip) return;
  // Repeated completion signals share this fade; they must not leave cleanup
  // timers behind or extend its duration. A new show cancels it immediately.
  if (loadingStripHideTimer !== undefined && loadingStripHideElement === strip) return;
  clearTimeout(loadingStripHideTimer);
  loadingStripHideElement = strip;
  const revision = loadingStripRevision;
  strip.classList.add("fade-out");
  // After the CSS transition completes, fully hide
  loadingStripHideTimer = setTimeout(() => {
    if (revision !== loadingStripRevision || loadingStripHideElement !== strip) return;
    loadingStripHideTimer = undefined;
    loadingStripHideElement = undefined;
    strip.classList.remove("visible", "fade-out");
  }, 400);
}

/** Let completed progress paint, but never finish a newer loading cycle. */
export function finishLoadingStrip(): void {
  const strip = document.getElementById("map-loading-strip");
  if (!strip) return;
  const revision = loadingStripRevision;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (revision !== loadingStripRevision || document.getElementById("map-loading-strip") !== strip) return;
      hideLoadingStrip();
      for (const phase of ['download', 'generation', 'items']) {
        const bar = document.getElementById(`loading-bar-${phase}`);
        if (bar) bar.style.width = '0%';
      }
    });
  });
}

export function setDynamicUISeed(seed: number, _isDaily: boolean): void {
  if (seedInput) {
    seedInput.value = "";
    seedInput.value = String(seed);
    resolvedInputSeed = seed;
    refreshSeedIdentity();
    updateSeedTooltip("custom");
  }
  updateGenerateButtonState();
}

/** Refresh colours after a delayed lookup without replacing edited input or
 * changing generation mode. Historical ds=1 links aren't necessarily today. */
function refreshSeedIdentity(): void {
  if (!seedInput || resolvedInputSeed === null || seedInput.value !== String(resolvedInputSeed)) return;
  const identity = getCachedDailySeedIdentity(resolvedInputSeed);
  seedInput.classList.toggle("seed-daily", identity === 'today');
  seedInput.classList.toggle("seed-prev-daily", identity === 'previous');
}

// ─── Seed Tooltip ────────────────────────────────────────────────────────────

let seedTooltipInstance: any = null;

function updateSeedTooltip(_kind: SeedKind): void {
  if (!seedInput) return;
  // The seed input popover always describes the valid seed range; the
  // daily/previous/custom distinction is shown via the input colour instead.
  const text = i18next.t("dynamicMap.seedTooltipCustom");
  seedInput.setAttribute("data-bs-content", text);

  const tip = (bootstrap.Popover.getInstance(seedInput) as unknown as { tip?: HTMLElement } | null)?.tip;
  const body = tip?.querySelector('.popover-body');
  // This is the same trusted translation HTML used by the initial popover.
  if (body) body.innerHTML = text;
}
