// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MapBoard } from "../src/guessr/map-board";
import { MAP_PIN_PATH, MAP_PIN_TIP, ANSWER_PIN_CENTER, GUESS_PIN_COLOR, ANSWER_PIN_COLOR, GUESS_PIN_HEIGHT, ANSWER_PIN_HEIGHT, PLAYER_PIN_HEIGHT, HIGHLIGHT_PIN_HEIGHT } from '../src/guessr/map-pin';

const harness = vi.hoisted(() => ({
  viewer: null as any,
  options: null as any,
}));
vi.mock("openseadragon", async (original) => {
  // Use the installed OSD camera math; tile networking/drawing is outside this
  // unit test. No browser is launched.
  const canvas = vi
    .spyOn(HTMLCanvasElement.prototype, "getContext")
    .mockReturnValue(null);
  const { default: OSD } = await original<any>();
  canvas.mockRestore();
  const create = (options: any) => {
    harness.options = options;
    const viewport = new OSD.Viewport({
      containerSize: new OSD.Point(
        options.element.clientWidth,
        options.element.clientHeight,
      ),
      contentSize: new OSD.Point(36352, 73728),
      animationTime: 0,
      degrees: 0,
    });
    return (harness.viewer = {
      viewport,
      addTiledImage: (image: any) => queueMicrotask(() => image.success()),
      destroy: vi.fn(),
    });
  };
  return {
    default: Object.assign(create, { Point: OSD.Point, Rect: OSD.Rect }),
  };
});

const bounds = { x: -17920, y: -31744, width: 36352, height: 73728 };
let width = 800,
  height = 400;
let observer: ResizeObserverCallback;
let board: MapBoard | undefined;
beforeEach(() => {
  width = 800;
  height = 400;
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
    () => width,
  );
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(
    () => height,
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: ResizeObserverCallback) {
        observer = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  Object.defineProperty(SVGSVGElement.prototype, "getScreenCTM", {
    configurable: true,
    value() {
      const [x, y, w, h] = this.getAttribute("viewBox").split(" ").map(Number);
      return { a: width / w, b: 0, inverse: () => ({ x, y, w, h }) };
    },
  });
  Object.defineProperty(SVGSVGElement.prototype, "createSVGPoint", {
    configurable: true,
    value() {
      return {
        x: 0,
        y: 0,
        matrixTransform(m: any) {
          return {
            x: m.x + (this.x / width) * m.w,
            y: m.y + (this.y / height) * m.h,
          };
        },
      };
    },
  });
});
afterEach(() => {
  board?.destroy();
  board = undefined;
  document.body.replaceChildren();
  delete (SVGSVGElement.prototype as any).getScreenCTM;
  delete (SVGSVGElement.prototype as any).createSVGPoint;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function fixture() {
  const mount = document.createElement("div");
  document.body.append(mount);
  mount.setPointerCapture = vi.fn();
  const guess = vi.fn((point) => board!.setMarkers(point));
  board = new MapBoard(mount, bounds, "", guess, {
    ...bounds,
    tileSize: 512,
    overlap: 2,
    maxLevel: 17,
    tiles: "/reference/",
  });
  await Promise.resolve();
  return { mount, guess, viewer: harness.viewer, board };
}
function camera() {
  const [x, y, width, height] = board!.svg
    .getAttribute("viewBox")!
    .split(" ")
    .map(Number);
  return { x, y, width, height };
}
function aligned(viewport: any) {
  const actual = viewport.getBounds(true),
    expected = camera();
  for (const key of ["x", "y", "width", "height"] as const)
    expect(actual[key]).toBeCloseTo(expected[key], 6);
}
function click(mount: HTMLElement, x: number, y: number) {
  for (const type of ["pointerdown", "pointerup"]) {
    const event = new MouseEvent(type, { clientX: x, clientY: y, button: 0 });
    Object.defineProperty(event, "pointerId", { value: 1 });
    mount.dispatchEvent(event);
  }
}

describe("guess-map camera", () => {
  it('centres the solution target under the exact guess-pin tip through zoom changes', async () => {
    const { board } = await fixture(), point = { x: 1000, y: 2000 };
    board.setMarkers(point, point);
    const guess = board.svg.querySelector<SVGGElement>('[data-pin-kind="guess"]')!;
    const answer = board.svg.querySelector<SVGGElement>('[data-pin-kind="answer"]')!;
    expect(guess.getAttribute('fill')).toBe(GUESS_PIN_COLOR); expect(answer.getAttribute('fill')).toBe(ANSWER_PIN_COLOR);
    expect(guess.querySelector('path')?.getAttribute('d')).toBe(MAP_PIN_PATH);
    for (const circle of answer.querySelectorAll('circle')) {
      expect(Number(circle.getAttribute('cx'))).toBe(ANSWER_PIN_CENTER.x);
      expect(Number(circle.getAttribute('cy'))).toBe(ANSWER_PIN_CENTER.y);
    }
    expect([...answer.querySelectorAll('path')].some(path => path.getAttribute('d') === MAP_PIN_PATH)).toBe(false);
    expect(guess.nextElementSibling).toBe(answer);
    expect(ANSWER_PIN_HEIGHT).toBeGreaterThan(GUESS_PIN_HEIGHT);
    expect(ANSWER_PIN_HEIGHT).toBeGreaterThan(HIGHLIGHT_PIN_HEIGHT);
    for (const zoom of [1, 3, .25]) {
      board.zoom(zoom);
      for (const [pin, expectedHeight] of [[guess, GUESS_PIN_HEIGHT], [answer, ANSWER_PIN_HEIGHT]] as const) {
        const values = pin.getAttribute('transform')!.match(/-?[\d.]+(?:e[+-]?\d+)?/gi)!.map(Number);
        const [x, y, scale, tipX, tipY] = values;
        expect([x, y]).toEqual([point.x, point.y]);
        const anchor = pin === answer ? ANSWER_PIN_CENTER : MAP_PIN_TIP;
        expect([tipX, tipY]).toEqual([-anchor.x, -anchor.y]);
        expect(64 * scale * width / camera().width).toBeCloseTo(expectedHeight, 8);
      }
    }
  });
  it('returns to the streamer and target after exploring results when no chatter guessed', async () => {
    const { board, viewer } = await fixture();
    const host = { x: 14000, y: -22000 }, target = { x: 14600, y: -21500 };
    board.setPlayers([{ id: 'host', name: 'Streamer', guess: host }, { id: 'chat', name: 'No guess', guess: null }], target, () => {});
    const result = camera();
    expect(board.svg.querySelectorAll('[data-player]')).toHaveLength(1);
    expect(result.x + result.width / 2).toBeCloseTo((host.x + target.x) / 2);
    expect(result.y + result.height / 2).toBeCloseTo((host.y + target.y) / 2);
    board.zoom(4); board.home();
    expect(camera()).toEqual(result); aligned(viewer.viewport);
  });

  it('never zooms inward when zooming out of an all-guesses result near the world edges', async () => {
    const { board } = await fixture();
    board.setPlayers([{ id: 'first', name: 'First', guess: { x: -17920, y: -31744 } },
      { id: 'last', name: 'Last', guess: { x: 18432, y: 41984 } }], { x: 0, y: 0 }, () => {});
    const before = camera(); board.zoom(0.8);
    expect(camera().width).toBeGreaterThanOrEqual(before.width);
    expect(camera().height).toBeGreaterThanOrEqual(before.height);
  });

  it('frames every submitted pin and highlights the selected player without moving the camera', async () => {
    const { board, viewer } = await fixture(), highlighted = vi.fn();
    const players = [
      { id: '1', name: 'First', color: '#9146FF', guess: { x: -15000, y: -20000 } },
      { id: '2', name: 'Second', color: '#FF4500', guess: { x: 12000, y: 30000 } },
      { id: '3', name: 'No guess', guess: null },
    ];
    board.setPlayers(players, { x: 0, y: 0 }, highlighted); board.setLocked(true);
    const before = camera();
    for (const point of [players[0].guess!, players[1].guess!, { x: 0, y: 0 }]) {
      expect(point.x).toBeGreaterThanOrEqual(before.x); expect(point.x).toBeLessThanOrEqual(before.x + before.width);
      expect(point.y).toBeGreaterThanOrEqual(before.y); expect(point.y).toBeLessThanOrEqual(before.y + before.height);
    }
    const first = board.svg.querySelector<SVGGElement>('[data-player="1"]')!;
    const second = board.svg.querySelector<SVGGElement>('[data-player="2"]')!;
    expect(first.getAttribute('fill')).toBe('#9146FF'); expect(second.getAttribute('fill')).toBe('#FF4500');
    first.dispatchEvent(new Event('pointerenter'));
    expect(highlighted).toHaveBeenCalledWith('1');
    board.highlightPlayer('1'); expect(first.dataset.pinHeight).toBe(String(HIGHLIGHT_PIN_HEIGHT));
    expect(first.style.opacity).toBe('1'); expect(second.style.opacity).toBe('0.18');
    const solution = board.svg.querySelector('[data-pin-kind="answer"]')!;
    expect(solution.parentElement!.lastElementChild).toBe(solution);
    board.highlightPlayer('2'); expect(first.dataset.pinHeight).toBe(String(PLAYER_PIN_HEIGHT)); expect(second.dataset.pinHeight).toBe(String(HIGHLIGHT_PIN_HEIGHT));
    expect(first.style.opacity).toBe('0.18'); expect(second.style.opacity).toBe('1');
    expect(solution.parentElement!.lastElementChild).toBe(solution);
    board.highlightPlayer(''); expect(first.style.opacity).toBe('1'); expect(second.style.opacity).toBe('1');
    expect(camera()).toEqual(before); aligned(viewer.viewport);
    expect(board.svg.querySelectorAll('[data-player]')).toHaveLength(2);
  });
  it("translates map and marker labels without changing the camera or rebuilding markers", async () => {
    const { default: i18next } = await import('../src/i18n');
    const { initializeGuessrTranslations } = await import('../src/guessr/i18n');
    history.replaceState(null, '', '/guess/?lng=en');
    await initializeGuessrTranslations();
    i18next.addResourceBundle('de', 'translation', {}, true, true);
    i18next.addResourceBundle('de', 'guessr', {
      'World overview. Place your guess on this map.': 'Weltübersicht. Platziere deinen Tipp auf der Karte.',
      'Guess map. Arrow keys move the pin, plus and minus zoom, Home resets the view.': 'Tippkarte. Pfeiltasten bewegen die Markierung, Plus und Minus zoomen, Pos1 setzt die Ansicht zurück.',
      'Your guess': 'Dein Tipp', 'Actual location': 'Tatsächlicher Ort',
    }, true, true);
    const { mount, board, guess, viewer } = await fixture();
    board.setMarkers({ x: -500, y: 1000 }, { x: 700, y: 1500 });
    const before = camera(), circles = [...board.svg.querySelectorAll('circle')];
    const coordinates = circles.map(circle => [circle.getAttribute('cx'), circle.getAttribute('cy')]);
    const fit = vi.spyOn(viewer.viewport, 'fitBounds');
    try {
      await i18next.changeLanguage('de');
      expect(camera()).toEqual(before);
      expect([...board.svg.querySelectorAll('circle')]).toEqual(circles);
      expect(circles.map(circle => [circle.getAttribute('cx'), circle.getAttribute('cy')])).toEqual(coordinates);
      expect([...board.svg.querySelectorAll('title')].map(title => title.textContent)).toEqual(['Dein Tipp', 'Tatsächlicher Ort']);
      expect(board.svg.getAttribute('aria-label')).toBe('Weltübersicht. Platziere deinen Tipp auf der Karte.');
      expect(mount.getAttribute('aria-label')).toContain('Pfeiltasten');
      expect(fit).not.toHaveBeenCalled();
      expect(guess).not.toHaveBeenCalled();
    } finally {
      await i18next.changeLanguage('en');
    }
  });

  it("opens without empty side margins and does not refit when a pin is clicked or moved", async () => {
    const { mount, guess, viewer } = await fixture();
    expect(camera().width).toBe(bounds.width);
    expect(camera().height).toBe(bounds.width / 2);
    aligned(viewer.viewport);
    const original = camera(),
      fit = vi.spyOn(viewer.viewport, "fitBounds");
    click(mount, 300, 150);
    click(mount, 450, 250);
    expect(guess).toHaveBeenCalledTimes(2);
    expect(camera()).toEqual(original);
    expect(fit).not.toHaveBeenCalled();
    aligned(viewer.viewport);
  });

  it("synchronizes late panel resizing before the first click and preserves a chosen zoom", async () => {
    const { mount, viewer, board } = await fixture();
    expect(harness.options.autoResize).toBe(false);
    height = 650;
    observer([], {} as ResizeObserver);
    aligned(viewer.viewport);
    const beforeClick = camera();
    click(mount, 300, 250);
    expect(camera()).toEqual(beforeClick);
    aligned(viewer.viewport);
    board.zoom(4);
    const zoomed = camera();
    click(mount, 500, 350);
    expect(camera()).toEqual(zoomed);
    width = 520;
    observer([], {} as ResizeObserver);
    expect(camera().width).toBe(zoomed.width);
    aligned(viewer.viewport);
  });

  it("fits both markers after submission and resets to a filled map for the next round", async () => {
    const { board, viewer } = await fixture();
    const markers = [
      { x: -15000, y: -28000 },
      { x: 17000, y: 41000 },
    ];
    board.setMarkers(markers[0], markers[1]);
    aligned(viewer.viewport);
    for (const p of markers) {
      const frame = camera();
      expect((p.x - frame.x) / frame.width).toBeGreaterThan(0.1);
      expect((p.x - frame.x) / frame.width).toBeLessThan(0.9);
      expect((p.y - frame.y) / frame.height).toBeGreaterThan(0.1);
      expect((p.y - frame.y) / frame.height).toBeLessThan(0.9);
    }
    board.setMarkers(null); board.home();
    expect(camera().width).toBe(bounds.width);
    expect(camera().height).toBe(bounds.width / 2);
    aligned(viewer.viewport);
  });
});
