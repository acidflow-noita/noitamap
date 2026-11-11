import Combobox from '../bootstrap-combobox';
import { bindAttribute, bindText, guessrLocale, tr } from './i18n';
import { resultImageShare, type ResultShareControl } from './result-share';
import { streamShareData } from './stream-share-data';
import { streamResultNames } from './stream-display-name';
import type { StreamResult } from './stream-types';

let pickerId = 0;
export function streamResultShare(result: StreamResult, viewerId?: string): ResultShareControl | null {
  result = streamResultNames(result);
  // A public result needs no sign-in to select an existing player's card.
  let selected = result.players.some(player => player.id === viewerId) ? viewerId! : result.host.id;
  if (!streamShareData(result, selected)) return null;
  return resultImageShare({
    render: async () => {
      const data = streamShareData(result, selected);
      if (!data) throw Error('Invalid completed result.');
      const { streamShareLabels, renderStreamShareImage } = await import('./stream-share-image');
      const labels = streamShareLabels(data, guessrLocale(), tr);
      return { blob: await renderStreamShareImage(labels), filename: data.filename,
        title: `NoitaGuessr, ${data.player.name}`, alt: [labels.title, labels.date, labels.headline,
          labels.player.name, labels.player.total, labels.player.rank,
          ...(data.kind === 'chatter' ? [labels.streamer.name, labels.streamer.total, labels.streamer.rank] : [labels.outscored])].filter(Boolean).join(', ') };
    },
    controls: refresh => {
      const element = document.createElement('div'); element.className = 'result-share-player';
      const label = bindText(document.createElement('span'), 'Player'); label.id = `result-share-player-${++pickerId}`;
      const picker = document.createElement('div'); picker.className = 'combobox';
      const toggle = document.createElement('button'); toggle.type = 'button';
      toggle.className = 'btn btn-outline theme-secondary combobox-toggle'; toggle.dataset.bsToggle = 'combobox';
      toggle.setAttribute('role', 'combobox'); toggle.setAttribute('aria-haspopup', 'listbox');
      toggle.setAttribute('aria-expanded', 'false'); toggle.setAttribute('aria-labelledby', label.id);
      const value = document.createElement('span'); value.className = 'combobox-value'; toggle.append(value);
      const menu = document.createElement('div'); menu.className = 'menu'; menu.id = label.id + '-options';
      menu.setAttribute('role', 'listbox'); toggle.setAttribute('aria-controls', menu.id);
      const search = document.createElement('input'); search.type = 'search'; search.className = 'form-control combobox-search-input';
      bindAttribute(search, 'placeholder', 'Find a player'); bindAttribute(search, 'aria-label', 'Find a player');
      menu.append(search);
      for (const player of result.players) {
        const option = document.createElement('button'); option.type = 'button'; option.className = 'menu-item';
        option.dataset.bsValue = player.id; option.textContent = player.name; option.tabIndex = -1;
        option.setAttribute('role', 'option'); option.classList.toggle('selected', player.id === selected);
        option.setAttribute('aria-selected', String(player.id === selected)); menu.append(option);
      }
      picker.append(toggle, menu); element.append(label, picker);
      const combobox = new Combobox(toggle, { search: true, placement: 'bottom-start' });
      const choose = (event: Event) => {
        const id = (event as Event & { value?: string }).value;
        if (id && id !== selected && result.players.some(player => player.id === id)) { selected = id; refresh(); }
      };
      toggle.addEventListener('change.bs.combobox', choose);
      return { element, destroy: () => { combobox.dispose(); toggle.removeEventListener('change.bs.combobox', choose); } };
    },
  });
}
