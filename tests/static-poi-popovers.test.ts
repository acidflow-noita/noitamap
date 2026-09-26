// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/data/structures.json', () => ({ default: [] }));
vi.mock('../src/data/items.json', () => ({ default: [] }));
vi.mock('../src/data/bosses.json', () => ({ default: [{ name: 'Boss', wiki: 'https://noita.wiki.gg/wiki/Bosses', x: 10, y: 20, maps: ['regular-main-branch'] }] }));
vi.mock('../src/data/orb_areas.json', () => ({ default: [] }));
vi.mock('../src/data/orbs.json', () => ({ default: [] }));
vi.mock('../src/data/spatial_awareness.json', () => ({ default: [] }));
vi.mock('../src/data/biomes.json', () => ({ default: [] }));
vi.mock('../src/data/hidden_messages.json', () => ({ default: [] }));
vi.mock('../src/drawing/biome-boundaries', () => ({ biomeBoundaries: [] }));
vi.mock('../src/telescope/poi-spatial-index', () => ({ loadSpritesheetAndAtlas: async () => null }));
vi.mock('../src/extended-info', () => ({ buildExtendedCreatureSectionByName: () => document.createElement('div') }));
vi.mock('../src/data_sources/url', () => ({ clearTargetPoiId: vi.fn() }));
vi.mock('../src/game-translations/translator', () => ({ gameTranslator: { translateBoss: (name: string) => name } }));
vi.mock('../src/i18n', () => ({ default: { t: (_key: string, options: any) => options?.defaultValue ?? '' } }));
vi.mock('i18next', () => ({ default: { t: (_key: string, options: any) => options?.defaultValue ?? '' } }));
vi.mock('../src/data_sources/tile_data', () => ({ fetchMapVersions: vi.fn(), getTileData: vi.fn() }));
vi.mock('../src/light-mode', () => ({ isLightMode: () => false }));
vi.mock('../src/simplistic-background', () => ({ isSimplisticBackground: () => false }));

class Popover {
  static instances = new Map<Element, Popover>();
  static getInstance(element: Element) { return this.instances.get(element) ?? null; }
  hide = vi.fn();
  dispose = vi.fn(() => { Popover.instances.delete(this.element); });
  constructor(private element: Element, readonly config?: Record<string, unknown>) { Popover.instances.set(element, this); }
}

beforeEach(() => {
  vi.stubGlobal('bootstrap', { Popover });
  vi.stubGlobal('OpenSeadragon', { Point: class { constructor(public x: number, public y: number) {} }, Rect: class {} });
  vi.stubGlobal('requestIdleCallback', vi.fn());
  vi.stubGlobal('requestAnimationFrame', vi.fn());
  document.body.innerHTML = '<div id="osContainer" class="show-bosses"></div>';
});
afterEach(() => { Popover.instances.clear(); document.body.replaceChildren(); vi.unstubAllGlobals(); });

async function createCard() {
  const { createOverlays } = await import('../src/data_sources/overlays');
  const { attachHoverPopover } = await import('../src/popover-util');
  const overlay = createOverlays('regular-main-branch')[0];
  const popup = overlay.element.querySelector<HTMLElement>('.osOverlayPopup')!;
  const link = document.createElement('a'); link.href = 'https://bartender.runfast.stream';
  popup.appendChild(link);
  document.getElementById('osContainer')!.appendChild(overlay.element);
  attachHoverPopover(link, 'Bartender help', 'top', { focus: true });
  return { overlay, link, instance: Popover.getInstance(link)! };
}

describe('reused static POI popovers', () => {
  it('gives static Wiki links the same help and refreshes it through the existing translation lifecycle', async () => {
    const { overlay } = await createCard();
    const wiki = overlay.element.querySelector<HTMLAnchorElement>('a.wikiLink')!;
    const original = Popover.getInstance(wiki)!;
    expect(original.config).toMatchObject({ content: 'Open in Noita Wiki', trigger: 'hover focus' });
    expect(wiki.href).toBe('https://noita.wiki.gg/wiki/Bosses');
    expect(Popover.getInstance(wiki.parentElement!)).toBeNull();
    const { refreshOverlayTranslations } = await import('../src/data_sources/overlays');
    refreshOverlayTranslations();
    expect(original.dispose).toHaveBeenCalledOnce();
    expect(Popover.getInstance(wiki)).not.toBe(original);
    expect(Popover.getInstance(wiki)!.config?.content).toBe('Open in Noita Wiki');
  });

  it('hides on leaving the popup while keeping the same trigger available on reopening', async () => {
    const { overlay, link, instance } = await createCard();
    overlay.element.dispatchEvent(new MouseEvent('mouseleave'));
    expect(instance.hide).toHaveBeenCalledOnce();
    expect(instance.dispose).not.toHaveBeenCalled();
    overlay.element.dispatchEvent(new MouseEvent('mouseenter'));
    expect(Popover.getInstance(link)).toBe(instance);
  });

  it('hides panels when a POI layer is disabled, preserving them when that layer returns', async () => {
    const { link, instance } = await createCard();
    const { showOverlay } = await import('../src/data_sources/overlays');
    showOverlay('bosses', false);
    expect(instance.hide).toHaveBeenCalledOnce();
    expect(document.getElementById('osContainer')!.classList.contains('show-bosses')).toBe(false);
    showOverlay('bosses', true);
    expect(Popover.getInstance(link)).toBe(instance);
    expect(instance.dispose).not.toHaveBeenCalled();
  });

  it.each(['open', 'clearOverlays', 'removeOverlay'] as const)('disposes permanent POI panels before OSD %s removes their DOM', async operation => {
    const { overlay, link, instance } = await createCard();
    const { AppOSD } = await import('../src/app_osd');
    const { attachHoverPopover } = await import('../src/popover-util');
    const app = Object.create(AppOSD.prototype) as InstanceType<typeof AppOSD>;
    const biome = document.createElement('div'); biome.className = 'overlay biomes';
    attachHoverPopover(biome, 'Reusable biome help');
    const biomePopover = Popover.getInstance(biome)!;
    const remove = vi.fn(() => {
      expect(Popover.getInstance(link)).toBeNull();
      overlay.element.remove();
      app.viewer.currentOverlays = [];
    });
    app.viewer = { currentOverlays: [overlay, { element: biome }], open: remove, clearOverlays: remove, removeOverlay: remove };
    if (operation === 'open') app.open([]);
    else if (operation === 'clearOverlays') app.clearOverlays();
    else app.removeOverlay(overlay.element);
    expect(instance.dispose).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledOnce();
    expect(Popover.getInstance(biome)).toBe(biomePopover);
    expect(biomePopover.dispose).not.toHaveBeenCalled();
  });
});
