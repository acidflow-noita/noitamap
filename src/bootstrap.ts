// Import the plugins used by the map. The package barrel also imports optional
// components such as Datepicker, which this application does not use.
import Dialog from 'bootstrap/js/dist/dialog.js';
import Drawer from 'bootstrap/js/dist/drawer.js';
import Menu from 'bootstrap/js/dist/menu.js';
import BootstrapPopover from 'bootstrap/js/dist/popover.js';
import Tooltip from 'bootstrap/js/dist/tooltip.js';
import Toast from 'bootstrap/js/dist/toast.js';

export { Dialog, Drawer, Menu, Tooltip, Toast };

/** Bootstrap 6's popover data API cancels native clicks even when an existing
 * instance only uses hover/focus. App help uses its own marker and explicit
 * initialization. Migrate markers from older hosted Pro bundles as well. */
export class Popover extends BootstrapPopover {
  constructor(element?: string | Element | null, config?: ConstructorParameters<typeof BootstrapPopover>[1]) {
    const trigger = typeof element === 'string' ? document.querySelector(element) : element;
    if (trigger?.getAttribute('data-bs-toggle') === 'popover') {
      trigger.setAttribute('data-noitamap-popover', '');
      trigger.removeAttribute('data-bs-toggle');
    }
    super(trigger, config);
  }
}

/** The independently deployed Pro report still creates v5 dropdown markup.
 * Adapt that small public integration boundary to v6; the map uses Menu
 * directly and never loads a second Bootstrap runtime. */
export class ProDropdown extends Menu {
  constructor(element?: string | Element | null, options: Record<string, any> = {}) {
    const toggle = typeof element === 'string' ? document.querySelector(element) : element;
    if (toggle instanceof HTMLElement) {
      toggle.setAttribute('data-bs-toggle', 'menu');
      toggle.classList.add('btn-outline', 'theme-secondary');
      let menu = toggle.parentElement?.querySelector<HTMLElement>('.dropdown-menu');
      if (menu) {
        if (menu.tagName === 'UL') {
          const flat = document.createElement('div');
          for (const attribute of menu.attributes) flat.setAttribute(attribute.name, attribute.value);
          flat.append(...menu.childNodes);
          menu.replaceWith(flat);
          menu = flat;
        }
        menu.classList.add('menu');
        for (const item of menu.querySelectorAll(':scope > li')) item.replaceWith(...item.childNodes);
        for (const item of menu.querySelectorAll('.dropdown-item')) item.classList.add('menu-item');
        for (const item of menu.querySelectorAll('.dropdown-divider')) item.classList.add('menu-divider');
        for (const item of menu.querySelectorAll('.dropdown-header')) item.classList.add('menu-header');
      }
    }
    const { popperConfig, ...config } = options;
    if (config.boundary === 'viewport') delete config.boundary;
    if (popperConfig?.strategy) config.strategy = popperConfig.strategy;
    super(toggle, config);
  }
}

export function installProBootstrapBridge(): void {
  (window as any).bootstrap = { Dialog, Drawer, Menu, Popover, Tooltip, Toast, Dropdown: ProDropdown };
}
