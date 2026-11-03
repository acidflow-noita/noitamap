// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

let width = 800, height = 500;
let board: import('../src/guessr/map-board').MapBoard | undefined;
let observer: ResizeObserverCallback;
const bounds = { x: -17920, y: -31744, width: 36352, height: 73728 };
beforeEach(() => {
  width = 800; height = 500;
  vi.useFakeTimers();
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => width);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => height);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    return { getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }), ...Object.fromEntries(['save', 'restore', 'clearRect', 'fillRect', 'drawImage', 'setTransform', 'resetTransform',
      'translate', 'rotate', 'scale', 'beginPath', 'closePath', 'rect', 'clip', 'stroke', 'fill', 'moveTo', 'lineTo']
      .map(method => [method, () => {}]).concat([['canvas', this as any]])) } as any;
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,');
  vi.stubGlobal('ResizeObserver', class { constructor(callback: ResizeObserverCallback) { observer = callback; } observe() {} disconnect() {} });
  Object.defineProperty(SVGSVGElement.prototype, 'getScreenCTM', { configurable: true, value() {
    const box = this.getAttribute('viewBox')?.split(' ').map(Number);
    return box ? { a: width / box[2], b: 0 } : null;
  } });
});
afterEach(() => {
  board?.destroy(); board = undefined;
  document.body.replaceChildren(); delete (SVGSVGElement.prototype as any).getScreenCTM;
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});

it.each([false, true])('keeps result pins aligned through real renderer startup and delayed layout (no chatter guess: %s)', async noChat => {
  const { MapBoard } = await import('../src/guessr/map-board');
  width = 0; height = 0;
  const element = document.createElement('div'); document.body.append(element);
  board = new MapBoard(element, bounds, '', () => {}, { width: bounds.width, height: bounds.height,
    tileSize: 512, overlap: 2, maxLevel: 17, tiles: '/reference/' });
  const players = [
    { id: 'host', name: 'Streamer', guess: { x: 11000, y: -21000 } },
    { id: 'chat', name: 'Chatter', guess: noChat ? null : { x: -12000, y: 28000 } },
  ];
  const answer = { x: 5000, y: 10000 };
  board.setPlayers(players, answer, () => {}); board.setLocked(true);
  await vi.advanceTimersByTimeAsync(150);
  width = 800; height = 500; observer([], {} as ResizeObserver);
  await vi.advanceTimersByTimeAsync(150);
  const viewport = (board as any).tiles.viewport;
  function check() {
    const camera = viewport.getBounds(true);
    const [x, y, w, h] = board!.svg.getAttribute('viewBox')!.split(' ').map(Number);
    expect(camera.x).toBeCloseTo(x); expect(camera.y).toBeCloseTo(y);
    expect(camera.width).toBeCloseTo(w); expect(camera.height).toBeCloseTo(h);
    for (const point of [answer, ...players.flatMap(p => p.guess ? [p.guess] : [])]) {
      expect(camera.containsPoint(point)).toBe(true);
    }
  }
  check();
  height = 310; observer([], {} as ResizeObserver);
  await vi.advanceTimersByTimeAsync(150); check();
});
