import { mountLanguageSelector } from '../language-selector-core';
import { tr } from './i18n';

let pickerId = 0;
const disposers = new WeakMap<HTMLElement, () => void>();
/** Uses the map's language list, flags, preference storage and detector. */
export function createGuessrLanguagePicker(): HTMLDivElement {
  const picker = document.createElement('div');
  picker.className = 'guessr-language-picker';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn btn-outline theme-secondary combobox-toggle';
  button.dataset.bsToggle = 'combobox';
  button.dataset.bsPlacement = 'bottom-start';
  button.setAttribute('aria-expanded', 'false');
  button.setAttribute('aria-haspopup', 'listbox');
  const menu = document.createElement('div');
  menu.className = 'menu';
  menu.id = `guessr-languages-${++pickerId}`;
  button.setAttribute('aria-controls', menu.id);
  picker.append(button, menu);
  const selector = mountLanguageSelector({ button, menu, label: language => tr('Language: {{language}}', { language }) });
  disposers.set(picker, () => {
    selector.destroy();
  });
  return picker;
}

/** Call before replacing a header so Bootstrap releases an opened menu. */
export function disposeGuessrLanguagePickers(root: ParentNode): void {
  for (const picker of root.querySelectorAll<HTMLElement>('.guessr-language-picker')) {
    disposers.get(picker)?.();
    disposers.delete(picker);
  }
}
