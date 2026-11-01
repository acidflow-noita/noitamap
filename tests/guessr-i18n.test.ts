// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

function storage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, String(value)); },
    removeItem: key => { values.delete(key); },
    clear: () => values.clear(),
    key: index => [...values.keys()][index] ?? null,
  };
}
beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('localStorage', storage());
  vi.stubGlobal('sessionStorage', storage());
  document.cookie = 'i18next=; Max-Age=0; path=/';
  history.replaceState(null, '', '/guess/?lng=en');
  document.body.replaceChildren();
  document.documentElement.lang = 'en';
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')));
});
afterEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  document.cookie = 'i18next=; Max-Age=0; path=/';
  history.replaceState(null, '', '/');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('shared Guessr translation lifecycle', () => {
  it('initializes once even when Guessr and authentication start together, then keeps the selected language', async () => {
    const { default: i18n, initializeTranslations } = await import('../src/i18n');
    const { initializeGuessrTranslations } = await import('../src/guessr/i18n');
    const initialized = vi.fn();
    i18n.on('initialized', initialized);
    const first = initializeTranslations();
    expect(initializeTranslations()).toBe(first);
    await Promise.all([first, initializeGuessrTranslations()]);
    i18n.addResourceBundle('fr', 'translation', { greeting: 'Bonjour' });
    i18n.addResourceBundle('fr', 'guessr', { Language: 'Langue' });
    await i18n.changeLanguage('fr');
    await Promise.all([initializeTranslations(), initializeGuessrTranslations()]);
    expect(initialized).toHaveBeenCalledOnce();
    expect(i18n.language).toBe('fr');
    expect(window.localStorage.getItem('i18nextLng')).toBe('fr');
    history.replaceState(null, '', '/');
    expect(document.cookie).toContain('i18next=fr');
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['pt-BR', 'br'], ['pt-PT', 'br'], ['zh-Hant-TW', 'zh'], ['fr-CA', 'fr'], ['JA_jp', 'ja'],
  ])('detects the supported language for %s', async (requested, expected) => {
    history.replaceState(null, '', `/guess/?lng=${requested}`);
    const { default: i18n, initializeTranslations } = await import('../src/i18n');
    await initializeTranslations();
    expect(i18n.language).toBe(expected);
    expect(window.localStorage.getItem('i18nextLng')).toBe(expected);
  });

  it('honors a remembered choice before navigator detection on both page paths', async () => {
    history.replaceState(null, '', '/guess/');
    window.localStorage.setItem('i18nextLng', 'de-DE');
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['pt-BR']);
    const { default: i18n, initializeTranslations } = await import('../src/i18n');
    await initializeTranslations();
    expect(i18n.language).toBe('de');
    history.replaceState(null, '', '/');
    expect(document.cookie).toContain('i18next=de');
  });

  it('uses navigator detection when there is no explicit or remembered language', async () => {
    history.replaceState(null, '', '/guess/');
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['pt-BR', 'en-US']);
    const { default: i18n, initializeTranslations } = await import('../src/i18n');
    await initializeTranslations();
    expect(i18n.language).toBe('br');
  });

  it('loads only the selected additional namespace before announcing a language change', async () => {
    const { default: i18n, initializeTranslations, registerTranslationNamespace } = await import('../src/i18n');
    let finish!: (resource: Record<string, string>) => void;
    const load = vi.fn(() => new Promise<Record<string, string>>(resolve => { finish = resolve; }));
    registerTranslationNamespace('fixture', { greeting: 'Hello' }, load);
    await initializeTranslations();
    expect(load).not.toHaveBeenCalled();
    const changed = vi.fn();
    i18n.on('languageChanged', changed);
    const changing = i18n.changeLanguage('fr');
    await vi.waitFor(() => expect(load).toHaveBeenCalledExactlyOnceWith('fr'));
    expect(changed).not.toHaveBeenCalled();
    finish({ greeting: 'Bonjour' });
    await changing;
    expect(changed).toHaveBeenCalledExactlyOnceWith('fr');
    expect(i18n.t('greeting', { ns: 'fixture' })).toBe('Bonjour');
    await i18n.changeLanguage('en');
    await i18n.changeLanguage('fr');
    expect(load).toHaveBeenCalledOnce();
  });

  it('registers Guessr after map initialization without restarting the shared instance', async () => {
    const { default: i18n, initializeTranslations } = await import('../src/i18n');
    await initializeTranslations();
    const initialized = vi.fn();
    i18n.on('initialized', initialized);
    const { initializeGuessrTranslations, tr } = await import('../src/guessr/i18n');
    await initializeGuessrTranslations();
    expect(tr('Language: {{language}}', { language: 'English' })).toBe('Language: English');
    expect(initialized).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('Guessr text and game terminology', () => {
  it('localizes the actual curated areas and preserves every separate room, realm and depth', async () => {
    const { default: i18n } = await import('../src/i18n');
    const { initializeGuessrTranslations, guessrGameTerm } = await import('../src/guessr/i18n');
    await initializeGuessrTranslations();
    const russian = JSON.parse(readFileSync('src/locales/ru/translation.json', 'utf8'));
    const guessr = JSON.parse(readFileSync('src/guessr/locales/ru.json', 'utf8'));
    i18n.addResourceBundle('ru', 'translation', russian);
    i18n.addResourceBundle('ru', 'guessr', guessr);
    await i18n.changeLanguage('ru');
    const puzzleAreas = JSON.parse(readFileSync('tests/fixtures/guessr-area-labels.json', 'utf8')) as {
      label: string; translationKey: string | null;
    }[];
    const translated = puzzleAreas.map(area => {
      const value = guessrGameTerm(area.label, area.translationKey ?? undefined);
      // The current public result protocol carries only the label; explicit
      // metadata and its reviewed label alias must produce the same result.
      expect(guessrGameTerm(area.label), area.label).toBe(value);
      if (area.translationKey?.startsWith('biome_')) expect(value).toContain(russian.gameContent.biomes[area.translationKey]);
      expect(value).not.toMatch(/mountain_tree|gourd_room|watercave/);
      return value;
    });
    expect(puzzleAreas).toHaveLength(44);
    expect(new Set(translated).size).toBe(44);
    expect(guessrGameTerm('extremely dense rock', 'mat_rock_hard_border')).toBe(russian.gameContent.materials.rock_hard_border);
    expect(guessrGameTerm('Ylialkemisti (boss room)', 'animal_boss_alchemist')).toContain(russian.gameContent.items.animal_boss_alchemist);
    expect(guessrGameTerm('mines')).toBe(russian.gameContent.biomes.biome_coalmine);
    expect(guessrGameTerm('The Tower')).toBe(russian.gameContent.biomes.biome_tower);
    expect(guessrGameTerm('mountain_tree')).toBe(russian.extended.spawn.giant_tree);
    expect(guessrGameTerm('gourd_room')).toBe('Gourd Cave');
    expect(guessrGameTerm('watercave')).toBe('Dark Cave');
    expect(guessrGameTerm('Infinite Hiidet elevator')).toContain('Hiidet');
    expect(guessrGameTerm('Infinite Hiidet elevator')).not.toBe('Infinite Hiidet elevator');
    expect(guessrGameTerm('Holy Mountain (lowest, beside Kolmi)')).toContain('Колмисильмя');
    expect(guessrGameTerm('An unknown proper name')).toBe('An unknown proper name');
    await i18n.changeLanguage('en');
    expect(guessrGameTerm('The Tower', 'biome_tower')).toBe('The Tower');
  });

  it('keeps friendly area names before startup and accepts an existing translated realm label', async () => {
    const { default: i18n } = await import('../src/i18n');
    const { initializeGuessrTranslations, guessrGameTerm } = await import('../src/guessr/i18n');
    expect(guessrGameTerm('mountain_tree')).toBe('Giant Tree');
    expect(guessrGameTerm('gourd_room')).toBe('Gourd Cave');
    expect(guessrGameTerm('watercave')).toBe('Dark Cave');
    expect(guessrGameTerm('The Tower')).toBe('The Tower');
    await initializeGuessrTranslations();
    i18n.addResourceBundle('fr', 'translation', { gameContent: { biomes: {
      'The Work (Hell)': 'L’Œuvre (Enfer)', biome_boss_victoryroom: 'L’Œuvre',
    } } });
    i18n.addResourceBundle('fr', 'guessr', {});
    await i18n.changeLanguage('fr');
    expect(guessrGameTerm('The Work (Hell)', 'biome_boss_victoryroom')).toBe('L’Œuvre (Enfer)');
  });

  it('reuses reviewed same-biome map aliases when an extra language has only an English canonical slot', async () => {
    const { default: i18n } = await import('../src/i18n');
    const { initializeGuessrTranslations, guessrGameTerm } = await import('../src/guessr/i18n');
    await initializeGuessrTranslations();
    for (const language of ['fi', 'nl', 'id', 'cs']) {
      i18n.addResourceBundle(language, 'translation', JSON.parse(readFileSync(`src/locales/${language}/translation.json`, 'utf8')));
      i18n.addResourceBundle(language, 'guessr', JSON.parse(readFileSync(`src/guessr/locales/${language}.json`, 'utf8')));
    }
    await i18n.changeLanguage('fi');
    expect(guessrGameTerm('mines', 'biome_coalmine')).toBe('Kaivokset');
    expect(guessrGameTerm('Coal Pits')).toBe('Hiilikaivokset');
    expect(guessrGameTerm('Holy Mountain (depth 2)')).toContain('Pyhä vuori');
    // The existing spawn alias explicitly describes Hell, so it cannot become
    // the base of the Heaven area just because both share a canonical key.
    expect(guessrGameTerm('The Work (Heaven)')).not.toContain('helvetti');
    i18n.addResource('fi', 'translation', 'gameContent.biomes.biome_coalmine', 'Canonical fixture');
    expect(guessrGameTerm('mines', 'biome_coalmine')).toBe('Canonical fixture');
    await i18n.changeLanguage('nl');
    expect(guessrGameTerm('mines')).toBe('Mijnen');
    expect(guessrGameTerm('The Tower')).toBe('De Toren');
    await i18n.changeLanguage('id');
    expect(guessrGameTerm('mines')).toBe('Tambang');
    await i18n.changeLanguage('cs');
    expect(guessrGameTerm('Coal Pits')).toBe('Uhelné doly');
    expect(guessrGameTerm('The Tower')).toBe('Tower');
  });

  it('prefers vetted map translations without overriding context-specific labels or accepting English placeholders', async () => {
    const { default: i18n } = await import('../src/i18n');
    const { initializeGuessrTranslations, tr } = await import('../src/guessr/i18n');
    await initializeGuessrTranslations();
    i18n.addResourceBundle('fi', 'translation', JSON.parse(readFileSync('src/locales/fi/translation.json', 'utf8')));
    i18n.addResourceBundle('fi', 'guessr', {
      Back: 'Guessr navigation draft', Close: 'Sulje', Daily: 'Päivähaaste', Cancel: 'Peruuta',
      'Gift Pro on Twitch': 'Lahjoita Pro Twitchissä',
    });
    await i18n.changeLanguage('fi');
    expect(tr('Back')).toBe('Takaisin');
    expect(tr('Close')).toBe('Sulje');
    expect(tr('Daily')).toBe(JSON.parse(readFileSync('src/locales/fi/translation.json', 'utf8')).dynamicMap.daily);
    expect(tr('Cancel')).toBe('Peruuta');
    expect(tr('Gift Pro on Twitch')).toBe('Lahjoita Pro Twitchissä');
  });

  it('changes text and attributes in place while preserving inputs, nodes and event handlers', async () => {
    const { default: i18n } = await import('../src/i18n');
    const { bindText, bindAttribute, initializeGuessrTranslations, onGuessrLanguageChanged } = await import('../src/guessr/i18n');
    await initializeGuessrTranslations();
    const panel = document.createElement('section');
    const input = document.createElement('input');
    input.value = 'keep-channel-123';
    const button = bindText(document.createElement('button'), 'Initial action');
    bindText(button, 'Confirm {{round}}', () => ({ round: 2 }));
    bindAttribute(input, 'placeholder', 'Channel name');
    const action = vi.fn();
    button.addEventListener('click', action);
    panel.append(input, button);
    document.body.append(panel);
    input.focus();
    input.setSelectionRange(2, 7);
    const update = vi.fn();
    const removeUpdate = onGuessrLanguageChanged(update);
    i18n.addResourceBundle('fr', 'translation', {});
    i18n.addResourceBundle('fr', 'guessr', { 'Confirm {{round}}': 'Valider {{round}}', 'Channel name': 'Nom de la chaîne' });
    await i18n.changeLanguage('fr');
    expect(document.querySelector('section')).toBe(panel);
    expect(document.querySelector('button')).toBe(button);
    expect(button.textContent).toBe('Valider 2');
    expect(input.placeholder).toBe('Nom de la chaîne');
    expect(input.value).toBe('keep-channel-123');
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(2);
    expect(input.selectionEnd).toBe(7);
    button.click();
    expect(action).toHaveBeenCalledOnce();
    expect(update).toHaveBeenCalledOnce();
    expect(document.documentElement.lang).toBe('fr');
    removeUpdate();
    await i18n.changeLanguage('en');
    expect(button.textContent).toBe('Confirm 2');
    expect(update).toHaveBeenCalledOnce();
  });

  it('uses locale plural categories and Portuguese formatting for the legacy br resource code', async () => {
    const { default: i18n } = await import('../src/i18n');
    const { initializeGuessrTranslations, tr, guessrLocale, formatGuessrNumber } = await import('../src/guessr/i18n');
    await initializeGuessrTranslations();
    i18n.addResourceBundle('ru', 'translation', {});
    i18n.addResourceBundle('ru', 'guessr', {
      '{{count}} guesses_one': '{{count}} попытка', '{{count}} guesses_few': '{{count}} попытки',
      '{{count}} guesses_many': '{{count}} попыток', '{{count}} guesses_other': '{{count}} попытки',
    });
    await i18n.changeLanguage('ru');
    expect(tr('{{count}} guesses', { count: 1 })).toBe('1 попытка');
    expect(tr('{{count}} guesses', { count: 2 })).toBe('2 попытки');
    expect(tr('{{count}} guesses', { count: 5 })).toBe('5 попыток');
    i18n.addResourceBundle('br', 'translation', {});
    i18n.addResourceBundle('br', 'guessr', {
      '{{count}} guesses_one': '{{count}} palpite', '{{count}} guesses_other': '{{count}} palpites',
    });
    await i18n.changeLanguage('br');
    expect(tr('{{count}} guesses', { count: 0 })).toBe('0 palpite');
    expect(tr('{{count}} guesses', { count: 1 })).toBe('1 palpite');
    expect(tr('{{count}} guesses', { count: 2 })).toBe('2 palpites');
    expect(guessrLocale()).toBe('pt-BR');
    expect(formatGuessrNumber(1234.5)).toBe(new Intl.NumberFormat('pt-BR').format(1234.5));
    expect(tr('!guess {{x}} {{y}}', { x: 1234, y: -5678 })).toBe('!guess 1234 -5678');
  });

  it('uses the existing canonical biome translation and leaves unknown proper names unchanged', async () => {
    const { default: i18n } = await import('../src/i18n');
    const { initializeGuessrTranslations, guessrGameTerm } = await import('../src/guessr/i18n');
    await initializeGuessrTranslations();
    const russian = JSON.parse(readFileSync('src/locales/ru/translation.json', 'utf8'));
    i18n.addResourceBundle('ru', 'translation', russian);
    i18n.addResourceBundle('ru', 'guessr', {});
    await i18n.changeLanguage('ru');
    expect(guessrGameTerm('Coal Pits')).toBe(russian.gameContent.biomes.biome_excavationsite);
    expect(guessrGameTerm('Coal Pits', 'biome_excavationsite')).toBe(russian.gameContent.biomes.biome_excavationsite);
    expect(guessrGameTerm('Uncatalogued room')).toBe('Uncatalogued room');
  });

  it('treats punctuation and interpolated user content literally instead of HTML or namespace syntax', async () => {
    const { default: i18n } = await import('../src/i18n');
    const { initializeGuessrTranslations, bindText } = await import('../src/guessr/i18n');
    await initializeGuessrTranslations();
    i18n.addResourceBundle('en', 'guessr', { 'Round: {{name}}.': 'Round: {{name}}.' });
    const node = bindText(document.createElement('span'), 'Round: {{name}}.', { name: '<img src=x onerror=alert(1)>' });
    expect(node.textContent).toBe('Round: <img src=x onerror=alert(1)>.');
    expect(node.children).toHaveLength(0);
  });
});

describe('shared language selector', () => {
  it('uses every map language, accepts flag clicks, and disposes its Bootstrap instance with the header', async () => {
    const { default: i18n, SUPPORTED_LANGUAGES } = await import('../src/i18n');
    const { initializeGuessrTranslations } = await import('../src/guessr/i18n');
    const { createGuessrLanguagePicker, disposeGuessrLanguagePickers } = await import('../src/guessr/language-picker');
    const { default: Combobox } = await import('bootstrap/js/dist/combobox.js');
    await initializeGuessrTranslations();
    const errors = vi.spyOn(console, 'error');
    const picker = createGuessrLanguagePicker();
    document.body.append(picker);
    const button = picker.querySelector('button')!;
    const choices = [...picker.querySelectorAll<HTMLElement>('[data-lang]')];
    expect(choices.map(choice => choice.dataset.lang)).toEqual(Object.keys(SUPPORTED_LANGUAGES));
    expect(button.getAttribute('aria-label')).toBe('Language: English');
    expect(button.getAttribute('role')).toBe('combobox');
    expect(button.getAttribute('aria-haspopup')).toBe('listbox');
    expect(picker.querySelector('.menu')?.getAttribute('role')).toBe('listbox');
    expect(picker.querySelector('[aria-selected="true"]')?.getAttribute('data-lang')).toBe('en');
    expect(errors).not.toHaveBeenCalled();
    button.click();
    await vi.waitFor(() => expect(button.getAttribute('aria-expanded')).toBe('true'));
    button.click();
    await vi.waitFor(() => expect(button.getAttribute('aria-expanded')).toBe('false'));
    button.click();
    await vi.waitFor(() => expect(button.getAttribute('aria-expanded')).toBe('true'));
    document.body.click();
    await vi.waitFor(() => expect(button.getAttribute('aria-expanded')).toBe('false'));
    i18n.addResourceBundle('fr', 'translation', {});
    i18n.addResourceBundle('fr', 'guessr', { 'Language: {{language}}': 'Langue : {{language}}' });
    picker.querySelector('[data-lang="fr"] img')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(i18n.language).toBe('fr'));
    expect(button.getAttribute('aria-label')).toBe('Langue : Français');
    expect(picker.querySelector('[aria-selected="true"]')?.getAttribute('data-lang')).toBe('fr');
    expect(window.localStorage.getItem('i18nextLng')).toBe('fr');
    expect(new URL(location.href).searchParams.get('lng')).toBe('fr');
    expect(Combobox.getInstance(button)).not.toBeNull();
    disposeGuessrLanguagePickers(document.body);
    expect(Combobox.getInstance(button)).toBeNull();
    await i18n.changeLanguage('en');
    expect(button.getAttribute('aria-label')).toBe('Langue : Français');
  });
});
