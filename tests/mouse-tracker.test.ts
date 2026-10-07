// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { initMouseTracker } from '../src/mouse_tracker';

let map: HTMLElement, overlay: HTMLElement, tooltip: HTMLElement;
let tracker: ReturnType<typeof initMouseTracker>;
let camera: { x: number; y: number };
let handlers: Map<string, Set<() => void>>;
let projection: ReturnType<typeof vi.fn>, write: ReturnType<typeof vi.fn>;
const emit = (name: string) => { for (const handler of [...handlers.get(name) ?? []]) handler(); };
const pointer = (type = 'pointermove', x = 130, y = 250, target = map, pointerType = 'mouse') => {
  const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y });
  Object.defineProperty(event, 'pointerType', { value: pointerType }); target.dispatchEvent(event);
};
const text = () => tooltip.firstElementChild!.innerHTML;
async function copy(target: Element = document.body, extra: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', { code: 'KeyC', ctrlKey: true, bubbles: true, cancelable: true, ...extra });
  target.dispatchEvent(event); await Promise.resolve(); await Promise.resolve();
}

beforeEach(() => {
  document.body.innerHTML = '<div id="map"><div id="overlay"></div></div><div id="readout"><div></div></div>';
  map = document.getElementById('map')!; overlay = document.getElementById('overlay')!; tooltip = document.getElementById('readout')!;
  vi.spyOn(map, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 200, 400, 300));
  camera = { x: -30.5, y: -562.5 }; handlers = new Map();
  projection = vi.fn((point: { x: number; y: number }, current: boolean) => ({
    x: point.x + camera.x + (current ? 0 : 10000), y: point.y + camera.y + (current ? 0 : 10000),
  }));
  vi.stubGlobal('OpenSeadragon', { Point: class { constructor(public x: number, public y: number) {} } });
  write = vi.fn(async () => {}); vi.stubGlobal('navigator', { clipboard: { writeText: write } });
  const osd = {
    viewport: { pointFromPixel: projection },
    addHandler: (name: string, callback: () => void) => { if (!handlers.has(name)) handlers.set(name, new Set()); handlers.get(name)!.add(callback); },
    removeHandler: (name: string, callback: () => void) => handlers.get(name)?.delete(callback),
  };
  tracker = initMouseTracker({ osd, osdElement: map, tooltipElement: tooltip });
});
afterEach(() => { tracker.dispose(); window.getSelection()?.removeAllRanges(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

it('projects the actual camera position and floors negative world/chunk coordinates', () => {
  pointer();
  expect(projection).toHaveBeenCalledWith(expect.objectContaining({ x: 30, y: 50 }), true);
  expect(text()).toBe('(-1, -513)<br>chunk: (-1, -2)');
  expect(tooltip.style.left).toBe('130px'); expect(tooltip.style.top).toBe('250px');
});

it('follows camera animation while the pointer remains stationary', () => {
  pointer(); camera.x = 482; camera.y = 974; emit('viewport-change');
  expect(text()).toBe('(512, 1024)<br>chunk: (1, 2)');
});

it('keeps tracking across replacement children and handlers that stop bubbling', () => {
  pointer(); overlay.replaceWith(document.createElement('div'));
  const child = map.firstElementChild!;
  child.addEventListener('pointermove', event => event.stopPropagation());
  pointer('pointermove', 145, 275, child as HTMLElement);
  expect(text()).toBe('(14, -488)<br>chunk: (0, -1)');
});

it('does not rebuild readout nodes for subpixel motion within the same world pixel', () => {
  pointer(); const node = tooltip.firstElementChild!.firstChild;
  pointer('pointermove', 130.1, 250.1);
  expect(tooltip.firstElementChild!.firstChild).toBe(node);
});

it.each(['pointerleave', 'pointercancel', 'blur', 'outside'])('hides and stops copying after %s', async kind => {
  pointer();
  if (kind === 'blur') window.dispatchEvent(new Event('blur'));
  else if (kind === 'outside') pointer('pointermove', 90, 250);
  else pointer(kind);
  emit('viewport-change'); await copy();
  expect(tooltip.style.visibility).toBe('hidden'); expect(write).not.toHaveBeenCalled();
});

it('waits for mouse coordinates instead of displaying or copying touch input', async () => {
  pointer('pointermove', 130, 250, map, 'touch'); await copy();
  expect(tooltip.style.visibility).toBe('hidden'); expect(write).not.toHaveBeenCalled();
});

it('hides invalid camera coordinates and resumes when the camera becomes valid', async () => {
  pointer(); projection.mockReturnValueOnce({ x: NaN, y: Infinity }); emit('viewport-change'); await copy();
  expect(tooltip.style.visibility).toBe('hidden'); expect(write).not.toHaveBeenCalled();
  emit('viewport-change'); expect(tooltip.style.visibility).toBe('visible');
});

it.each([{ ctrlKey: true }, { ctrlKey: false, metaKey: true }])('copies the displayed world point with the platform modifier %j', async modifier => {
  pointer(); await copy(document.body, modifier);
  expect(write).toHaveBeenCalledExactlyOnceWith('{"x":-1,"y":-513}');
});

it.each(['input', 'textarea', 'select', 'editable', 'textbox'])('preserves native copying inside %s', async kind => {
  pointer(); const field = document.createElement(kind === 'editable' || kind === 'textbox' ? 'div' : kind);
  if (kind === 'editable') field.setAttribute('contenteditable', 'true');
  if (kind === 'textbox') field.setAttribute('role', 'textbox');
  document.body.append(field); await copy(field); expect(write).not.toHaveBeenCalled();
});

it('preserves an ordinary text selection even while the pointer is over the map', async () => {
  pointer(); const paragraph = document.createElement('p'); paragraph.textContent = 'Selected card text'; document.body.append(paragraph);
  const range = document.createRange(); range.selectNodeContents(paragraph); window.getSelection()!.addRange(range);
  await copy(); expect(write).not.toHaveBeenCalled();
});

it('lets drawing tools claim the copy event later in the same dispatch', async () => {
  pointer(); const claim = (event: KeyboardEvent) => event.preventDefault();
  document.addEventListener('keydown', claim);
  try { await copy(); expect(write).not.toHaveBeenCalled(); }
  finally { document.removeEventListener('keydown', claim); }
});

it.each([{ shiftKey: true }, { altKey: true }, { repeat: true }])('does not claim modified/repeated copy shortcuts %j', async extra => {
  pointer(); await copy(document.body, extra); expect(write).not.toHaveBeenCalled();
});

it('releases pointer, viewport and clipboard listeners when the viewer is destroyed', async () => {
  pointer(); emit('before-destroy');
  const calls = projection.mock.calls.length;
  pointer(); emit('viewport-change'); await copy();
  expect(projection).toHaveBeenCalledTimes(calls); expect(write).not.toHaveBeenCalled();
  expect(tooltip.style.visibility).toBe('hidden');
});
