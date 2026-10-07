// @vitest-environment jsdom
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { isDropOverlayActive, setupDropOverlay } from '../src/drop-overlay';
import { canOpenPOIFromCanvas } from '../src/drawing/poi-interaction';

let overlay: HTMLElement;
const close = vi.fn(() => document.querySelector('.marker-tooltip')?.remove());
const hooks: any = { closePOICard: close };
const settle = async () => { await Promise.resolve(); await Promise.resolve(); };
const card = () => {
  const el = document.createElement('div'); el.className = 'marker-tooltip'; document.body.append(el); return el;
};
const drag = (type: string, files = true) => {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: { types: files ? ['Files'] : ['text/plain'] } });
  document.body.dispatchEvent(event);
};

beforeAll(() => {
  vi.stubGlobal('__noitamap', hooks);
  setupDropOverlay({ t: (_key: string, fallback: string) => fallback }, vi.fn(async () => false));
  overlay = hooks.dropOverlay;
});
beforeEach(async () => {
  document.querySelector('.marker-tooltip')?.remove();
  hooks.resetDragState(); overlay.classList.remove('hint'); await settle(); close.mockClear();
});
afterAll(() => { document.body.replaceChildren(); vi.unstubAllGlobals(); });

it('lets an introductory hint appear without blocking POI clicks', async () => {
  overlay.classList.add('hint'); await settle();
  expect(overlay.classList.contains('hint')).toBe(true);
  expect(isDropOverlayActive()).toBe(false);
  expect(canOpenPOIFromCanvas({ quick: true })).toBe(true);
  expect(close).not.toHaveBeenCalled();
});

it('leaves the introductory instructions alone when the user opens a new POI', async () => {
  overlay.classList.add('hint'); await settle();
  const current = card(); await settle();
  expect(overlay.classList.contains('hint')).toBe(true);
  expect(current.isConnected).toBe(true); expect(close).not.toHaveBeenCalled();
});

it('does not add a separate rule for hiding a late introductory hint', async () => {
  const current = card();
  overlay.classList.add('hint'); await settle();
  expect(overlay.classList.contains('hint')).toBe(true);
  expect(current.isConnected).toBe(true); expect(close).not.toHaveBeenCalled();
});

it('gives a real file drag priority, clears the hint and restores clicks after the drag leaves', async () => {
  overlay.classList.add('hint'); await settle(); const current = card();
  drag('dragenter'); await settle();
  expect(isDropOverlayActive()).toBe(true); expect(overlay.classList.contains('hint')).toBe(false);
  expect(current.isConnected).toBe(false); expect(close).toHaveBeenCalledOnce();
  expect(canOpenPOIFromCanvas({ quick: true })).toBe(false);
  drag('dragenter'); drag('dragleave'); await settle();
  expect(isDropOverlayActive()).toBe(true); expect(close).toHaveBeenCalledOnce();
  drag('dragleave'); await settle();
  expect(isDropOverlayActive()).toBe(false); expect(canOpenPOIFromCanvas({ quick: true })).toBe(true);
});

it('also closes the card when Pro shows its shared paste/import overlay', async () => {
  const current = card(); overlay.classList.add('visible'); await settle();
  expect(current.isConnected).toBe(false); expect(close).toHaveBeenCalledOnce();
  // Unrelated class changes must not keep closing cards or loop over mutations.
  overlay.classList.add('processing'); await settle();
  expect(close).toHaveBeenCalledOnce();
  overlay.classList.remove('processing');
});

it('does not treat a dragged link or text selection as a file operation', async () => {
  const current = card(); drag('dragenter', false); await settle();
  expect(current.isConnected).toBe(true); expect(isDropOverlayActive()).toBe(false);
  expect(close).not.toHaveBeenCalled();
});
