import Combobox, { setupComboboxToggle } from './bootstrap-combobox';
import { MAX_NG_PLUS } from './data_sources/tile_data';

export function createNGPlusLevelPicker(onChange: (level: number) => void) {
  const element = document.createElement('div');
  element.className = 'position-relative ng-plus-level-picker';
  element.innerHTML = `<button id="dynamicNGPlusLevel" type="button" class="form-control form-control-sm"></button>
  <div class="menu" id="dynamicNGPlusLevels" role="listbox" aria-labelledby="dynamicNGPlusLevel"></div>`;
  const button = element.querySelector('button')!;
  const menu = element.querySelector<HTMLElement>('.menu')!;
  const value = setupComboboxToggle(button, menu.id);
  const options: HTMLButtonElement[] = [];
  for (let level = 1; level <= MAX_NG_PLUS; level++) {
    const option = document.createElement('button');
    option.type = 'button';
    option.className = 'menu-item';
    option.dataset.bsValue = String(level);
    option.setAttribute('role', 'option');
    option.setAttribute('aria-selected', String(level === 1));
    option.classList.toggle('selected', level === 1);
    option.tabIndex = -1;
    option.textContent = `NG+${level}`;
    options.push(option);
    menu.append(option);
  }
  const combobox = new Combobox(button, { placement: 'bottom-start' });
  let current = 1;
  function setLevel(level: number) {
    if (current === level || !options[level - 1]) return;
    const previous = options[current - 1], next = options[level - 1];
    previous.classList.remove('selected');
    previous.setAttribute('aria-selected', 'false');
    next.classList.add('selected');
    next.setAttribute('aria-selected', 'true');
    value.textContent = next.textContent;
    current = level;
  }
  button.addEventListener('change.bs.combobox', event => {
    const level = Number((event as Event & { value: string }).value);
    if (button.disabled || level === current || !options[level - 1]) return;
    setLevel(level);
    onChange(level);
  });
  return { element, button, setLevel, close: () => combobox.hide() };
}
