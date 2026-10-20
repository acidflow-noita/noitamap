// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { installProNavbarDismissal } from '../src/pro-sidebar-navbar';
import { requestProSidebar } from '../src/pro-sidebar-intent';

const { hide } = vi.hoisted(() => ({ hide: vi.fn(async () => {}) }));
vi.mock('../src/bootstrap', () => ({ Drawer: { getOrCreateInstance: () => ({ hide }) } }));
let dispose: () => void;
beforeEach(() => {
  hide.mockClear();
  document.body.innerHTML = '<dialog id="collapsibleMapMenu" open></dialog>';
  dispose = installProNavbarDismissal();
});
afterEach(() => { dispose(); document.body.replaceChildren(); requestProSidebar('drawing', false); requestProSidebar('report', false); });

it('closes the navbar when drawing or report opens, leaving closed desktop navigation alone', () => {
  requestProSidebar('drawing', true);
  expect(hide).toHaveBeenCalledOnce();
  const drawer = document.querySelector('dialog')!;
  drawer.removeAttribute('open');
  drawer.dispatchEvent(new Event('hidden.bs.drawer'));
  requestProSidebar('report', true);
  expect(hide).toHaveBeenCalledOnce();
  drawer.dispatchEvent(new Event('shown.bs.drawer'));
  expect(hide).toHaveBeenCalledOnce();
});

it('finishes dismissing a drawer whose opening transition was still running', () => {
  requestProSidebar('report', true);
  const drawer = document.querySelector('dialog')!;
  drawer.dispatchEvent(new Event('shown.bs.drawer'));
  expect(hide).toHaveBeenCalledTimes(2);
  drawer.dispatchEvent(new Event('hidden.bs.drawer'));
  drawer.dispatchEvent(new Event('shown.bs.drawer'));
  expect(hide).toHaveBeenCalledTimes(2);
});
