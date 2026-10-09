import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInstance } from 'i18next';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import JSZip from 'jszip';
import { SPAWNER_SPAWNS } from '../src/telescope/spawner-spawns';

const { translator } = vi.hoisted(() => ({ translator: { current: null as any } }));
vi.mock('../src/i18n', () => ({ default: new Proxy({}, {
  get(_target, key) {
    const value = translator.current[key];
    return typeof value === 'function' ? value.bind(translator.current) : value;
  },
}) }));
import { getPOISpawnDetails } from '../src/telescope/poi-spawn-details';
let getPOIDisplayName: typeof import('../src/telescope/poi-display-name').getPOIDisplayName;

const root = resolve(__dirname, '..');
const locales = Object.fromEntries(readdirSync(resolve(root, 'src/locales')).map(locale => [locale,
  JSON.parse(readFileSync(resolve(root, 'src/locales', locale, 'translation.json'), 'utf8'))]));
const spawner = (entity: string) => getPOISpawnDetails({ type: 'entity', entity }, true)!;

beforeAll(async () => {
  translator.current = createInstance();
  await translator.current.init({ lng: 'en', fallbackLng: 'en', resources:
    Object.fromEntries(Object.entries(locales).map(([locale, translation]) => [locale, { translation }])) });
  ({ getPOIDisplayName } = await import('../src/telescope/poi-display-name'));
});
beforeEach(async () => { await translator.current.changeLanguage('en'); });

describe('spawner card details', () => {
  it.each([
    ['ghost_crystal', 'ghost'], ['physics_cocoon', 'worm'], ['flynest', 'fly'],
    ['spidernest', 'longleg'], ['lukki_eggs', 'lukki_tiny'],
  ])('labels the fixed offspring of %s as Spawns', (entity, offspring) => {
    expect(spawner(entity)).toMatchObject({ heading: 'Spawns', outcomes: [[offspring, 1]] });
    expect(spawner(`data/entities/buildings/${entity}.xml`)).toEqual(spawner(entity));
  });

  it('keeps exact random odds and distinguishes illusions from real creatures', () => {
    expect(spawner('firebugnest')).toMatchObject({ heading: 'Possible spawns',
      outcomes: [['firebug', 1, 4, 5], ['bigfirebug', 1, 1, 5]] });
    const illusions = spawner('snowcrystal');
    expect(illusions.heading).toBe('Possible illusions');
    expect(illusions.outcomes).toHaveLength(8);
    expect(illusions.outcomes.every(row => row[2] === 1 && row[3] === 8)).toBe(true);
    expect(getPOISpawnDetails({ type: 'item', item: 'egg_worm' }, true)).toMatchObject({
      heading: 'Possible spawns', outcomes: [['worm_tiny', 1, 343, 512], ['worm', 1, 147, 512], ['worm_big', 1, 11, 256]],
    });
    expect(getPOISpawnDetails({ type: 'item', item: 'egg_hollow' }, true)).toMatchObject({
      outcomes: [], notes: ['No creatures hatch from this egg.'],
    });
  });

  it('does not describe a whole nest or a repeatedly hit Lukki egg as a single guaranteed hatchling', () => {
    expect(spawner('spidernest').notes[0]).toBe(
      'Checks every 101 game frames. Each check has a 75/101 chance to spawn one if the player is less than 200 pixels away, up to 15 in total.');
    expect(spawner('physics_cocoon').notes).toEqual(['Releases one when destroyed; damage can release it early.']);
    expect(spawner('lukki_eggs').notes).toEqual([
      'Releases one per triggering hit. Repeated hits can release more before the egg is destroyed.',
    ]);
  });

  it('keeps excluded statues, bosses and creature offspring out of spawner cards', () => {
    for (const entity of ['statue_trap_left', 'statue_trap_right', 'dragon', 'giantshooter', 'blob', 'zombie'])
      expect(spawner(entity)).toBeUndefined();
  });

  it.each(Object.keys(locales))('translates every explanation and reuses official creature keys in %s', async locale => {
    await translator.current.changeLanguage(locale);
    const copy = locales[locale].poi;
    const keys = ['spawns', 'possibleSpawns', 'possibleIllusions', 'eggHatch', 'noEggSpawns',
      'nestSpawnLimit', 'spawnChancePerCreature', 'cocoonSpawns', 'snowCrystalSpawns', 'lukkiEggSpawns'];
    for (const key of keys) {
      expect(copy[key]?.trim(), key).toBeTruthy();
      if (locale !== 'en') expect(copy[key], key).not.toBe(locales.en.poi[key]);
    }
    expect(spawner('ghost_crystal').heading).toBe(copy.spawns);
    expect(spawner('lukki_eggs').notes).toEqual([copy.lukkiEggSpawns]);
    expect(spawner('physics_cocoon').notes).toEqual([copy.cocoonSpawns]);
    expect(spawner('snowcrystal')).toMatchObject({ heading: copy.possibleIllusions, notes: [copy.snowCrystalSpawns] });
    expect(getPOISpawnDetails({ type: 'item', item: 'egg_worm' }, true)).toMatchObject({ heading: copy.possibleSpawns, notes: [copy.eggHatch] });
    expect(getPOISpawnDetails({ type: 'item', item: 'egg_hollow' }, true)?.notes).toEqual([copy.noEggSpawns]);
    for (const entity of ['flynest', 'spidernest', 'firebugnest']) {
      const info = SPAWNER_SPAWNS[entity]!;
      const details = spawner(entity);
      for (const token of [String(info.maxSpawns), String(info.spawnCheck!.frames), '75/101', '200'])
        expect(details.notes[0]).toContain(token);
      expect(details.notes[0]).not.toContain('{{');
      if (entity === 'firebugnest') expect(details.notes[1]).toBe(copy.spawnChancePerCreature);
    }
    for (const info of Object.values(SPAWNER_SPAWNS)) for (const [entity] of info!.outcomes) {
      const key = `animal_${entity}`;
      const official = locales[locale].gameContent.ui[key] ?? locales[locale].gameContent.items[key];
      expect(official, key).toBeTruthy();
      expect(getPOIDisplayName({ type: 'entity', entity }).normalize('NFC')).toBe(official.normalize('NFC'));
    }
  });

  it('matches nest limits, check intervals and offspring in the actual game scripts', async () => {
    const archive = await JSZip.loadAsync(readFileSync(resolve(root, 'public/data.zip')));
    for (const entity of ['spidernest', 'flynest', 'firebugnest']) {
      const info = SPAWNER_SPAWNS[entity]!;
      const script = await archive.file(`data/scripts/buildings/${entity}.lua`)!.async('string');
      const xml = await archive.file(`data/entities/buildings/${entity}.xml`)!.async('string');
      expect(Number(script.match(/spawned_entities\s*<\s*(\d+)/)![1])).toBe(info.maxSpawns);
      expect(Number(xml.match(/execute_every_n_frame="(\d+)"/)![1])).toBe(info.spawnCheck!.frames);
      expect(Number(script.match(/spawn_distance\s*=\s*(\d+)/)![1])).toBe(info.spawnCheck!.distance);
      expect(script).toMatch(/Random\(0,100\)\s*<\s*75/);
      for (const [offspring] of info.outcomes) expect(script).toContain(`data/entities/animals/${offspring}.xml`);
    }
    const lukki = await archive.file('data/scripts/buildings/lukki_eggs.lua')!.async('string');
    expect(lukki).toContain('data/entities/animals/lukki/lukki_tiny.xml');
    expect(lukki).toMatch(/damage\s*>\s*0\.1/);
    expect(lukki).not.toContain('EntityKill');
  });
});
