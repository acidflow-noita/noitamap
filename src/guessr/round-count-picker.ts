import Combobox, { setupComboboxToggle } from '../bootstrap-combobox';
import { bindText, formatGuessrNumber, tr } from './i18n';
import { newFeatureBadge } from './release-features';
import { STREAM_ROUND_OPTIONS, validStreamRoundCount } from './stream-types';

let pickerId = 0;
export function roundCountPicker(initial: number, change: (rounds: number) => void) {
  let selected = initial;
  const element = document.createElement('div');
  element.className = 'stream-length-setting';
  const label = document.createElement('label');
  const id = 'guessr-round-count-' + ++pickerId;
  label.htmlFor = id;
  label.append(bindText(document.createElement('span'), 'Number of rounds'), ' ', newFeatureBadge('roundCount'));
  const field = document.createElement('div');
  field.className = 'combobox position-relative';
  const toggle = document.createElement('button');
  toggle.type = 'button'; toggle.id = id; toggle.className = 'btn btn-outline theme-secondary';
  const menu = document.createElement('div');
  menu.className = 'menu'; menu.id = id + '-options'; menu.setAttribute('role', 'listbox');
  menu.setAttribute('aria-labelledby', id);
  const value = setupComboboxToggle(toggle, menu.id);
  const roundsLabel = (count: number) => tr('{{rounds}} rounds', { rounds: formatGuessrNumber(count), count });
  for (const count of STREAM_ROUND_OPTIONS) {
    const option = bindText(document.createElement('button'), () => roundsLabel(count));
    option.type = 'button'; option.className = 'menu-item'; option.tabIndex = -1;
    option.dataset.bsValue = String(count); option.setAttribute('role', 'option');
    option.setAttribute('aria-selected', String(count === selected)); option.classList.toggle('selected', count === selected);
    menu.append(option);
  }
  field.append(toggle, menu); element.append(label, field);
  const combo = new Combobox(toggle, { placement: 'bottom-start' });
  bindText(value, () => roundsLabel(selected));
  toggle.addEventListener('change.bs.combobox', event => {
    const count = Number((event as Event & { value: string }).value);
    if (!validStreamRoundCount(count) || toggle.matches(':disabled') || count === selected) return;
    selected = count;
    change(count);
  });
  return { element, destroy: () => combo.dispose() };
}
