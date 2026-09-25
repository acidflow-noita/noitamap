import { isHDRendererEnabled, setHDRendererEnabled } from "./renderer_settings";

/** Apply the same saved-setting/reload interaction as the other map controls. */
export function initHDRendererToggle(
  saveViewport: () => void,
  reload = () => window.location.reload(),
): void {
  const toggle = document.getElementById(
    "hdRendererToggle",
  ) as HTMLInputElement | null;
  if (!toggle) return;
  toggle.checked = isHDRendererEnabled();
  toggle.addEventListener("change", () => {
    setHDRendererEnabled(toggle.checked);
    toggle.blur();
    setTimeout(() => {
      // Flush the current camera state before reloading; the ordinary URL
      // writer is debounced and may still be waiting after a quick pan.
      saveViewport();
      reload();
    }, 50);
  });
}
