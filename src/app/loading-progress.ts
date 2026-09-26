import i18next from '../i18n';
import { showLoadingStrip, hideLoadingStrip } from '../dynamic_ui';
import { isBakedSeedView } from '../spoiler-free';

/** Own progress events and phase layout independently of application startup. */
export function installLoadingProgress(getMap: () => string) {
  // Handle map loading progress UI (non-blocking strip)
  const _getDownloadBar = () => document.getElementById("loading-bar-download") as HTMLElement | null;
  const _getGenerationBar = () => document.getElementById("loading-bar-generation") as HTMLElement | null;
  const _getItemsBar = () => document.getElementById("loading-bar-items") as HTMLElement | null;
  const _getStatusText = () => document.getElementById("map-loading-status");
  const _getTitle = () => document.getElementById("map-loading-title");
  // Whether the current dynamic view is served from baked DZIs. Kept in sync
  // through setBaked(). The loading strip narrates the
  // download -> generate -> items pipeline, and on a baked view that pipeline
  // never runs -- so strip events triggered by background work must not show it
  // (see the dataZipProgress handler).
  let bakedViewActive = isBakedSeedView();
  const controller = new AbortController();

  // Pin the phase label column to the widest of the three phase translations
  // in the current language, so the percent column never shifts when the
  // phase text changes. Re-measure on language change.
  const _phaseKeys = [
    "loading.mapData.downloading",
    "loading.mapData.generating",
    "loading.mapData.addingItems",
  ];
  const _recomputePhaseMinWidth = () => {
    const phaseEl = _getTitle();
    if (!phaseEl) return;
    const probe = document.createElement("span");
    const cs = getComputedStyle(phaseEl);
    probe.style.position = "absolute";
    probe.style.visibility = "hidden";
    probe.style.whiteSpace = "nowrap";
    probe.style.fontFamily = cs.fontFamily;
    probe.style.fontSize = cs.fontSize;
    probe.style.fontWeight = cs.fontWeight;
    probe.style.fontStyle = cs.fontStyle;
    probe.style.letterSpacing = cs.letterSpacing;
    probe.style.fontFeatureSettings = cs.fontFeatureSettings;
    document.body.appendChild(probe);
    let maxW = 0;
    for (const k of _phaseKeys) {
      probe.textContent = i18next.isInitialized ? i18next.t(k) : k;
      if (probe.offsetWidth > maxW) maxW = probe.offsetWidth;
    }
    probe.remove();
    const fontSizePx = parseFloat(cs.fontSize) || 16;
    phaseEl.style.minWidth = `${(maxW / fontSizePx).toFixed(3)}em`;
  };
  if (i18next.isInitialized) _recomputePhaseMinWidth();
  else i18next.on("initialized", _recomputePhaseMinWidth);
  i18next.on("languageChanged", _recomputePhaseMinWidth);

  window.addEventListener("dataZipProgress", ((e: CustomEvent) => {
    const bar = _getDownloadBar();
    const status = _getStatusText();
    const title = _getTitle();
    if (!bar) return;

    // data.zip is shared world data fetched for every map, but the phases this
    // strip reports — biome generation, then item placement — only ever run on
    // the dynamic map, and only itemsGenerationProgress(100) hides the strip
    // again. On a static map nothing fires that event, so showing the strip here
    // left it pinned open forever under an indeterminate spinner, advertising
    // biome generation that never starts. Static maps get no strip at all; the
    // ordinary spinner already covers their tile loading.
    if (getMap() !== "dynamic-main-branch") return;
    // Baked views never generate: data.zip is only being fetched here for
    // background consumers (pixel-scene prefetch, POI tooling, the alt-unlocks
    // pre-warm). On 100% this handler flips the strip into its indeterminate
    // "Generating Biomes / 33%" state -- and on a baked map nothing ever fires
    // biomeGenerationProgress or itemsGenerationProgress, so that stuck 33%
    // strip sat there until a refresh. This was THE "stuck at 33%" regression:
    // it reappeared whenever any code path (re)fetched data.zip after a baked
    // fast-path load.
    if (bakedViewActive) return;

    showLoadingStrip();

    if (e.detail.percentage < 100) {
      bar.style.width = `${e.detail.percentage}%`;
      if (title) title.textContent = i18next.isInitialized ? i18next.t("loading.mapData.downloading") : "Downloading World Data";
      if (status) status.textContent = `${Math.round(e.detail.percentage / 3)}%`;
    } else {
      bar.style.width = "100%";
      if (title) title.textContent = i18next.isInitialized ? i18next.t("loading.mapData.generating") : "Generating Biomes";
      if (status) status.textContent = "33%";
      // Add indeterminate animation to the track so the loading bar doesn't appear frozen
      const track = document.querySelector(".loading-strip-bar-track");
      if (track) track.classList.add("indeterminate");
    }
  }) as EventListener, { signal: controller.signal });

  window.addEventListener("biomeGenerationProgress", ((e: CustomEvent) => {
    const bar = _getGenerationBar();
    const status = _getStatusText();
    if (!bar) return;

    // Stop indeterminate animation once real progress arrives
    const track = document.querySelector(".loading-strip-bar-track");
    if (track) track.classList.remove("indeterminate");
    showLoadingStrip();
    bar.style.width = `${e.detail.percentage}%`;
    if (status) status.textContent = `${Math.round(33 + e.detail.percentage / 3)}%`;

    if (e.detail.percentage >= 100) {
      const title = _getTitle();
      if (title) title.textContent = i18next.isInitialized ? i18next.t("loading.mapData.addingItems") : "Adding items and wands";
      bar.style.width = "100%";
      if (status) status.textContent = "66%";
    }
  }) as EventListener, { signal: controller.signal });

  window.addEventListener("itemsGenerationProgress", ((e: CustomEvent) => {
    const bar = _getItemsBar();
    const status = _getStatusText();
    if (!bar) return;

    showLoadingStrip();
    // Baked fast path: download/generation phases never ran (their bars are
    // untouched), so the items phase is the WHOLE strip — title it correctly
    // and show a true 0-100% instead of the 3-phase 66-100% tail.
    const itemsOnly =
      !parseFloat(_getDownloadBar()?.style.width || "0") && !parseFloat(_getGenerationBar()?.style.width || "0");
    const title = _getTitle();
    if (title) title.textContent = i18next.isInitialized ? i18next.t("loading.mapData.addingItems") : "Adding items and wands";
    bar.style.width = `${e.detail.percentage}%`;
    if (status) {
      status.textContent = itemsOnly
        ? `${Math.round(e.detail.percentage)}%`
        : `${Math.round(66 + e.detail.percentage / 3)}%`;
    }

    if (e.detail.percentage >= 100) {
      requestAnimationFrame(() => {
        if (controller.signal.aborted) return;
        requestAnimationFrame(() => {
          if (controller.signal.aborted) return;
          hideLoadingStrip();
          // Reset all bars for the next generation
          const dl = _getDownloadBar();
          const gen = _getGenerationBar();
          const it = _getItemsBar();
          if (dl) dl.style.width = "0%";
          if (gen) gen.style.width = "0%";
          if (it) it.style.width = "0%";
        });
      });
    }
  }) as EventListener, { signal: controller.signal });

  return {
    setBaked(baked: boolean) {
      bakedViewActive = baked;
      // The probe can resolve AFTER a dataZipProgress(100) already flipped the
      // strip into its indeterminate "Generating Biomes / 33%" state (the fetch
      // races the probe). Dismiss it: on a baked view no generation follows, so
      // nothing else will ever hide that strip.
      if (baked) {
        const gen = _getGenerationBar();
        const dl = _getDownloadBar();
        const items = _getItemsBar();
        if (dl) dl.style.width = "0%";
        if (gen) gen.style.width = "0%";
        if (items) items.style.width = "0%";
        document.querySelector(".loading-strip-bar-track")?.classList.remove("indeterminate");
        hideLoadingStrip();
      }
    },
    dispose() {
      controller.abort();
      i18next.off('initialized', _recomputePhaseMinWidth);
      i18next.off('languageChanged', _recomputePhaseMinWidth);
    },
  };
}
