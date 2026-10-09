// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ authenticated: true, isSubscriber: true }));
vi.mock('../src/auth/auth-service', () => ({ authService: {
  getState: () => auth,
  subscribe: () => () => {},
} }));
vi.mock('../src/auth/auth-ui', () => ({ AuthUI: {} }));
vi.mock('../src/i18n', () => ({ default: {
  t(key: string, options: string | Record<string, string> = {}) {
    if (key === 'extended.spawn.pyramid') return 'Pyramide';
    const fallback = typeof options === 'string' ? options : options.defaultValue ?? key;
    return typeof options === 'string' ? fallback : fallback.replace('{{locations}}', options.locations ?? '');
  },
  on: () => {},
} }));

const spawn = 'Pyramid, Temple of the Art, Tower';
const ngplus = 'Snowy Depths, Unknown region';

describe('creature spawn map links', () => {
  beforeEach(() => {
    vi.resetModules();
    auth.authenticated = true;
    auth.isSubscriber = true;
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => [
      { id: 'test', name: 'Test creature', alias: 'Creature alias', spawnLocation: spawn, ngplusSpawnLocation: ngplus },
    ] })));
  });
  afterEach(() => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  async function card() {
    const { buildExtendedSection } = await import('../src/extended-info');
    const section = buildExtendedSection('creature', 'test');
    document.body.append(section);
    await vi.waitFor(() => expect(section.querySelector('.extended-info-creature')).not.toBeNull());
    return section;
  }

  it('uses one local action for each complete spawn list, retaining raw metadata for navigation', async () => {
    const { setCreatureSpawnNavigation } = await import('../src/creature-spawn-navigation');
    const navigate = vi.fn(() => true);
    const resolve = vi.fn(() => ({ canNavigate: true, missing: [] }));
    setCreatureSpawnNavigation({ resolve, navigate });
    const section = await card();
    const links = [...section.querySelectorAll<HTMLButtonElement>('.creature-spawn-link')];
    expect(links).toHaveLength(2);
    expect(links[0].textContent).toBe('Pyramide, Temple of the Art, Tower');
    expect(links[1].textContent).toBe(ngplus);
    expect(resolve).toHaveBeenCalledWith(spawn, 'normal');
    expect(resolve).toHaveBeenCalledWith(ngplus, 'ng-plus');
    expect(links[0].getAttribute('aria-label')).toBe('Show spawn biomes on map: Pyramide, Temple of the Art, Tower');
    expect(links[0].querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(links[0].querySelector('svg path')?.getAttribute('d')).toBe(
      'M12 2C8.1 2 5 5.1 5 9c0 5.2 7 13 7 13s7-7.8 7-13c0-3.9-3.1-7-7-7zm0 9.5a2.5 2.5 0 110-5 2.5 2.5 0 010 5z',
    );
    const ancestorClick = vi.fn(); section.addEventListener('click', ancestorClick);
    links[0].click();
    expect(navigate).toHaveBeenCalledWith(spawn, links[0], 'normal', 'test');
    links[1].click();
    expect(navigate).toHaveBeenCalledWith(ngplus, links[1], 'ng-plus', 'test');
    expect(ancestorClick).not.toHaveBeenCalled();
    expect(section.isConnected).toBe(true); // The host owns card closure and report restoration.
  });

  it.each(['Test creature', 'Creature alias'])('shares the resolved internal ID for a static card named %s', async name => {
    const { setCreatureSpawnNavigation } = await import('../src/creature-spawn-navigation');
    const navigate = vi.fn(() => true);
    setCreatureSpawnNavigation({ resolve: () => ({ canNavigate: true, missing: [] }), navigate });
    const { buildExtendedCreatureSectionByName } = await import('../src/extended-info');
    const section = buildExtendedCreatureSectionByName(name);
    document.body.append(section);
    await vi.waitFor(() => expect(section.querySelectorAll('.creature-spawn-link')).toHaveLength(2));
    const links = [...section.querySelectorAll<HTMLButtonElement>('.creature-spawn-link')];
    links[0].click();
    links[1].click();
    expect(navigate).toHaveBeenNthCalledWith(1, spawn, links[0], 'normal', 'test');
    expect(navigate).toHaveBeenNthCalledWith(2, ngplus, links[1], 'ng-plus', 'test');
  });

  it.each(['authenticated', 'isSubscriber'] as const)('refuses a stale spawn action after losing %s', async access => {
    const { setCreatureSpawnNavigation } = await import('../src/creature-spawn-navigation');
    const navigate = vi.fn(() => true);
    setCreatureSpawnNavigation({ resolve: () => ({ canNavigate: true, missing: [] }), navigate });
    const section = await card();
    const links = [...section.querySelectorAll<HTMLButtonElement>('.creature-spawn-link')];
    expect(links).toHaveLength(2);
    auth[access] = false; // Click before an auth subscriber gets a chance to replace the card body.
    for (const link of links) link.click();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('keeps unmatched names in the link and explicitly lists what the map cannot show', async () => {
    const { setCreatureSpawnNavigation } = await import('../src/creature-spawn-navigation');
    setCreatureSpawnNavigation({
      resolve: raw => ({ canNavigate: true, missing: raw === spawn ? ['Pyramid'] : ['Unknown region'] }),
      navigate: () => true,
    });
    const section = await card();
    expect(section.querySelector('.creature-spawn-link')?.textContent).toBe('Pyramide, Temple of the Art, Tower');
    expect([...section.querySelectorAll('.creature-spawn-missing')].map(node => node.textContent)).toEqual([
      'Not shown on this map: Pyramide', 'Not shown on this map: Unknown region',
    ]);
  });

  it('lets the host withhold NG+ links when only normal-world boundaries are available', async () => {
    const { setCreatureSpawnNavigation } = await import('../src/creature-spawn-navigation');
    setCreatureSpawnNavigation({
      resolve: (_raw, mode) => ({ canNavigate: mode === 'normal', missing: [] }),
      navigate: () => true,
    });
    const section = await card();
    const links = [...section.querySelectorAll('.creature-spawn-link')];
    expect(links).toHaveLength(1);
    expect(links[0].textContent).toBe('Pyramide, Temple of the Art, Tower');
    expect(section.textContent).toContain(`Spawn (NG+):${ngplus}`);
  });

  it('leaves entirely unavailable lists readable and explains missing regions without a dead action', async () => {
    const { setCreatureSpawnNavigation } = await import('../src/creature-spawn-navigation');
    setCreatureSpawnNavigation({
      resolve: raw => ({ canNavigate: false, missing: raw.split(', ') }), navigate: () => false,
    });
    const section = await card();
    expect(section.querySelector('.creature-spawn-link')).toBeNull();
    expect(section.textContent).toContain('Pyramide, Temple of the Art, Tower');
    expect(section.querySelectorAll('.creature-spawn-missing')).toHaveLength(2);
  });

  it('keeps unsupported-map or unregistered-host cards as plain text', async () => {
    const { navigateCreatureSpawns, resolveCreatureSpawns } = await import('../src/creature-spawn-navigation');
    const section = await card();
    expect(section.querySelector('.creature-spawn-link')).toBeNull();
    expect(section.querySelector('.creature-spawn-missing')).toBeNull();
    expect(section.textContent).toContain('Pyramide, Temple of the Art, Tower');
    expect(resolveCreatureSpawns(spawn)).toEqual({ canNavigate: false, missing: [] });
    expect(navigateCreatureSpawns(spawn, section)).toBe(false);
  });

  it('refreshes existing visible cards when the host registers or removes navigation', async () => {
    const section = await card();
    const { setCreatureSpawnNavigation } = await import('../src/creature-spawn-navigation');
    setCreatureSpawnNavigation({ resolve: () => ({ canNavigate: true, missing: [] }), navigate: () => true });
    await vi.waitFor(() => expect(section.querySelectorAll('.creature-spawn-link')).toHaveLength(2));
    setCreatureSpawnNavigation(null);
    await vi.waitFor(() => expect(section.querySelector('.extended-info-creature')).not.toBeNull());
    expect(section.querySelector('.creature-spawn-link')).toBeNull();
  });

  it('defers registration updates for hidden static cards until their next hover', async () => {
    const section = await card();
    const popup = document.createElement('div');
    popup.className = 'osOverlayPopup';
    popup.style.visibility = 'hidden';
    document.body.append(popup); popup.append(section);
    const { setCreatureSpawnNavigation } = await import('../src/creature-spawn-navigation');
    setCreatureSpawnNavigation({ resolve: () => ({ canNavigate: true, missing: [] }), navigate: () => true });
    expect(section.dataset.langStale).toBe('1');
    expect(section.querySelector('.creature-spawn-link')).toBeNull();
    popup.style.visibility = 'visible';
    popup.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    await vi.waitFor(() => expect(section.querySelectorAll('.creature-spawn-link')).toHaveLength(2));
    expect(section.dataset.langStale).toBeUndefined();
  });
});
