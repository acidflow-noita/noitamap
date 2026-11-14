import i18next from "./i18n";
import { isGuessrAvailable } from "./guessr-availability";

/** The same navbar control and Pro accent as the seed report. Opening Guessr
 * does not fetch the Pro bundle; the game checks access for its paid modes. */
export function createGuessrButton(
  anchor: HTMLElement,
  location: Pick<Location, "hostname"> = window.location,
  development = import.meta.env.DEV,
): void {
  if (
    !isGuessrAvailable(location.hostname, development) ||
    document.getElementById("noitaGuessrButton")
  )
    return;
  const wrapper = document.createElement("div");
  wrapper.id = "noita-guessr-ui-wrapper";
  wrapper.className = "btn-group me-2";
  const link = document.createElement("a");
  link.id = "noitaGuessrButton";
  link.href = "/guess/";
  link.className =
    "icon-button btn btn-sm btn-outline theme-inverse text-nowrap pro-accent animation-pop has-alpha-badge";
  const title = i18next.t("guessr.title", "NoitaGuessr");
  link.setAttribute("aria-label", title);
  link.setAttribute("data-noitamap-popover", "");
  link.setAttribute("data-bs-placement", "bottom");
  link.setAttribute("data-bs-trigger", "hover focus");
  link.setAttribute("data-bs-html", "true");
  link.setAttribute("data-bs-title", '<img src="/assets/noitaguessr-logo.svg" class="guessr-popover-logo" width="160" alt="NoitaGuessr">');
  link.setAttribute("data-i18n-content", "guessr.content");
  link.setAttribute("data-bs-content", i18next.t("guessr.content", "Game modes: Daily, Demo, Chat vs Streamer, 1v1"));
  const icon = document.createElement("i");
  icon.className = "bi bi-geo-alt";
  icon.setAttribute("aria-hidden", "true");
  link.append(icon);
  wrapper.append(link);
  anchor.parentNode?.insertBefore(wrapper, anchor);
  const Popover = (window as any).bootstrap?.Popover;
  if (Popover) new Popover(link);
}
