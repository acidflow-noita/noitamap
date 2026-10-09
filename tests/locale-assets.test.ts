import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { build } from 'vite';
import { localeAssetsPlugin } from '../build_scripts/vite-locales';
import { compactTelescopeTranslations, telescopeBrowserPlugin } from '../build_scripts/vite-telescope-browser';

const root = resolve(import.meta.dirname, '..');
const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

async function buildLocales(directory: string) {
  const result: any = await build({
    configFile: false, root: directory, logLevel: 'silent',
    plugins: [localeAssetsPlugin(directory)],
    build: {
      write: false, assetsDir: 'build',
      rollupOptions: { input: 'virtual:noitamap-locales', preserveEntrySignatures: 'strict' },
    },
  });
  return result.output as Array<{ type: string; fileName: string; code?: string; source?: string }>;
}

describe('locale assets', () => {
  it('ships every dictionary unchanged in compact assets and only URLs in the entry', async () => {
    const output = await buildLocales(root);
    const languages = (await readdir(resolve(root, 'src/locales'), { withFileTypes: true }))
      .filter(entry => entry.isDirectory()).map(entry => entry.name);
    const code = output.filter(file => file.type === 'chunk').map(file => file.code).join('\n');
    for (const language of languages) {
      const source = JSON.parse(await readFile(resolve(root, `src/locales/${language}/translation.json`), 'utf8'));
      const asset = output.find(file => file.fileName.startsWith(`build/locale-${language}-`));
      expect(asset, language).toBeDefined();
      expect(JSON.parse(String(asset!.source))).toEqual(source);
      expect(String(asset!.source)).toBe(JSON.stringify(source));
      expect(code).toContain(asset!.fileName.slice('build/'.length));
    }
    expect(Buffer.byteLength(code)).toBeLessThan(5000);
  });

  it('changes only the edited dictionary URL between builds', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'noitamap-locales-'));
    temporary.push(directory);
    for (const language of ['en', 'ru']) {
      await mkdir(resolve(directory, `src/locales/${language}`), { recursive: true });
      await writeFile(resolve(directory, `src/locales/${language}/translation.json`), JSON.stringify({ greeting: language }));
    }
    const first = await buildLocales(directory);
    await writeFile(resolve(directory, 'src/locales/ru/translation.json'), JSON.stringify({ greeting: 'Привет' }));
    const second = await buildLocales(directory);
    const asset = (output: typeof first, lang: string) => output.find(file => file.fileName.includes(`locale-${lang}-`))!.fileName;
    expect(asset(first, 'en')).toBe(asset(second, 'en'));
    expect(asset(first, 'ru')).not.toBe(asset(second, 'ru'));
  });
});

describe('telescope translation payload', () => {
  it.each(['noita-telescope', 'noita-telescope-vm'])('preserves the actual %s runtime parser output', async fork => {
    const source = await readFile(resolve(root, `lib/${fork}/js/translations.js`), 'utf8');
    const csv = await readFile(resolve(root, `lib/${fork}/data/translations.csv`), 'utf8');
    const compact = compactTelescopeTranslations(csv);
    // Execute upstream's complete loader, including normalization and extras.
    // No separately maintained parser can make this equivalence check pass.
    // The URL expression needs a module URL but has no bearing on CSV parsing.
    const moduleSource = source.replace(/\bexport\s+/g, '').replace(/import\.meta\.url/g, JSON.stringify(`file://${resolve(root, `lib/${fork}/js/translations.js`)}`));
    const run = new Function('fetch', `${moduleSource}\nreturn loadTranslations().then(() => TRANSLATIONS);`);
    expect(await run(async () => ({ text: async () => compact }))).toEqual(await run(async () => ({ text: async () => csv })));
    expect(Buffer.byteLength(compact)).toBeLessThan(Buffer.byteLength(csv) * 0.25);
    const result: any = await build({
      configFile: false, root, logLevel: 'silent',
      plugins: [telescopeBrowserPlugin([resolve(root, `lib/${fork}/js`)])],
      build: { write: false, rollupOptions: { input: resolve(root, `lib/${fork}/js/translations.js`) } },
    });
    const assets = result.output.filter((file: any) => file.type === 'asset');
    expect(assets).toHaveLength(1);
    expect(assets[0].fileName).toMatch(/translations-en-.*\.csv$/);
    expect(assets[0].source).toBe(compact);
  });
});
