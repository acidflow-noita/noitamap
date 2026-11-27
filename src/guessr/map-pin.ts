import artwork from '../../public/assets/noitaguessr-pin.svg?raw';

// Guess pins use the supplied logo, anchored at its tip. The solution target
// is centred on the coordinate. Sizes stay fixed in CSS pixels while zooming.
export const MAP_PIN_PATH = artwork.match(/<path\s+d="([^"]+)"/)![1];
export const MAP_PIN_TIP = { x: 25.7384, y: 63.1753 };
export const ANSWER_PIN_CENTER = { x: 32, y: 32 };
export const GUESS_PIN_COLOR = 'var(--guessr-guess-color)';
export const ANSWER_PIN_COLOR = 'var(--guessr-clue-color)';
export const GUESS_PIN_HEIGHT = 44;
export const ANSWER_PIN_HEIGHT = 52;
export const PLAYER_PIN_HEIGHT = 36;
export const HIGHLIGHT_PIN_HEIGHT = 48;

export function mapPinIcon(role: 'clue' | 'guess'): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const icon = document.createElementNS(ns, 'svg');
  icon.setAttribute('viewBox', '0 0 52 64');
  icon.setAttribute('aria-hidden', 'true');
  icon.setAttribute('focusable', 'false');
  icon.classList.add(role + '-pin-icon');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', MAP_PIN_PATH);
  path.setAttribute('fill-rule', 'evenodd');
  path.setAttribute('fill', role === 'clue' ? ANSWER_PIN_COLOR : GUESS_PIN_COLOR);
  icon.append(path);
  return icon;
}
