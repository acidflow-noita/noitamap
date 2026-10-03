import { isGLTerrainEnabled, setGLTerrain } from "./renderer_settings";

/** This control is for LIVE generation only. Hide the whole wrapper while the
 * bake probe is pending or a bake is displayed; do not change the saved setting
 * merely because a daily/previous-daily map already contains final pixels. */
export function createFullPixelToggle(
  input: HTMLInputElement,
  container: HTMLElement,
  translate: (key: string) => string,
  reload: () => void,
) {
  let baked: boolean | null = null;
  const refresh = () => {
    container.hidden = baked !== false;
    input.checked = isGLTerrainEnabled();
    input.disabled = baked !== false;
    const description = translate("fullPixels.description");
    container.title = description;
    input.title = description;
    input.setAttribute("aria-description", description);
    for (const label of input.labels ?? []) label.title = description;
    // No focusable hidden wrapper or stale 'already baked' tooltip.
    container.removeAttribute("tabindex");
    container.removeAttribute("aria-label");
  };
  const change = () => {
    if (baked !== false) {
      refresh();
      return;
    }
    setGLTerrain(input.checked);
    reload();
  };
  input.addEventListener("change", change);
  refresh();
  return {
    setBaked(value: boolean) {
      baked = value;
      refresh();
    },
    refresh,
    dispose() {
      input.removeEventListener("change", change);
    },
  };
}
