// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { createModNavigation, parseModNavigation } from '../src/mod-navigation';
const base = 'https://map.test';
function setup(search = '?m=dy&se=91&u=AQAAAAA&p=1.AA&lng=ru&terrain-presentation=gpu') {
  let href = base + search, map: any = 'dynamic-main-branch';
  const options = { href: () => href, getMap: () => map,
    replaceURL: vi.fn((url: URL) => { href = url.href; }), setMap: vi.fn(async (next: any) => { map = next; }),
    goto: vi.fn(), updateSeed: vi.fn(), resetUnlocks: vi.fn(), closeCard: vi.fn(), renderDynamic: vi.fn(async () => {}), failed: vi.fn() };
  return { ...options, ...createModNavigation(options), setCurrentMap: (m: any) => { map = m; } };
}
const link = (extra = '') => base + '/?m=dy&se=91&u=AQAAAAA&p=1.AA&x=-3152&y=874&z=868&src=mod' + extra;
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

describe('in-page mod navigation', () => {
  it('moves within a warmed seed without generation and preserves display preferences', () => {
    const f = setup(); expect(f.accept(link())).toBe(true);
    expect(f.renderDynamic).not.toHaveBeenCalled(); expect(f.setMap).not.toHaveBeenCalled();
    expect(f.resetUnlocks).not.toHaveBeenCalled();
    expect(f.goto).toHaveBeenCalledWith({ x: -3152, y: 874, zoom: 2 ** -8.68 });
    const url = new URL(f.href());
    expect(url.searchParams.get('lng')).toBe('ru');
    expect(url.searchParams.get('terrain-presentation')).toBe('gpu');
    expect(url.searchParams.has('src')).toBe(false);
  });
  it('runs a new seed once in the existing app', () => {
    const f = setup(); expect(f.accept(link().replace('se=91', 'se=92'))).toBe(true);
    expect(f.renderDynamic).toHaveBeenCalledOnce(); expect(f.setMap).not.toHaveBeenCalled();
    expect(f.updateSeed).toHaveBeenCalledWith(92, false);
  });
  it.each(['u=AgAAAAA', 'p=1.Ag'])('replaces changed %s inputs for the same seed and retires old variants', replacement => {
    const f = setup(), key = replacement[0], url = new URL(link());
    url.searchParams.set(key, replacement.slice(2));
    expect(f.accept(url.href)).toBe(true);
    expect(f.resetUnlocks).toHaveBeenCalledOnce(); expect(f.renderDynamic).toHaveBeenCalledOnce();
  });
  it.each(['1', 'true'])('preserves resolved Daily mode %s when the mod only changes its position', daily => {
    const f = setup('?m=dy&se=91&u=AQAAAAA&p=1.AA&ds=' + daily);
    f.accept(link()); expect(f.renderDynamic).not.toHaveBeenCalled();
    expect(new URL(f.href()).searchParams.get('ds')).toBe(daily);
    expect(f.updateSeed).toHaveBeenCalledWith(91, true);
    f.accept(link().replace('se=91', 'se=92'));
    expect(new URL(f.href()).searchParams.has('ds')).toBe(false);
    expect(f.renderDynamic).toHaveBeenCalledOnce();
  });
  it('switches static maps without generating and only lets the newest queued map request position the view', async () => {
    const f = setup(); let finish!: () => void;
    f.setMap.mockImplementationOnce(async () => { await new Promise<void>(r => { finish = r; }); f.setCurrentMap('nightmare-main-branch'); });
    f.accept(base + '/?m=nm&x=10&y=20&z=900&src=mod'); await flush();
    f.accept(base + '/?m=n&x=30&y=40&z=910&src=mod'); finish(); await flush();
    expect(f.goto).toHaveBeenCalledOnce(); expect(f.goto).toHaveBeenCalledWith({ x: 30, y: 40, zoom: 2 ** -9.1 });
    expect(f.getMap()).toBe('new-game-plus-main-branch'); expect(f.renderDynamic).not.toHaveBeenCalled();
  });
  it('starts dynamic generation once after changing the map', async () => {
    const f = setup(); f.setCurrentMap('regular-main-branch');
    f.accept(link()); await flush();
    expect(f.setMap).toHaveBeenCalledWith('dynamic-main-branch'); expect(f.renderDynamic).toHaveBeenCalledOnce();
  });
  it('rejects invalid map, origin, path, seed or camera before touching the running app', () => {
    for (const url of [link().replace(base, 'https://other.test'), link().replace('/?', '/auth/?'),
      link().replace('m=dy', 'm=invalid'), link().replace('se=91', 'se=91junk'),
      link().replace('se=91', 'se=4294967296'), link().replace('x=-3152', 'x=NaN')]) {
      const f = setup(); expect(f.accept(url), url).toBe(false);
      expect(f.replaceURL).not.toHaveBeenCalled(); expect(f.renderDynamic).not.toHaveBeenCalled();
    }
    expect(parseModNavigation(link().replace('se=91', 'se=0'), base)?.state.seed).toBe(0);
  });
});
