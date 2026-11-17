import logo from '../../public/assets/noitaguessr-logo.svg?raw';
import Menu from 'bootstrap/js/dist/menu.js';
import { bindAttribute, bindText, clearTextBinding, tr } from './i18n';
import { hoverHelp } from './hover-help';

type Connection = 'idle' | 'connected' | 'connecting' | 'reconnecting' | 'offline' | 'disconnected';
const indicators = new WeakMap<HTMLElement, (state: Connection, detail?: string) => void>();

export function gameLogo(onHome: () => void) {
  const shell = document.createElement('div'); shell.className = 'guessr-logo';
  const home = document.createElement('a'); home.className = 'brand'; home.href = '/guess/';
  const svg = new DOMParser().parseFromString(logo, 'image/svg+xml').documentElement;
  svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', 'NoitaGuessr');
  const group = document.createElementNS('http://www.w3.org/2000/svg', 'g'); group.classList.add('logo-state'); group.setAttribute('aria-hidden', 'true');
  for (const [name, radius] of [['state-dot', '6.6'], ['state-orbit', '7.2']]) {
    const circle = document.createElementNS(group.namespaceURI, 'circle');
    for (const [key, value] of Object.entries({ cx: '103.194', cy: '40.806', r: radius, class: name })) circle.setAttribute(key, value);
    group.append(circle);
  }
  svg.append(group); home.append(document.importNode(svg, true));
  home.onclick = event => { event.preventDefault(); onHome(); };
  const indicator = document.createElement('button'); indicator.type = 'button'; indicator.className = 'logo-status-trigger';
  indicator.dataset.gameConnection = ''; const status = document.createElement('span'); status.className = 'sr-only'; status.setAttribute('role', 'status');
  indicator.append(status); indicator.onclick = () => indicator.focus();
  let state: Connection = 'idle', detail = '';
  const label = () => tr(detail || ({ idle: 'No active game connection.', connected: 'Connected', connecting: 'Connecting…',
    reconnecting: 'Reconnecting…', offline: 'You are offline. Reconnect to continue.', disconnected: 'Disconnected' })[state]);
  const help = hoverHelp(indicator, label);
  bindAttribute(indicator, 'aria-label', label); bindText(status, label);
  const update = (next: Connection, nextDetail = '') => {
    if (state === next && detail === nextDetail && home.querySelector('.logo-state')!.hasAttribute('data-state')) return;
    state = next; detail = nextDetail; home.querySelector<SVGGElement>('.logo-state')!.dataset.state = state;
    bindAttribute(indicator, 'aria-label', label); bindText(status, label); help.update();
  };
  indicators.set(indicator, update); update('idle'); shell.append(home, indicator);
  return { element: shell, dispose() { help.dispose(); indicators.delete(indicator); } };
}

/** Reuses existing transport events. It never opens a health-check connection. */
export function updateGameConnection(state: Connection, detail = '') {
  const indicator = document.querySelector<HTMLElement>('[data-game-connection]');
  if (indicator) indicators.get(indicator)?.(state, detail);
}

/** Put secondary links in a menu when six full-size touch targets would crowd the wordmark. */
export function compactHeaderNavigation(back: HTMLAnchorElement, help: HTMLButtonElement) {
  const compact = window.matchMedia?.('(max-width: 25rem)');
  if (!compact) return;
  const identity = back.parentElement!;
  const group = document.createElement('div');
  group.className = 'guessr-nav';
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'small secondary with-icon guessr-nav-toggle';
  toggle.dataset.bsToggle = 'menu';
  toggle.dataset.bsPlacement = 'bottom-end';
  toggle.setAttribute('aria-controls', 'guessr-nav-links');
  toggle.setAttribute('aria-expanded', 'false');
  bindAttribute(toggle, 'aria-label', 'Navigation menu');
  bindAttribute(toggle, 'title', 'Navigation menu');
  const icon = document.createElement('i');
  icon.className = 'bi bi-list';
  icon.setAttribute('aria-hidden', 'true');
  toggle.append(icon);
  const menu = document.createElement('div');
  menu.id = 'guessr-nav-links';
  menu.className = 'menu';
  group.append(toggle, menu);
  help.before(group);

  const layout = () => {
    const focused = document.activeElement;
    group.hidden = !compact.matches;
    if (compact.matches) {
      menu.append(back, help);
    } else if (help.parentElement === menu) {
      void Menu.getInstance(toggle)?.hide();
      identity.append(back);
      group.after(help);
    }
    back.classList.toggle('menu-item', compact.matches);
    help.classList.toggle('menu-item', compact.matches);
    if (focused === back || focused === help || focused === toggle) {
      const direct = focused === back ? back : help;
      (compact.matches ? toggle : direct).focus({ preventScroll: true });
    }
  };
  layout();
  compact.addEventListener('change', layout);
  return () => {
    compact.removeEventListener('change', layout);
    Menu.getInstance(toggle)?.dispose();
  };
}

export function moveGameExit(main: HTMLElement, exit: HTMLButtonElement) {
  const actions = main.parentElement?.querySelector('.header-actions');
  if (!actions) return;
  clearTextBinding(exit);
  const icon = document.createElement('i'); icon.className = 'bi bi-box-arrow-right'; icon.setAttribute('aria-hidden', 'true');
  exit.replaceChildren(icon, bindText(document.createElement('span'), 'Exit game'));
  bindAttribute(exit, 'aria-label', 'Exit game'); bindAttribute(exit, 'title', 'Exit game');
  exit.classList.add('guessr-exit', 'with-icon'); actions.insertBefore(exit, actions.querySelector('.guessr-account'));
}
