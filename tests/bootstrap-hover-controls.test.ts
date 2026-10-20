// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { Popover, Menu } from '../src/bootstrap';

const dispose: (() => void)[] = [];
afterEach(() => {
  dispose.splice(0).forEach(fn => fn());
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('Bootstrap hover help preserves native control activation', () => {
  it.each(['biomeBoundariesToggler', 'spoilerFreeToggle'])(
    'clicking the visible %s label toggles its real input exactly once', id => {
      const parsed = new DOMParser().parseFromString(readFileSync('index.html', 'utf8'), 'text/html');
      const label = parsed.querySelector<HTMLLabelElement>(`label[for="${id}"]`)!;
      document.body.append(label);
      const input = label.querySelector('input')!;
      const changes = vi.fn();
      input.addEventListener('change', changes);
      const popover = new Popover(label, { animation: false });
      dispose.push(() => popover.dispose());
      label.click();
      expect(input.checked).toBe(true);
      expect(changes).toHaveBeenCalledTimes(1);
      label.click();
      expect(input.checked).toBe(false);
      expect(changes).toHaveBeenCalledTimes(2);
    },
  );

  it('adapts older Pro hover labels before the vendor capture handler can cancel their click', () => {
    document.body.innerHTML = '<label data-bs-toggle="popover" data-bs-trigger="hover focus"><input type="checkbox"><span>Drawing</span></label>';
    const label = document.querySelector('label')!, input = label.querySelector('input')!;
    const popover = new Popover(label, { title: 'Drawing tools', animation: false });
    dispose.push(() => popover.dispose());
    expect(label.hasAttribute('data-bs-toggle')).toBe(false);
    expect(label.hasAttribute('data-noitamap-popover')).toBe(true);
    label.querySelector('span')!.click();
    expect(input.checked).toBe(true);
  });

  it('preserves native radio selection in the Pro drawing controls', () => {
    document.body.innerHTML = '<label data-noitamap-popover data-bs-trigger="hover"><input type="radio" name="tool" value="move" checked>Move</label><label data-noitamap-popover data-bs-trigger="hover"><input type="radio" name="tool" value="line">Line</label>';
    for (const label of document.querySelectorAll('label')) {
      const popover = new Popover(label, { title: label.textContent!, animation: false });
      dispose.push(() => popover.dispose());
    }
    document.querySelectorAll('label')[1].click();
    expect(document.querySelector<HTMLInputElement>('input:checked')!.value).toBe('line');
  });

  it('does not cancel link activation and leaves the Menu data API installed', () => {
    document.body.innerHTML = '<a href="#target" data-noitamap-popover data-bs-trigger="hover focus">Open</a><button type="button" data-bs-toggle="menu">Menu</button><div class="menu"><button class="menu-item">Item</button></div>';
    const link = document.querySelector('a')!, toggle = document.querySelector('button')!;
    const popover = new Popover(link, { title: 'Open location', animation: false });
    const menu = new Menu(toggle);
    dispose.push(() => popover.dispose(), () => menu.dispose());
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    expect(link.dispatchEvent(event)).toBe(true);
    expect(event.defaultPrevented).toBe(false);
    const activate = vi.spyOn(menu, 'toggle').mockResolvedValue();
    toggle.click();
    expect(activate).toHaveBeenCalledOnce();
  });
});
