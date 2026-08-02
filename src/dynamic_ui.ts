/**
 * dynamic_ui.ts
 *
 * Builds and manages the dynamic map toolbar.
 * Shown only when the active map is 'dynamic-main-branch'.
 */

import i18next from "i18next";
import { fetchDailySeed, fetchPreviousDailySeed, getCachedPreviousDailySeed, getCachedDailySeed } from "./data_sources/daily_seed";
import { updateURLWithSeed } from "./data_sources/url";
import { getCurrentDynamicSeed, runDynamicMap } from "./dynamic-map";
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
let generatePopoverInstance: any = null;

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
  seedInput.setAttribute("data-bs-placement", "bottom");
  seedInput.setAttribute("data-bs-trigger", "hover");
  seedInput.setAttribute("data-bs-title", i18next.t("dynamicMap.placeholder"));
  seedInput.setAttribute("data-bs-content", i18next.t("dynamicMap.seedTooltipCustom"));
  seedInput.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") onGenerateClick();
  });
  seedInput.addEventListener("input", () => {
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
    // Pre-initialize telescope modules in the background so a later custom-seed
    // generation is faster — but DEFER it to idle. Run eagerly it downloads
    // data.zip + pixel_scenes.zip + wang_tiles.zip and spins up wasm on the
    // main thread, which on a baked daily (telescope never used) just starves
    // the biome DZI tiles trying to paint. runDynamicMap still calls
    // initTelescope() itself when a generation actually needs it.
    {
      const warm = () => { import("./telescope/telescope-adapter").then((m) => m.initTelescope()).catch(() => {}); };
      const ric = (window as any).requestIdleCallback as
        | ((cb: () => void, opts?: { timeout: number }) => number)
        | undefined;
      if (ric) ric(warm, { timeout: 5000 });
      else setTimeout(warm, 2000);
    }
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
    if (seedInput) {
      seedInput.value = String(seed);
      // Apply the colour immediately. onSeedResolved would do this after
      // runDynamicMap finishes, but that's seconds later — by then the user
      // has already seen the wrong colour.
      seedInput.classList.add("seed-daily");
      seedInput.classList.remove("seed-prev-daily");
      updateSeedTooltip("daily");
    }
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

async function onPrevDailySeedClick(): Promise<void> {
  if (isBusy || !dynamicOpts) return;
  setBusy(true);
  try {
    const seed = await fetchPreviousDailySeed();
    if (seed === null) {
      console.warn("[DynamicUI] Previous daily seed unavailable.");
      return;
    }
    if (seedInput) {
      seedInput.value = String(seed);
      seedInput.classList.add("seed-prev-daily");
      seedInput.classList.remove("seed-daily");
      updateSeedTooltip("previousDaily");
    }
    const currentSeed = getCurrentDynamicSeed();

    if (seed !== currentSeed) {
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
  if (isNaN(seed) || seed < MIN_SEED || seed > MAX_SEED) {
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
      ? `<span class="spinner-border spinner-border-sm" role="status"></span><span class="d-none d-xl-inline" data-i18n="dynamicMap.generate.label">${i18next.t("dynamicMap.generate.label")}</span>`
      : `<i class="bi bi-play-fill"></i><span class="d-none d-xl-inline" data-i18n="dynamicMap.generate.label">${i18next.t("dynamicMap.generate.label")}</span>`;
  }
  if (dailySeedBtn) dailySeedBtn.disabled = busy;
  if (prevDailySeedBtn) prevDailySeedBtn.disabled = busy;
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

  const tip = (bootstrap.Popover.getInstance(wrapper) as unknown as { tip?: HTMLElement } | null)?.tip;
  if (tip) {
    const header = tip.querySelector('.popover-header');
    if (header) header.textContent = title;
    const body = tip.querySelector('.popover-body');
    if (body) body.textContent = content;
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
    seedInput.value = "";
    seedInput.value = String(seed);
    // Auto-detect the kind from the cached daily/previous-daily seeds. The
    // `isDaily` arg is only a hint — callers like noitamap-pro's seed-report
    // click handler always pass false, but if the seed equals today's or
    // yesterday's daily we still want the right colour. The cached lookups
    // are populated by the speculative fetch in index.html so they're warm
    // by the time any user click lands.
    const prevDaily = getCachedPreviousDailySeed();
    const today = getCachedDailySeed();
    let kind: SeedKind;
    if (prevDaily !== null && seed === prevDaily) {
      kind = "previousDaily";
    } else if (today !== null && seed === today) {
      kind = "daily";
    } else if (isDaily) {
      // Caller asserts daily but neither cache matches yet — trust the hint.
      kind = "daily";
    } else {
      kind = "custom";
    }
    seedInput.classList.toggle("seed-daily", kind === "daily");
    seedInput.classList.toggle("seed-prev-daily", kind === "previousDaily");
    updateSeedTooltip(kind);
  }
  updateGenerateButtonState();
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
  if (body) body.textContent = text;
}
