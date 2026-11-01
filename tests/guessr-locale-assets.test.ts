import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { readdirSync } from 'node:fs';
import { build, type Rollup } from 'vite';
import { localeAssetsPlugin } from '../build_scripts/vite-locales';

const root = resolve(import.meta.dirname, '..');
describe('Guessr translation bundle', () => {
  it('keeps other languages lazy and excludes the map entrypoint from the picker', async () => {
    const result = await build({
      configFile: false, root, logLevel: 'silent',
      plugins: [localeAssetsPlugin(root)],
      build: { write: false, rollupOptions: { input: resolve(root, 'src/guessr/language-picker.ts'), preserveEntrySignatures: 'strict' } },
    }) as Rollup.RollupOutput;
    const chunks = result.output.filter((file): file is Rollup.OutputChunk => file.type === 'chunk');
    const modules = chunks.flatMap(chunk => Object.keys(chunk.modules));
    expect(modules).not.toContain(resolve(root, 'src/main.ts'));
    expect(modules).not.toContain(resolve(root, 'src/i18n-dom.ts'));
    expect(modules).not.toContain(resolve(root, 'src/app_osd.ts'));
    const entry = chunks.find(chunk => chunk.isEntry)!;
    const eagerChunks = new Set<string>();
    const visit = (chunk: Rollup.OutputChunk) => {
      if (eagerChunks.has(chunk.fileName)) return;
      eagerChunks.add(chunk.fileName);
      for (const name of chunk.imports) {
        const dependency = chunks.find(candidate => candidate.fileName === name);
        if (dependency) visit(dependency);
      }
    };
    visit(entry);
    const eagerModules = chunks.filter(chunk => eagerChunks.has(chunk.fileName)).flatMap(chunk => Object.keys(chunk.modules));
    expect(eagerModules).toContain(resolve(root, 'src/guessr/locales/en.json'));
    for (const file of readdirSync(resolve(root, 'src/guessr/locales')).filter(file => file.endsWith('.json') && file !== 'en.json')) {
      const module = resolve(root, 'src/guessr/locales', file);
      expect(modules, `${file} is available to load`).toContain(module);
      expect(eagerModules, `${file} stays lazy`).not.toContain(module);
    }
  });
});
