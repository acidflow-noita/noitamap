import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createInstance } from "i18next";
import en from "../src/locales/en/translation.json";
import ja from "../src/locales/ja/translation.json";
import ru from "../src/locales/ru/translation.json";
import de from "../src/locales/de/translation.json";
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
const { instance } = vi.hoisted(() => ({ instance: { current: null as any } }));
vi.mock("../src/i18n", () => ({
  default: new Proxy(
    {},
    {
      get(_target, prop) {
        const value = instance.current[prop];
        return typeof value === "function"
          ? value.bind(instance.current)
          : value;
      },
    },
  ),
}));
let getPOIDisplayName: typeof import("../src/telescope/poi-display-name").getPOIDisplayName;
let formatWandName: typeof import("../src/telescope/poi-display-name").formatWandName;
beforeAll(async () => {
  instance.current = createInstance();
  await instance.current.init({
    lng: "en",
    fallbackLng: "en",
    resources: { en: { translation: en }, ja: { translation: ja }, ru: { translation: ru }, de: { translation: de } },
  });
  ({ getPOIDisplayName, formatWandName } = await import("../src/telescope/poi-display-name"));
});
beforeEach(async () => { await instance.current.changeLanguage('en'); });
describe("canonical loot display names", () => {
  it('labels biome shops without changing the separate canonical Secret Shop biome', async () => {
    for (const language of ['en', 'ru', 'ja']) {
      await instance.current.changeLanguage(language);
      expect(getPOIDisplayName({ type: 'shop', name: 'Secret Shop' })).toBe(instance.current.t('poi.biomeShop'));
    }
  });
  it('keeps all five mimic species distinct in item-shaped, nested loot and entity previews', async () => {
    const mimics = [
      ['mimic', 'chest_mimic'], ['chest_leggy', 'chest_leggy'], ['heart_mimic', 'dark_alchemist'],
      ['refresh_mimic', 'shaman_wind'], ['mimic_potion', 'mimic_potion'],
    ];
    for (const language of ['en', 'ru', 'ja']) {
      await instance.current.changeLanguage(language);
      for (const [item, entity] of mimics) {
        const key = `animal_${entity}`;
        const name = instance.current.t(`gameContent.ui.${key}`);
        expect(name).not.toBe(`gameContent.ui.${key}`);
        expect(getPOIDisplayName({ type: 'item', item, name: 'Mimic', parentContainer: 'chest' })).toBe(name);
        expect(getPOIDisplayName({ type: 'entity', entity: `data/entities/animals/${entity}.xml` })).toBe(name);
      }
    }
    await instance.current.changeLanguage('en');
    expect(getPOIDisplayName({ type: 'item', item: 'mimic' })).toBe('Matkija');
    expect(getPOIDisplayName({ type: 'item', item: 'chest_leggy' })).toBe('Jalkamatkatavara');
  });
  it.each([
    ["kammi", "Kammi"],
    ["kuu", "Kuu"],
    ["ukkoskivi", "Ukkoskivi"],
    ["kiuaskivi", "Kiuaskivi"],
    ["paha_silma", "Paha Silmä"],
    ["chaos_die", "Chaos die"],
  ])("translates %s through the real game key", (item, name) => {
    expect(getPOIDisplayName({ type: "item", item })).toBe(name);
  });
  it("preserves spell names, custom wand names, and material identity", () => {
    expect(
      getPOIDisplayName({ type: "item", item: "spell", spell: "NOLLA" }),
    ).toBe("Nolla");
    expect(getPOIDisplayName({ type: "wand", name: "Saha" })).toBe("Saha Wand");
    expect(
      getPOIDisplayName({ type: "item", item: "potion", material: "ambrosia" }),
    ).toBe("Potion · Ambrosia");
    expect(getPOIDisplayName({ type: "chest", chestVariant: "coral" })).toBe(
      "Coral chest",
    );
  });
  it("uses the actual locale for Kammi instead of the raw generator id", async () => {
    await instance.current.changeLanguage("ja");
    expect(getPOIDisplayName({ type: "item", item: "kammi" })).toBe(
      ja.gameContent.ui.item_safe_haven,
    );
    expect(getPOIDisplayName({ type: 'wand' })).toBe(ja.gameContent.ui.item_wand);
    await instance.current.changeLanguage("en");
  });
  it('resolves both Ukkos and entity variants through the same canonical keys as map tooltips', async () => {
    for (const [lang, locale] of [['en', en], ['ja', ja]] as const) {
      await instance.current.changeLanguage(lang);
      for (const entity of ['thundermage', 'thundermage_big']) {
        expect(getPOIDisplayName({ type: 'entity', entity: `data/entities/animals/${entity}.xml`, name: entity }))
          .toBe((locale.gameContent.items as Record<string, string>)[`animal_${entity}`]);
      }
      expect(getPOIDisplayName({ type: 'entity', entity: 'roboguard_big' }))
        .toBe(locale.gameContent.ui.animal_piranha);
    }
    await instance.current.changeLanguage('en');
  });
  it('keeps distinct spell IDs and translates Deathium via its canonical material name', () => {
    expect(getPOIDisplayName({ type: 'item', item: 'spell', spell: 'ALPHA' })).toBe('Alpha');
    expect(getPOIDisplayName({ type: 'item', item: 'spell', spell: 'DIVIDE_10' })).toBe('Divide by 10');
    expect(getPOIDisplayName({ type: 'spell', item: 'DIVIDE_10' })).toBe('Divide by 10');
    expect(getPOIDisplayName({ type: 'item', item: 'potion', material: 'just_death' }))
      .toBe(`Potion · ${en.gameContent.materials.magic_liquid_death}`);
  });
  it('ships both canonical Ukko names in all 16 supported locale files', () => {
    const locales = resolve(import.meta.dirname, '../src/locales');
    const languages = readdirSync(locales);
    expect(languages).toHaveLength(16);
    for (const language of languages) {
      const locale = JSON.parse(readFileSync(resolve(locales, language, 'translation.json'), 'utf8'));
      for (const key of ['animal_thundermage', 'animal_thundermage_big'])
        expect(locale.gameContent.items[key], `${language}:${key}`).toBeTruthy();
    }
  });
});

describe('shared wand names for report, map cards and search', () => {
  it.each(['Rusty', 'Rusty wand', 'Rusty WAND', 'Rusty wand Wand', '  Rusty   wand  '])(
    'keeps one localized suffix for %s', name => {
      expect(formatWandName({ name })).toBe('Rusty Wand');
      expect(getPOIDisplayName({ type: 'wand', name })).toBe('Rusty Wand');
    });

  it('uses the actual search wandName ahead of a generic result name without changing data', () => {
    const poi = { type: 'wand', name: 'Wand', wandName: 'Quick', isTaikasauva: true };
    expect(formatWandName(poi)).toBe('Taikasauva Quick Wand');
    expect(poi).toEqual({ type: 'wand', name: 'Wand', wandName: 'Quick', isTaikasauva: true });
  });

  it.each([['Saha', 'Saha Wand'], ['Huilu', 'Huilu Wand'], ['Kantele', 'Kantele Wand'], ['Wanderer', 'Wanderer Wand']])(
    'preserves named identity %s', (name, expected) => expect(formatWandName({ name })).toBe(expected));

  it('keeps alive-wand identity, including old Taikasauva-only and already formatted records', () => {
    expect(formatWandName({ name: 'Deadly', isTaikasauva: true })).toBe('Taikasauva Deadly Wand');
    expect(formatWandName({ name: 'Taikasauva' })).toBe('Taikasauva');
    expect(formatWandName({ name: 'Taikasauva Deadly wand', isTaikasauva: true })).toBe('Taikasauva Deadly Wand');
    expect(formatWandName({ isTaikasauva: true })).toBe('Taikasauva');
    expect(formatWandName({ name: 'wand wand' })).toBe('Wand');
    expect(formatWandName({})).toBe('Wand');
  });

  it.each([['ru', ru], ['de', de], ['ja', ja]] as const)('uses common.csv terms in %s without duplicate suffixes/prefixes', async (language, locale) => {
    await instance.current.changeLanguage(language);
    const wand = locale.gameContent.ui.item_wand, ghost = locale.gameContent.ui.animal_wand_ghost;
    for (const name of ['Rusty', 'Rusty wand', `Rusty ${wand}`, `Rusty wand ${wand}`]) {
      expect(formatWandName({ name })).toBe(`Rusty ${wand}`);
      expect(formatWandName({ name, isTaikasauva: true })).toBe(`${ghost} Rusty ${wand}`);
    }
    expect(formatWandName({ name: `${ghost} Rusty ${wand}`, isTaikasauva: true })).toBe(`${ghost} Rusty ${wand}`);
    expect(formatWandName({ name: 'Taikasauva' })).toBe(ghost);
    expect(formatWandName({})).toBe(wand);
  });

  it('recognizes an attached Japanese suffix', async () => {
    await instance.current.changeLanguage('ja');
    expect(formatWandName({ name: '古い杖' })).toBe('古い杖');
  });

  it.each([['en', en], ['ru', ru], ['ja', ja], ['de', de]] as const)(
    'retains the real Tower wand names without an extra suffix in %s', async (language, locale) => {
      await instance.current.changeLanguage(language);
      for (const [index, original] of ['Wand of Swiftness', 'Wand of Destruction', 'Wand of Multitudes'].entries()) {
        const expected = (locale.gameContent.ui as Record<string, string>)[`item_wand_good_${index + 1}`];
        const poi = { type: 'wand', sprite: `custom/good_0${index + 1}`, name: original };
        expect(formatWandName(poi)).toBe(expected);
        expect(getPOIDisplayName(poi)).toBe(expected);
        expect(formatWandName({ name: original })).toBe(expected);
      }
    });
});
