import { describe, expect, it, vi } from 'vitest';
import { MapGpuRenderer } from '../src/portals/gpu-renderer.mjs';

describe('map GPU presentation filtering', () => {
  it('uses upstream pixel-sharp sampling for presentation, restoring linear history sampling afterwards', () => {
    let bound: object | null = null;
    const filters = new Map<object, Record<string, string>>();
    const gl = {
      TEXTURE_2D: '2d', TEXTURE_MIN_FILTER: 'min', TEXTURE_MAG_FILTER: 'mag', NEAREST: 'nearest', LINEAR: 'linear',
      BLEND: 'blend', ONE: 1, ONE_MINUS_SRC_COLOR: 2, TRIANGLE_STRIP: 3,
      bindTexture: vi.fn((_kind, texture) => { bound = texture; }),
      texParameteri: vi.fn((_kind, name, value) => { filters.set(bound!, { ...filters.get(bound!), [name]: value }); }),
      bindVertexArray: vi.fn(), useProgram: vi.fn(), uniform4f: vi.fn(), uniform2f: vi.fn(), uniform1i: vi.fn(),
      enable: vi.fn(), blendFunc: vi.fn(), disable: vi.fn(), drawArrays: vi.fn(() => {
        expect([...filters.values()]).toEqual([{ min: 'nearest', mag: 'nearest' }, { min: 'nearest', mag: 'nearest' }]);
      }),
    };
    const renderer = { gl, mapComposite: { program: {}, uniforms: {} },
      scene: { texture: {} }, histories: new Map([['p', { texture: {} }]]),
      bind: vi.fn(), sample: vi.fn(), screenVAO: {},
    };
    MapGpuRenderer.prototype.composeMap.call(renderer, 'p', { x: 0, y: 0 },
      { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }, 800, 600);
    expect(gl.drawArrays).toHaveBeenCalledOnce();
    expect([...filters.values()]).toEqual([{ min: 'linear', mag: 'linear' }, { min: 'linear', mag: 'linear' }]);
  });
});
