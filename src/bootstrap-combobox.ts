import BootstrapCombobox from 'bootstrap/js/dist/combobox.js';
import Menu from 'bootstrap/js/dist/menu.js';
import Data from 'bootstrap/js/dist/dom/data.js';

/** Button contents from the Bootstrap 6 combobox example, including its stock caret.
 * https://github.com/twbs/bootstrap/blob/v6.0.0-alpha.1/site/src/content/docs/forms/combobox.mdx#example */
export function setupComboboxToggle(button: HTMLButtonElement, menuId: string): HTMLSpanElement {
  button.classList.add('combobox-toggle');
  button.dataset.bsToggle = 'combobox';
  button.setAttribute('role', 'combobox');
  button.setAttribute('aria-haspopup', 'listbox');
  button.setAttribute('aria-expanded', 'false');
  button.setAttribute('aria-controls', menuId);
  const value = document.createElement('span');
  value.className = 'combobox-value';
  button.replaceChildren(value);
  button.insertAdjacentHTML('beforeend', `<svg class="combobox-caret" width="10" height="16" viewBox="0 0 10 16" fill="none"
    xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">
    <path d="M0.46967 5.46967C0.762563 5.17678 1.23744 5.17678 1.53033 5.46967L5 8.93934L8.46967 5.46967C8.76256 5.17678 9.23744 5.17678 9.53033 5.46967C9.82322 5.76256 9.82322 6.23744 9.53033 6.53033L5.53033 10.5303C5.23744 10.8232 4.76256 10.8232 4.46967 10.5303L0.46967 6.53033C0.176777 6.23744 0.176777 5.76256 0.46967 5.46967Z" fill="currentColor"/>
  </svg>`);
  return value;
}

/** In 6.0.0-alpha.1, Combobox creates a private Menu on its own toggle, but
 * Bootstrap's registry permits only one component per element. Keep Combobox
 * registered publicly; it owns and disposes the private Menu itself. */
export default class Combobox extends BootstrapCombobox {
  protected override _createMenuInstance(): void {
    Data.remove(this._toggle, BootstrapCombobox.DATA_KEY);
    try {
      super._createMenuInstance();
    } finally {
      Data.remove(this._toggle, Menu.DATA_KEY);
      Data.set(this._toggle, BootstrapCombobox.DATA_KEY, this);
    }
  }
}
