import BootstrapCombobox from 'bootstrap/js/dist/combobox.js';
import Menu from 'bootstrap/js/dist/menu.js';
import Data from 'bootstrap/js/dist/dom/data.js';

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
