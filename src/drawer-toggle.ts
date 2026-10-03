import {
  getStoredRenderer,
  setStoredRenderer,
  type RendererType,
} from "./renderer_settings";

/** Temporary drawer comparison control; remove after the rendering investigation. */
export function createDrawerToggle(
  input: HTMLInputElement,
  container: HTMLElement,
  reload: () => void,
) {
  let active: string | undefined;
  const refresh = () => {
    input.disabled = active === undefined || active === "unknown";
    input.checked = (active ?? getStoredRenderer()) === "webgl";
    const description = `On: WebGL. Off: Canvas. Reloads the map. Active: ${active ?? "initializing"}; saved preference: ${getStoredRenderer()}.`;
    container.title = input.title = description;
    input.setAttribute("aria-description", description);
    for (const label of input.labels ?? []) label.title = description;
  };
  const change = () => {
    if (input.disabled) {
      refresh();
      return;
    }
    const requested: RendererType = input.checked ? "webgl" : "canvas";
    try {
      setStoredRenderer(requested);
      if (getStoredRenderer() !== requested)
        throw new Error("Drawer preference was not retained");
    } catch (error) {
      console.error(
        "[OSD] Could not save drawer preference; keeping the active drawer:",
        active,
        error,
      );
      refresh();
      return;
    }
    console.log(
      `[OSD] Drawer change requested: ${active} -> ${requested}. Reloading; the next "Drawer initialized" log confirms the actual drawer.`,
    );
    reload();
  };
  input.addEventListener("change", change);
  refresh();
  return {
    setActive(drawer: string) {
      active = drawer;
      refresh();
    },
    dispose() {
      input.removeEventListener("change", change);
    },
  };
}
