// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import i18next from '../src/i18n';
import { UnifiedSearchResults, type UnifiedSearchResult } from '../src/search/unifiedsearchresults';

vi.mock('../src/util', () => ({ getSpellAvailability: () => '' }));
vi.mock('../src/telescope/telescope-osd-bridge', () => ({
  getPOISpriteFirstFrame: async () => null,
  getTaikasauvaIcon: () => null,
}));
vi.mock('../src/popover-util', () => ({ attachAlwaysCastPopover: vi.fn(), dismissPopovers: vi.fn() }));
vi.mock('../src/spoiler-free', () => ({ isSpoilerFree: () => false }));

let input: HTMLInputElement;
let list: HTMLUListElement;
let results: UnifiedSearchResults;
let rows: HTMLLIElement[];
const items = ['Spark bolt', 'Black hole'].map((name, index) => ({
  type: 'spell', displayName: name, displayText: name,
  spell: { id: `SPELL_${index}`, name, sprite: 'missing.png', spawnProbabilities: {} },
})) as UnifiedSearchResult[];

beforeAll(async () => { await i18next.init({ lng: 'en', resources: { en: { translation: {} } } }); });
beforeEach(() => {
  input = document.createElement('input');
  list = document.createElement('ul');
  document.body.append(input, list);
  results = new UnifiedSearchResults(list);
  results.on('blur', () => input.focus());
  results.setResults(items, 'These are matching results');
  rows = [...list.querySelectorAll<HTMLLIElement>('.search-result')];
});
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });
function key(target: HTMLElement, value: string) {
  const event = new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

it('skips notices, moves on keydown and returns focus to the search field from the first result', () => {
  results.focusNext();
  expect(document.activeElement).toBe(rows[0]);
  expect(key(rows[0], 'ArrowDown').defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(rows[1]);
  key(rows[1], 'ArrowUp');
  key(rows[0], 'ArrowUp');
  expect(document.activeElement).toBe(input);
  expect(list.querySelector('.search-result-active')).toBeNull();
});

it('keeps one highlight when switching from keyboard to pointer and submits the highlighted row', () => {
  const selected = vi.fn();
  results.on('selected', selected);
  results.focusNext();
  rows[1].dispatchEvent(new MouseEvent('pointermove', { bubbles: true }));
  expect([...list.querySelectorAll('.search-result-active')]).toEqual([rows[1]]);
  key(rows[0], 'Enter');
  expect(selected).toHaveBeenCalledExactlyOnceWith(items[1]);
});

it('does not steal typing focus when the pointer moves over a result', () => {
  input.focus();
  rows[1].dispatchEvent(new MouseEvent('pointermove', { bubbles: true }));
  expect(document.activeElement).toBe(input);
  list.dispatchEvent(new MouseEvent('pointerleave'));
  expect(list.querySelector('.search-result-active')).toBeNull();
});

it('scrolls only the results viewport and prevents the browser from scrolling the page', () => {
  vi.spyOn(list, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 20, 200, 100));
  vi.spyOn(rows[0], 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 20, 200, 50));
  vi.spyOn(rows[1], 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 120, 200, 50));
  const focus = vi.spyOn(rows[1], 'focus');
  results.focusNext();
  const event = key(rows[0], 'ArrowDown');
  expect(event.defaultPrevented).toBe(true);
  expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  expect(list.scrollTop).toBe(50);
});
