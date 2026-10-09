// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const access = vi.hoisted(() => ({ pro: true }));
vi.mock('../src/auth/auth-service', () => ({ authService: {
  getState: () => ({ authenticated: access.pro, isSubscriber: access.pro }),
  subscribe: () => () => {},
} }));
vi.mock('../src/auth/auth-ui', () => ({ AuthUI: { showGetProModal: vi.fn() } }));
vi.mock('../src/i18n', () => ({ default: {
  t: (key: string, options: string | { defaultValue?: string } = {}) =>
    typeof options === 'string' ? options : options.defaultValue ?? key,
  on: () => {},
} }));

beforeEach(() => { vi.resetModules(); access.pro = true; });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); document.body.replaceChildren(); });

describe('shared material catalog', () => {
  it('fetches and parses once across concurrent public and Pro consumers', async () => {
    const material = { id: 'blood', graphics: { color: 'ff110000' }, density: 3 };
    const json = vi.fn(async () => [material]);
    const fetch = vi.fn(async () => ({ ok: true, json }));
    vi.stubGlobal('fetch', fetch);
    const publicInfo = await import('../src/material-info');
    const extended = await import('../src/extended-info');
    expect(fetch).not.toHaveBeenCalled();
    await Promise.all([publicInfo.primeMaterialInfo(), extended.loadExtendedMaterials()]);
    await Promise.all([extended.loadExtendedMaterials(), publicInfo.primeMaterialInfo()]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(json).toHaveBeenCalledTimes(1);
    expect(publicInfo.getMaterialInfo('blood')).toBe(extended.getExtendedMaterial('blood'));
    expect(extended.getExtendedMaterial('blood')).toEqual(material);
  });

  it('retries after a failed request instead of caching an empty catalog', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetch = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ ok: true, json: async () => [{ id: 'water' }] });
    vi.stubGlobal('fetch', fetch);
    const publicInfo = await import('../src/material-info');
    const extended = await import('../src/extended-info');
    await extended.loadExtendedMaterials();
    expect(publicInfo.getMaterialInfo('water')).toBeNull();
    await publicInfo.primeMaterialInfo();
    expect(extended.getExtendedMaterial('water')).toEqual({ id: 'water' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('keeps a free material card from fetching the catalog', async () => {
    access.pro = false;
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const { buildExtendedSection } = await import('../src/extended-info');
    const section = buildExtendedSection('material', 'blood');
    document.body.appendChild(section);
    await Promise.resolve();
    expect(fetch).not.toHaveBeenCalled();
    expect(section.textContent).toContain('Unlock with Pro');
  });
});
