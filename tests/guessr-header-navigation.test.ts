// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { compactHeaderNavigation } from '../src/guessr/game-chrome';

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

it('keeps the original links and keyboard focus when switching header layouts', () => {
  const viewport = Object.assign(new EventTarget(), { matches: false });
  vi.stubGlobal('matchMedia', () => viewport);
  document.body.innerHTML = '<header><div><a href="/">Map</a></div><div><button>Help</button><button>Updates</button></div></header>';
  const back = document.querySelector('a')!;
  const [help, updates] = document.querySelectorAll('button');
  const identity = back.parentElement!;
  const actions = help.parentElement!;
  const dispose = compactHeaderNavigation(back, help);
  const resize = (compact: boolean) => {
    viewport.matches = compact;
    viewport.dispatchEvent(new Event('change'));
  };

  help.focus();
  resize(true);
  const toggle = actions.querySelector<HTMLButtonElement>('.guessr-nav-toggle')!;
  const menu = document.getElementById(toggle.getAttribute('aria-controls')!)!;
  expect([...menu.children]).toEqual([back, help]);
  expect(updates.parentElement).toBe(actions);
  expect(document.activeElement).toBe(toggle);

  resize(false);
  expect(back.parentElement).toBe(identity);
  expect(help.nextElementSibling).toBe(updates);
  expect(document.activeElement).toBe(help);
  dispose?.();
  resize(true);
  expect(back.parentElement).toBe(identity);
});
