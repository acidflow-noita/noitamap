import icons from "./bootstrap-icons.json";
import { bindAttribute } from "./i18n";
import { setText, type LocalizedText } from './messages';

export type ControlIcon = keyof typeof icons;

/** Keep the translated label in its own node so language changes retain the SVG. */
export function iconLabel(icon: ControlIcon, label: LocalizedText): DocumentFragment {
  const content = document.createElement('template');
  content.innerHTML = icons[icon];
  const svg = content.content.querySelector('svg')!;
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const text = document.createElement('span');
  setText(text, label);
  content.content.append(text);
  return content.content;
}

/** Bootstrap Icons v1.13.1, matching the main site's icon set. Inlined so the
 * standalone dataset preview does not depend on an external font request. */
export function setControlIcon(
  button: HTMLButtonElement,
  icon: keyof typeof icons,
  label: string,
  nativeTitle = true,
): void {
  button.innerHTML = icons[icon];
  button.classList.add("icon-button");
  bindAttribute(button, "aria-label", label);
  if (nativeTitle) bindAttribute(button, "title", label);
  const svg = button.querySelector("svg")!;
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
}
