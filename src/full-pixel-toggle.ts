import { isGLTerrainEnabled, setGLTerrain } from "./renderer_settings";

/** Reflect the displayed bake without overwriting the user's live-seed
 * preference. A URL that merely names the daily seed is not a completed bake. */
export function createFullPixelToggle(
  input: HTMLInputElement,
  container: HTMLElement,
  translate: (key: string) => string,
  reload: () => void,
) {
  let fullPixelsBaked = false;
  const refresh = () => {
    input.checked = fullPixelsBaked || isGLTerrainEnabled();
    input.disabled = fullPixelsBaked;
    const description = translate(
      fullPixelsBaked ? "fullPixels.baked" : "fullPixels.description",
    );
    // A disabled input does not reliably receive mouse/focus events. Keep the
    // explanation on its wrapper/label, and make the wrapper keyboard-focusable.
    container.title = description;
    input.title = description;
    input.setAttribute("aria-description", description);
    input.style.pointerEvents = fullPixelsBaked ? "none" : "";
    for (const label of input.labels ?? []) label.title = description;
    if (fullPixelsBaked) {
      container.tabIndex = 0;
      container.setAttribute(
        "aria-label",
        `${translate("fullPixels.title")}. ${description}`,
      );
    } else {
      container.removeAttribute("tabindex");
      container.removeAttribute("aria-label");
    }
  };
  const change = () => {
    if (fullPixelsBaked) {
      refresh();
      return;
    }
    setGLTerrain(input.checked);
    reload();
  };
  input.addEventListener("change", change);
  refresh();
  return {
    setBaked(baked: boolean) {
      fullPixelsBaked = baked;
      refresh();
    },
    refresh,
    dispose() {
      input.removeEventListener("change", change);
    },
  };
}
