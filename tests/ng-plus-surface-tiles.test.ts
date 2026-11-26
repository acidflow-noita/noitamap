import { createCanvas, ImageData } from '@napi-rs/canvas';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { changedNGPlusSurfaceCells, ngPlusSurfaceLayout } from '../src/telescope/ng-plus-surface-layout';
import { addNGPlusSurface } from '../src/telescope/ng-plus-surface-tiles';

const pool = vi.hoisted(() => ({ context: vi.fn(), render: vi.fn(), release: vi.fn() }));
vi.mock('../src/telescope/cpu-terrain-client', () => ({ sharedCpuTerrainPool: () => pool }));
const width = 64, hill = 14 * width + 20, sky = 5 * width + 16;

it('uses the final seeded grid on every seventh level and preserves authored cells and existing biomes', () => {
  const base = new Uint8Array(width * 48 * 4);
  for (const i of [sky, hill, hill + 1]) base.set([0x36, 0xd5, 0x17, 255], 4 * i);
  const pixels = new Uint32Array(width * 48);
  for (let level = 1; level <= 28; level++) {
    const color = [0xffcc9944, 0xffd6d8e3, 0xff33e311][Math.floor(level / 7) % 3];
    pixels[hill] = pixels[hill + 2] = pixels[sky] = color;
    pixels[hill + 1] = 0xffffd108;
    const cells = changedNGPlusSurfaceCells(level, pixels, base, width);
    if (level % 7) expect(cells).toBeUndefined();
    else expect(cells).toEqual(Uint16Array.of(sky, hill));
  }
});

it('omits the captured high sky and clips repeated regions at the DZI boundaries', () => {
  expect(ngPlusSurfaceLayout(Uint16Array.of(sky), width, [0])).toBeNull();
  const cells = Uint16Array.from([...Array(width).keys()], x => 14 * width + x);
  const layout = ngPlusSurfaceLayout(cells, width, [-2, -1, 0, 1, 2])!;
  expect([layout.x, layout.width, layout.y, layout.height]).toEqual([-53760, 107520, 0, 512]);
  expect(layout.intersects(53759, 18, 1, 1)).toBe(true);
  expect(layout.intersects(-53761, 18, 1, 1)).toBe(false);
  expect(layout.intersects(0, 8004, 128, 128)).toBe(false);
});

describe('the surface tile source', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pool.context.mockImplementation(generation => ({ generation, released: false }));
    pool.release.mockImplementation(context => { context.released = true; });
    pool.render.mockImplementation(async (_context, t) => ({ pixels: new Uint8ClampedArray(t.width * t.height * 4).fill(255).buffer }));
    vi.stubGlobal('OpenSeadragon', { TileSource: class {
      constructor(values: object) { Object.assign(this, values); }
      tileExists() { return true; }
      destroy() {}
    } });
    vi.stubGlobal('document', { createElement: () => createCanvas(1, 1) });
    vi.stubGlobal('ImageData', ImageData);
  });
  afterEach(() => vi.unstubAllGlobals());

  function open() {
    const viewer = { addTiledImage: vi.fn(), world: { removeItem: vi.fn() } };
    const added = vi.fn();
    let current = true;
    addNGPlusSurface(viewer, 1244794027, new Uint32Array(width * 48), Uint16Array.of(hill), width,
      [-1, 0, 1], () => current, added);
    const options = viewer.addTiledImage.mock.calls[0][0];
    return { viewer, options, added, source: options.tileSource, leave: () => { current = false; } };
  }

  it('requests only visible changed cells with absolute coordinates and the selected sample step', async () => {
    const { source, options, added } = open();
    expect(pool.render).not.toHaveBeenCalled();
    options.success({ item: source });
    expect(added).toHaveBeenCalledWith(source);
    expect(source.tileExists(source.maxLevel, 10, 0)).toBe(false);
    const job = { tile: { level: source.maxLevel - 2, x: 64, y: 0 }, finish: vi.fn(), fail: vi.fn() };
    await source.downloadTileStart(job);
    expect(pool.render.mock.calls[0][1]).toEqual({ x: -6144, y: 0, step: 4, width: 128, height: 128 });
    expect(job.fail).not.toHaveBeenCalled();
    expect(job.finish.mock.calls[0][0].getImageData(0, 0, 1, 1).data[3]).toBe(255);
    source.destroy();
    expect(source.tileExists(source.maxLevel, 0, 0)).toBe(false);
  });

  it('cancels pending work and retires an item whose open callback arrives after navigation', async () => {
    const { source, options, viewer, added, leave } = open();
    let finish!: (data: unknown) => void;
    pool.render.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const job = { tile: { level: source.maxLevel, x: 0, y: 0 }, fail: vi.fn(), finish: vi.fn() };
    const pending = source.downloadTileStart(job);
    source.downloadTileAbort(job);
    expect(pool.render.mock.calls[0][2].aborted).toBe(true);
    finish({});
    await pending;
    expect(job.finish).not.toHaveBeenCalled();
    leave();
    options.success({ item: source });
    expect(viewer.world.removeItem).toHaveBeenCalledWith(source);
    expect(added).not.toHaveBeenCalled();
    source.destroy(); source.destroy();
    expect(pool.release).toHaveBeenCalledOnce();
  });
});
