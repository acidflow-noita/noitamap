// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';
const osd = vi.hoisted(() => ({ setMap: vi.fn(), destroy: vi.fn() }));
vi.mock('../src/app_osd', () => ({ AppOSD: class {
  viewer = { destroy: osd.destroy };
  setMap = osd.setMap;
} }));
vi.mock('../src/data_sources/overlays', () => ({}));
vi.mock('../src/data_sources/map_definitions', () => ({}));
vi.mock('../src/i18n-dom', () => ({}));
import { App } from '../src/app';
beforeEach(() => vi.resetAllMocks());

it('disposes a failed viewer before startup falls back or reports failure', async () => {
  const error = new Error('map failed to open');
  osd.setMap.mockRejectedValue(error);
  await expect(App.create({ mountTo: document.createElement('div'), overlayButtons: document.createElement('div'),
    initialState: { map: 'dynamic-main-branch' }, useWebGL: false })).rejects.toBe(error);
  expect(osd.destroy).toHaveBeenCalledOnce();
});
