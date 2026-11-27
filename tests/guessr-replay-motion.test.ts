// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cameraRect, type Camera, type ClueSource } from '../src/guessr/clue-camera';
import { ClueViewport } from '../src/guessr/clue-viewport';
import { ReplayMotion } from '../src/guessr/replay-motion';

const start = { dx: 0, dy: 0, level: 0 };
const distant = { dx: 400, dy: 100, level: 0 };
const wide = { dx: 24, dy: -11, level: 1 };
const zoomed = { ...wide, level: 0 };
const world: ClueSource = { frames: [{ ...cameraRect({ ...start, level: 6 }), image: '/atlas.webp' }] };
const drawImage = vi.fn();

beforeEach(() => {
  drawImage.mockClear();
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  vi.stubGlobal('Image', class { async decode() {} });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() =>
    ({ clearRect() {}, drawImage } as unknown as CanvasRenderingContext2D));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function move(source: ClueSource, from: Camera, to: Camera) {
  const mount = document.createElement('div');
  const viewport = new ClueViewport(mount, source);
  const motion = new ReplayMotion();
  const animate = vi.spyOn(motion, 'animate').mockResolvedValue(true);
  try {
    expect(await viewport.show(to, undefined, { replayFrom: from, motion })).toBe(true);
    expect(animate).toHaveBeenCalledTimes(2);
    const rect = cameraRect(to);
    expect([viewport.canvas.width, viewport.canvas.height]).toEqual([rect.width, rect.height]);
    expect(drawImage.mock.calls.at(-1)!.slice(-6)).toEqual([rect.width, rect.height, 0, 0, rect.width, rect.height]);
    expect(mount.querySelector('.replay-pan-layer, .replay-pin-layer')).toBeNull();
    const [[, terrain], [, marker]] = animate.mock.calls;
    return { terrain, marker };
  } finally {
    viewport.destroy();
  }
}

it.each([[zoomed, wide], [wide, zoomed], [distant, start], [wide, start]])(
  'animates both ends of a recorded camera move and keeps the pin at screen size',
  async (from, to) => {
    const { terrain, marker } = await move(world, from, to);
    const scale = (frame: Keyframe) => Number(String(frame.transform).match(/scale\(([^)]+)\)/)![1]);
    expect(scale(terrain[1]) / scale(terrain[0])).toBeCloseTo(cameraRect(from).width / cameraRect(to).width);
    expect(terrain[0].transform).not.toEqual(terrain[1].transform);
    for (const [i, camera] of [from, to].entries()) {
      const r = cameraRect(camera);
      expect(marker[i].transform).toBe(`translate(${100 * -r.x / r.width}%, ${100 * -r.y / r.height}%)`);
    }
  }
);

it('crossfades real endpoint images on a reset across a gap in a sparse recording', async () => {
  const sparse = { frames: [start, distant].map((camera, i) => ({ ...cameraRect(camera), image: '/tile-' + i })) };
  const { terrain } = await move(sparse, distant, start);
  expect(terrain[0].transform).toBe(terrain[1].transform);
  expect(terrain.map(frame => frame.opacity)).toEqual([0, 1]);
});
