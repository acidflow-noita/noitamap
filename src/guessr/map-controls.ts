import type { MapBoard } from './map-board';
import { bindAttribute, bindText } from './i18n';
import { iconLabel } from './control-icons';

/** These controls change the free guess map, never the clue's point allowance. */
export function mapControls(board: MapBoard): HTMLElement {
  const row = document.createElement('div'); row.className = 'guess-map-controls';
  row.setAttribute('role', 'group'); bindAttribute(row, 'aria-label', 'Map navigation controls');
  for (const [label, action, icon] of [
    ['Zoom in', () => board.zoom(1.6), 'zoom-in'],
    ['Zoom out', () => board.zoom(1 / 1.6), 'zoom-out'],
    ['Show entire map', () => board.showEntireMap(), 'arrow-counterclockwise'],
    ['Center map on marker', () => board.centerOnPin(), null],
  ] as const) {
    const button = document.createElement('button'); button.type = 'button';
    button.className = 'btn btn-sm btn-outline theme-secondary'; bindAttribute(button, 'aria-label', label);
    if (icon) { button.append(iconLabel(icon, label)); if (icon.startsWith('zoom')) button.querySelector('span')!.classList.add('sr-only'); }
    else {
      const icon = document.createElement('img'); icon.src = '/assets/noitaguessr-pin.svg'; icon.alt = ''; icon.width = 18; icon.height = 22;
      const text = bindText(document.createElement('span'), label); button.append(icon, text);
      board.onPinChange(placed => { button.disabled = !placed; });
    }
    button.onclick = action; row.append(button);
  }
  return row;
}
