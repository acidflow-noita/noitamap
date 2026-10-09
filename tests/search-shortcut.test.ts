// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installSearchShortcut, type SearchShortcut } from '../src/search/search-shortcut';

describe('map search keyboard shortcut', () => {
  let input: HTMLInputElement;
  let shortcut: SearchShortcut;
  const press = (key = '/', options: KeyboardEventInit = {}, target: EventTarget = document.body) => {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options });
    target.dispatchEvent(event);
    return event;
  };

  beforeEach(() => {
    document.body.innerHTML = '<form id="search-form"><input type="search" placeholder="Search"></form>';
    input = document.querySelector('input')!;
    input.value = 'old query';
    shortcut = installSearchShortcut(input, 'Focus search: /, Ctrl+/ or ⌘+/');
  });
  afterEach(() => { shortcut.dispose(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

  it.each([{}, { ctrlKey: true }, { metaKey: true }, { shiftKey: true, code: 'Digit7' }])(
    'cancels the browser slash action and focuses/selects search with %j', options => {
      const event = press('/', options);
      expect(event.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(input);
      expect(input.value).toBe('old query');
      expect(input.selectionStart).toBe(0);
      expect(input.selectionEnd).toBe(input.value.length);
    },
  );

  it.each(['input', 'textarea', 'select', 'div contenteditable="true"', 'div contenteditable="plaintext-only"', 'div role="textbox"']) (
    'leaves editing in %s alone', markup => {
      const tag = markup.split(' ')[0];
      const container = document.createElement('div');
      container.innerHTML = `<${markup}></${tag}>`;
      document.body.appendChild(container);
      const editor = container.firstElementChild!;
      expect(press('/', {}, editor).defaultPrevented).toBe(false);
      expect(document.activeElement).not.toBe(input);
    },
  );

  it('does not intercept slashes already typed into search', () => {
    input.focus();
    expect(press('/', {}, input).defaultPrevented).toBe(false);
  });

  it.each([
    { altKey: true }, { ctrlKey: true, altKey: true }, { ctrlKey: true, metaKey: true },
    { isComposing: true }, { repeat: true }, { keyCode: 229 }, { cancelable: false },
  ])('respects composition, modifiers and repeated keys: %j', options => {
    expect(press('/', options).defaultPrevented).toBe(false);
    expect(document.activeElement).not.toBe(input);
  });

  it('does not use the physical slash key for other keyboard-layout characters', () => {
    expect(press('?', { code: 'Slash', shiftKey: true }).defaultPrevented).toBe(false);
    expect(press('-', { code: 'Slash' }).defaultPrevented).toBe(false);
    expect(document.activeElement).not.toBe(input);
  });

  it('respects earlier cancellation', () => {
    const event = new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true });
    event.preventDefault();
    document.body.dispatchEvent(event);
    expect(document.activeElement).not.toBe(input);
  });

  it.each(['<dialog open></dialog>', '<div role="dialog" aria-modal="true"></div>']) (
    'does not move focus out from an open modal: %s', markup => {
      document.body.insertAdjacentHTML('beforeend', markup);
      expect(press().defaultPrevented).toBe(false);
      expect(document.activeElement).not.toBe(input);
    },
  );

  it('ignores hidden modals but unavailable search leaves browser shortcuts alone', () => {
    document.body.insertAdjacentHTML('beforeend', '<div aria-modal="true" hidden></div>');
    input.disabled = true;
    expect(press().defaultPrevented).toBe(false);
    input.disabled = false;
    input.parentElement!.hidden = true;
    expect(press().defaultPrevented).toBe(false);
    input.parentElement!.hidden = false;
    expect(press().defaultPrevented).toBe(true);
  });

  it('consumes shortcut repeat and keyup without treating them as query edits', () => {
    const edit = vi.fn();
    input.addEventListener('keyup', edit);
    press();
    expect(press('/', { repeat: true }, input).defaultPrevented).toBe(true);
    const release = new KeyboardEvent('keyup', { key: '/', bubbles: true, cancelable: true });
    input.dispatchEvent(release);
    expect(release.defaultPrevented).toBe(true);
    expect(edit).not.toHaveBeenCalled();
    expect(press('/', {}, input).defaultPrevented).toBe(false);
  });

  it('pairs keyup even when Shift was released before a non-US slash-producing key', () => {
    const edit = vi.fn();
    input.addEventListener('keyup', edit);
    press('/', { shiftKey: true, code: 'Digit7' });
    input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift', code: 'ShiftLeft', bubbles: true }));
    edit.mockClear();
    input.dispatchEvent(new KeyboardEvent('keyup', { key: '7', code: 'Digit7', bubbles: true, cancelable: true }));
    expect(edit).not.toHaveBeenCalled();
    input.dispatchEvent(new KeyboardEvent('keyup', { key: '/', code: 'Digit7', bubbles: true, cancelable: true }));
    expect(edit).toHaveBeenCalledOnce();
  });

  it('does not treat the shortcut modifier release as editing the query', () => {
    const edit = vi.fn();
    input.addEventListener('keyup', edit);
    press('/', { ctrlKey: true });
    input.dispatchEvent(new KeyboardEvent('keyup', { key: '/', ctrlKey: true, bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Control', bubbles: true }));
    expect(edit).not.toHaveBeenCalled();
  });

  it('reveals the collapsed mobile toolbar before focusing', () => {
    const menu = document.createElement('div');
    menu.className = 'navbar-collapse';
    menu.style.display = 'none';
    input.parentElement!.before(menu);
    menu.appendChild(input.parentElement!);
    const show = vi.fn(() => { menu.style.display = 'block'; });
    vi.stubGlobal('bootstrap', { Collapse: { getOrCreateInstance: () => ({ show }) } });
    expect(press().defaultPrevented).toBe(true);
    expect(show).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(input);
  });

  it('keeps one visible, translated hint and one listener after reinstallation', () => {
    shortcut = installSearchShortcut(input, 'Rechercher');
    shortcut.updateHint('Suche');
    const hints = document.querySelectorAll<HTMLButtonElement>('.search-shortcut-hint');
    expect(hints).toHaveLength(1);
    expect(hints[0].title).toBe('Suche');
    expect(hints[0].getAttribute('aria-label')).toBe('Suche');
    expect(input.getAttribute('aria-description')).toBe('Suche');
    expect(input.getAttribute('aria-keyshortcuts')).toBe('/ Control+/ Meta+/');
    hints[0].click();
    expect(document.activeElement).toBe(input);
    input.blur();
    shortcut.dispose();
    expect(press().defaultPrevented).toBe(false);
  });
});
