// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const actualCreatures = JSON.parse(readFileSync('public/assets/full_creatures.json', 'utf8')) as Array<Record<string, any>>;

const state = vi.hoisted(() => ({
  pro: true,
  language: 'en',
  authListeners: [] as Array<() => void>,
  languageListeners: [] as Array<() => void>,
}));
vi.mock('../src/auth/auth-service', () => ({ authService: {
  getState: () => ({ authenticated: state.pro, isSubscriber: state.pro }),
  subscribe: (listener: () => void) => {
    state.authListeners.push(listener);
    return () => { state.authListeners = state.authListeners.filter(value => value !== listener); };
  },
} }));
vi.mock('../src/auth/auth-ui', () => ({ AuthUI: { showGetProModal: vi.fn() } }));
vi.mock('../src/i18n', () => ({ default: {
  t(key: string, options: string | { defaultValue?: string | null } = {}) {
    if (key === 'gameContent.materials.blood') return state.language === 'ru' ? 'Кровь' : 'Blood';
    if (key === 'gameContent.materials.meat') return state.language === 'ru' ? 'Мясо' : 'Meat';
    if (key === 'extended.openInBartender' && state.language === 'ru') return 'Открыть в Bartender';
    return typeof options === 'string' ? options : options.defaultValue ?? key;
  },
  on(event: string, listener: () => void) {
    if (event === 'languageChanged') state.languageListeners.push(listener);
  },
} }));

class Popover {
  static instances = new Map<Element, Popover>();
  static getInstance(element: Element) { return this.instances.get(element) ?? null; }
  dispose = vi.fn(() => { Popover.instances.delete(this.element); });
  hide = vi.fn();
  constructor(readonly element: Element, readonly config: Record<string, any>) {
    Popover.instances.set(element, this);
  }
}

const creature = {
  id: 'test_creature', name: 'Test creature', category: 'Humanoid', faction: 'mage',
  health: '125', attackType: 'Projectile, Melee', dmgMultMelee: '0.5x',
  blood: 'Wiki blood name', blood_material_id: 'blood',
  corpse: 'Wiki meat name', corpse_material_id: 'meat',
  spawnLocation: 'Coal Pits, Snowy Depths', dmgMultNotes: 'Receives extra damage while wet.',
};

describe('Bartender links in POI cards', () => {
  beforeEach(() => {
    vi.resetModules();
    state.pro = true; state.language = 'en';
    state.authListeners = []; state.languageListeners = [];
    Popover.instances.clear();
    vi.stubGlobal('bootstrap', { Popover });
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
      ok: true,
      json: async () => url.includes('full_creatures') ? [creature]
        : url.includes('full_materials') ? [{ id: 'blood', type: 'Liquid', density: 3, tags: ['[liquid]'] }]
          : url.includes('reaction_roles') ? { blood: [2, 3] } : [],
    })));
  });
  afterEach(async () => {
    const { dismissPopovers } = await import('../src/popover-util');
    dismissPopovers(document.body);
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  async function card(kind: 'creature' | 'material' = 'creature') {
    const { buildExtendedSection } = await import('../src/extended-info');
    const section = buildExtendedSection(kind, kind === 'creature' ? 'test_creature' : 'blood');
    document.body.appendChild(section);
    await vi.waitFor(() => expect(section.querySelector('.bartender-link')).not.toBeNull());
    return section;
  }

  it('keeps translated material links and their native navigation, with branded hover/focus help', async () => {
    state.language = 'ru';
    const section = await card();
    const links = [...section.querySelectorAll<HTMLAnchorElement>('.bartender-link')];
    expect(links.map(link => link.textContent)).toEqual(['Кровь', 'Мясо']);
    expect(links.map(link => link.href)).toEqual([
      'https://bartender.runfast.stream/reactions?reagents=blood',
      'https://bartender.runfast.stream/reactions?reagents=meat',
    ]);
    for (const link of links) {
      // Only the visible anchor owns hover help, never the full grid value
      // or label row. This stays true in both static and dynamic POI cards.
      expect(link.parentElement?.classList.contains('extended-info-value')).toBe(true);
      expect(Popover.getInstance(link.parentElement!)).toBeNull();
      expect(Popover.getInstance(link.closest('.extended-info-row')!)).toBeNull();
      expect(link.target).toBe('_blank');
      expect(link.rel).toBe('noopener noreferrer');
      expect(link.getAttribute('aria-label')).toContain('Открыть в Bartender');
      const instance = Popover.getInstance(link)!;
      expect(instance.config).toMatchObject({
        trigger: 'hover focus', container: 'body', html: true, delay: { show: 80, hide: 120 },
      });
      const title = instance.config.title as HTMLElement;
      expect(title.querySelector('img')?.getAttribute('src')).toBe('./assets/Bartender_logo.svg');
      expect(title.querySelector('img')?.alt).toBe('Bartender');
      expect(instance.config.content.textContent).toBe('View reactions that use this material in Bartender.');
      const click = new MouseEvent('click', { bubbles: true, cancelable: true });
      link.addEventListener('click', event => expect(event.defaultPrevented).toBe(false));
      // Capture the event in a detached parent to avoid invoking jsdom navigation.
      const parent = document.createElement('div'); parent.appendChild(link);
      parent.addEventListener('click', event => event.preventDefault());
      link.dispatchEvent(click);
      section.appendChild(parent);
    }
  });

  it('distinguishes reagent and product help without changing the reaction destinations', async () => {
    const section = await card('material');
    const links = [...section.querySelectorAll<HTMLAnchorElement>('.bartender-link')];
    expect(links.map(link => link.textContent)).toEqual(['View as reagent', 'View as product']);
    expect(links[1].href).toBe('https://bartender.runfast.stream/reactions?product=blood');
    expect(Popover.getInstance(links[1])?.config.content.textContent)
      .toBe('View reactions that produce this material in Bartender.');
  });

  it('uses baked inherited material IDs when the creature JSON omits blood and corpse IDs', async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => [{
      id: 'fly', blood: '[[Blood]]', corpse: '[[Meat]]', blood_material_id: null, corpse_material_id: null,
    }] } as Response);
    const { buildExtendedSection } = await import('../src/extended-info');
    const section = buildExtendedSection('creature', 'fly');
    document.body.append(section);
    await vi.waitFor(() => expect(section.querySelectorAll('.bartender-link')).toHaveLength(2));
    expect([...section.querySelectorAll<HTMLAnchorElement>('.bartender-link')].map(link => link.href)).toEqual([
      'https://bartender.runfast.stream/reactions?reagents=blood_fading',
      'https://bartender.runfast.stream/reactions?reagents=meat',
    ]);
  });

  // Real source rows, including the reported seed's scavenger_mine/miner and
  // its working sniper control. "none" is a missing ID, not a material.
  it.each(actualCreatures.filter(c => c.corpse_material_id === 'none' || c.id === 'sniper'))(
    'renders the actual $id corpse row as a material link despite source ID $corpse_material_id', async source => {
      vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => [source] } as Response);
      const { buildExtendedSection } = await import('../src/extended-info');
      const section = buildExtendedSection('creature', source.id);
      document.body.append(section);
      const corpseRow = () => [...section.querySelectorAll('.extended-info-row')]
        .find(row => row.querySelector('.extended-info-label')?.textContent === 'Corpse:');
      await vi.waitFor(() => expect(corpseRow()).toBeDefined());
      const link = corpseRow()!.querySelector<HTMLAnchorElement>('a.bartender-link');
      expect(link).not.toBeNull();
      const expected = source.id === 'maggot_tiny' ? 'material_darkness' : 'meat';
      expect(link!.href).toBe(`https://bartender.runfast.stream/reactions?reagents=${expected}`);
      expect(Popover.getInstance(link!)).not.toBeNull();
      expect(corpseRow()!.querySelector('[href*="reagents=none"]')).toBeNull();
      if (source.id === 'maggot_tiny') expect(corpseRow()!.textContent).toContain('(Disintegrated)');
    },
  );

  it('renders each compound corpse material as its own link and preserves the description', async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => [{
      id: 'boss_pit', corpse: '[[Green Slimy Meat]], [[Glowing Matter]] (Disintegrated)', corpse_material_id: null,
    }] } as Response);
    const { buildExtendedSection } = await import('../src/extended-info');
    const section = buildExtendedSection('creature', 'boss_pit');
    document.body.append(section);
    await vi.waitFor(() => expect(section.querySelectorAll('.bartender-link')).toHaveLength(2));
    const row = section.querySelector('.extended-info-row')!;
    const links = [...row.querySelectorAll<HTMLAnchorElement>('.bartender-link')];
    expect(links.map(link => link.href)).toEqual([
      'https://bartender.runfast.stream/reactions?reagents=meat_slime_green',
      'https://bartender.runfast.stream/reactions?reagents=rock_static_glow',
    ]);
    expect(row.textContent).toContain('Green Slimy Meat, Glowing Matter (Disintegrated)');
  });

  it('keeps a single material qualifier outside its link and removes unresolved Wiki citation markers', async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => [{
      id: 'player', blood: '[[Blood (Fading)]], usually\u007f&#039;&quot;`UNIQ--ref-00000016-QINU`&quot;&#039;\u007f.',
      corpse: '[[Meat]] (Disintegrated)', blood_material_id: null, corpse_material_id: null,
    }] } as Response);
    const { buildExtendedSection } = await import('../src/extended-info');
    const section = buildExtendedSection('creature', 'player');
    document.body.append(section);
    await vi.waitFor(() => expect(section.querySelectorAll('.bartender-link')).toHaveLength(2));
    expect(section.textContent).toContain('Blood (Fading), usually.');
    expect(section.textContent).toContain('Meat (Disintegrated)');
    expect(section.textContent).not.toContain('UNIQ');
    const links = [...section.querySelectorAll('.bartender-link')];
    expect(links[0].textContent).toBe('Blood (Fading)');
    expect(links[1].textContent).toBe('Meat');
  });

  it('gives material category links Wiki help without turning the tags row into a hover target', async () => {
    const section = await card('material');
    const link = section.querySelector<HTMLAnchorElement>('.extended-info-tag-link')!;
    expect(link.href).toBe('https://noita.wiki.gg/wiki/Category:Materials_tagged_with_liquid');
    expect(Popover.getInstance(link)!.config).toMatchObject({ content: 'Open in Noita Wiki', trigger: 'hover focus' });
    expect(Popover.getInstance(link.parentElement!)).toBeNull();
    expect(Popover.getInstance(link.closest('.extended-info-row')!)).toBeNull();
  });

  it('marks numeric stats and prose explicitly, leaving creature/material names as text', async () => {
    const section = await card();
    const rows = [...section.querySelectorAll<HTMLElement>('.extended-info-row')];
    const find = (label: string) => rows.find(row => row.firstElementChild?.textContent === `${label}:`)!;
    expect(find('HP').classList.contains('extended-info-row--numeric')).toBe(true);
    expect(find('Melee').classList.contains('extended-info-row--numeric')).toBe(true);
    expect(find('Melee').lastElementChild?.textContent).toBe('0.5');
    for (const label of ['Attacks', 'Spawn', 'Notes']) {
      expect(find(label).classList.contains('extended-info-row--prose')).toBe(true);
    }
    for (const label of ['Faction', 'Blood', 'Corpse']) {
      expect(find(label).classList.contains('extended-info-row--text')).toBe(true);
    }
  });

  it('allows location-dependent health explanations to span the card', async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => [
      { ...creature, health: 'Normal: 100, Temple of the Art: 350' },
    ] } as Response);
    const section = await card();
    const health = [...section.querySelectorAll<HTMLElement>('.extended-info-row')]
      .find(row => row.firstElementChild?.textContent === 'HP:')!;
    expect(health.classList.contains('extended-info-row--prose')).toBe(true);
    expect(health.lastElementChild?.textContent).toBe('Normal: 100, Temple of the Art: 350');
  });

  it('keeps every damage multiplier and special explanation in one ordered grid', async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => [{
      ...creature,
      dmgMultProjectile: '1x', dmgMultSlice: '0', dmgMultExplosion: '2x',
      dmgMultElectricity: '1x', dmgMultFire: '0.01', dmgMultIce: '1x',
      dmgMultDrill: '1x', dmgMultRadioactive: '1x', dmgMultHoly: 'Immune unless wet',
    }] } as Response);
    const section = await card();
    const grid = section.querySelector('.extended-info-group--stats-grid')!;
    expect(grid.classList.contains('extended-info-group--cols')).toBe(false);
    expect(grid.firstElementChild?.textContent).toBe('Damage multipliers');
    const rows = [...grid.querySelectorAll('.extended-info-row')];
    expect(rows.map(row => row.firstElementChild?.textContent)).toEqual([
      'Melee:', 'Projectile:', 'Slice:', 'Explosion:', 'Electricity:',
      'Fire:', 'Ice:', 'Drill:', 'Radioactive:', 'Holy:',
    ]);
    expect(rows.map(row => row.lastElementChild?.textContent)).toEqual([
      '0.5', '1.0', '0.0', '2.0', '1.0', '0.01', '1.0', '1.0', '1.0', 'Immune unless wet',
    ]);
    expect(rows[9].classList.contains('extended-info-row--prose')).toBe(true);
    expect(section.textContent).toContain('Receives extra damage while wet.');
  });

  it('keeps spell quantities with units numeric without changing their text', async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => [
      { id: 'test_spell', castDelay: '0.17s', speed: '90 px/s', criticalChance: '+5%' },
    ] } as Response);
    const { buildExtendedSection } = await import('../src/extended-info');
    const section = buildExtendedSection('spell', 'test_spell');
    document.body.appendChild(section);
    await vi.waitFor(() => expect(section.querySelectorAll('.extended-info-row')).toHaveLength(3));
    const rows = [...section.querySelectorAll<HTMLElement>('.extended-info-row')];
    expect(rows.every(row => row.classList.contains('extended-info-row--numeric'))).toBe(true);
    expect(rows.map(row => row.lastElementChild?.textContent)).toEqual(['0.17s', '90 px/s', '+5%']);
  });

  it('lets the owning card restore its report and remove observers before opening the Pro modal', async () => {
    state.pro = false;
    const { buildExtendedSection } = await import('../src/extended-info');
    const tooltip = document.createElement('div') as HTMLElement & { __close?: () => void };
    tooltip.className = 'marker-tooltip';
    tooltip.__close = vi.fn(() => tooltip.remove());
    tooltip.appendChild(buildExtendedSection('creature', 'test_creature'));
    document.body.appendChild(tooltip);
    tooltip.querySelector<HTMLButtonElement>('.extended-info-cta')!.click();
    expect(tooltip.__close).toHaveBeenCalledOnce();
    expect(tooltip.isConnected).toBe(false);
  });

  it('disposes previous language panels exactly once and removes current panels on card teardown', async () => {
    const section = await card();
    const previous = [...Popover.instances.values()];
    state.language = 'ru';
    state.languageListeners.forEach(listener => listener());
    await vi.waitFor(() => expect(section.querySelector('.bartender-link')?.textContent).toBe('Кровь'));
    expect(Popover.instances.size).toBe(2);
    previous.forEach(instance => expect(instance.dispose).toHaveBeenCalledOnce());
    const { dismissPopovers } = await import('../src/popover-util');
    const current = [...Popover.instances.values()];
    dismissPopovers(section); dismissPopovers(section);
    expect(Popover.instances.size).toBe(0);
    current.forEach(instance => expect(instance.dispose).toHaveBeenCalledOnce());
  });

  it.each(['closed', 'signed out'])('does not create popovers when lazy data arrives after the card is %s', async action => {
    let resolve!: (data: unknown) => void;
    vi.mocked(fetch).mockResolvedValue({ ok: true, json: () => new Promise(done => { resolve = done; }) } as Response);
    const { buildExtendedSection } = await import('../src/extended-info');
    const section = buildExtendedSection('creature', 'test_creature');
    document.body.appendChild(section);
    await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
    if (action === 'closed') section.remove();
    else { state.pro = false; state.authListeners.forEach(listener => listener()); }
    resolve([creature]);
    await new Promise(done => setTimeout(done, 0));
    expect(Popover.instances.size).toBe(0);
    expect(section.querySelector('.bartender-link')).toBeNull();
    if (action === 'signed out') expect(section.querySelector('.extended-info-cta')).not.toBeNull();
  });

  it('suppresses actionable hover help on touch while keeping the link action available', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    const section = await card();
    const { installPopoverTouchDismiss } = await import('../src/popover-util');
    installPopoverTouchDismiss();
    const link = section.querySelector<HTMLAnchorElement>('.bartender-link')!;
    const show = new Event('show.bs.popover', { bubbles: true, cancelable: true });
    link.dispatchEvent(show);
    expect(show.defaultPrevented).toBe(true);
    const pointer = new Event('pointerup', { bubbles: true, cancelable: true });
    Object.defineProperty(pointer, 'pointerType', { value: 'touch' });
    link.dispatchEvent(pointer);
    expect(pointer.defaultPrevented).toBe(false);
    expect(link.href).toContain('reagents=blood');
  });
});
