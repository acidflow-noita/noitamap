// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { updateOverflowMenu } from '../src/overflow-menu';

const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');
const css = readFileSync(resolve(process.cwd(), 'public/css/style.css'), 'utf8');
let style: HTMLStyleElement;
beforeEach(() => {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  const controls = document.createElement('nav'); controls.className = 'navbar';
  for (const id of ['perfModeDropdown', 'more-menu']) controls.append(parsed.getElementById(id)!);
  document.body.append(controls);
  style = document.createElement('style');
  style.textContent = css; document.head.append(style);
});
afterEach(() => { updateOverflowMenu('regular-main-branch'); document.body.replaceChildren(); style.remove(); });

describe('Performance submenu in the overflow menu', () => {
  it('expands in normal flow instead of being clipped below its scrolling parent', () => {
    const original = document.getElementById('perfModeDropdown')!;
    const input = original.querySelector<HTMLInputElement>('#lightModeToggle')!;
    input.checked = true;
    updateOverflowMenu('dynamic-main-branch');
    expect(original.parentElement?.id).toBe('more-menu-controls');
    const menu = original.querySelector<HTMLElement>('.dropdown-menu')!;
    menu.classList.add('show');
    // jsdom validates selector/cascade, not browser layout or Popper geometry.
    const computed = getComputedStyle(menu);
    expect(computed.position).toBe('static');
    expect(computed.transform).toBe('none');
    expect(computed.overflow).toBe('visible');
    expect(computed.maxHeight).toBe('none');
    expect(getComputedStyle(original).flexBasis).toBe('100%');
    expect(getComputedStyle(menu.querySelector('.dropdown-item')!).whiteSpace).toBe('normal');
    updateOverflowMenu('regular-main-branch');
    expect(original.parentElement?.className).toBe('navbar');
    expect(original.querySelector('#lightModeToggle')).toBe(input);
    expect(input.checked).toBe(true);
    expect(getComputedStyle(menu).position).not.toBe('static');
  });
  it('scopes the mobile scroll/anchor rule to the outer menu, not nested dropdowns', () => {
    const media = Array.from(style.sheet!.cssRules).filter(rule => rule instanceof CSSMediaRule) as CSSMediaRule[];
    const mobile = media.find(rule => rule.conditionText === '(max-width: 575px)')!;
    const rules = Array.from(mobile.cssRules) as CSSStyleRule[];
    const outer = rules.find(rule => rule.selectorText === '#more-menu > .dropdown-menu')!;
    expect(outer.style.getPropertyValue('overflow-y')).toBe('auto');
    expect(rules.some(rule => rule.selectorText === '#more-menu .dropdown-menu')).toBe(false);
    expect(document.getElementById('moreMenuButton')!.dataset.bsAutoClose).toBe('outside');
    expect(document.getElementById('perfModeButton')!.dataset.bsAutoClose).toBe('outside');
  });
});
