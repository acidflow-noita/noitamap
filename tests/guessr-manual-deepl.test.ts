import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createTranslationPlan, importTranslationFiles, officialGlossary, parseCsv,
  renderSourceBatch, stableTranslationId, validateResponses, validateTranslationPlan,
} from '../build_scripts/guessr/manual-deepl.mjs';

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

function fixture(maxBatchCharacters = 2500) {
  const source = {
    Back: 'Back', Close: 'Close', Saved: 'Saved',
    'Round {{round}}': 'Round {{round}}',
    'Compare {{x}} / {{x}} / {{y}}': 'Compare {{x}} / {{x}} / {{y}}',
    ' · Streamer': ' · Streamer',
    'Long status': 'Wait while the game prepares the next location and updates the clue shown to everybody in the current round.',
  };
  const reused = { Back: { value: 'Reviewed map back', mapKey: 'navigation.back' } };
  const previous = { Back: 'Older target back', Saved: 'Existing target saved' };
  const existing = { Back: reused.Back.value, Saved: previous.Saved };
  const plan = createTranslationPlan({ source, existing: previous, reused, language: 'ja', seed: true, maxBatchCharacters });
  const responses = Object.fromEntries(plan.batches.map(batch => [batch.file,
    batch.ids.reduce((text: string, id: string) => {
      const entry = plan.entries.find(entry => entry.id === id)!;
      return text.replace(`\n${entry.source}\n`, `\nTranslated: ${entry.source.trim()}\n`);
    }, renderSourceBatch(plan, batch)),
  ]));
  return { source, reused, existing, plan, responses };
}

describe('manual translation pack', () => {
  it('uses stable IDs and only exports text that cannot be reused or preserved', () => {
    const { source, existing, reused, plan } = fixture();
    validateTranslationPlan(plan, { source, existing, reused });
    expect(plan.entries.find(entry => entry.key === 'Back')).toMatchObject({ status: 'reused', value: 'Reviewed map back' });
    expect(plan.entries.find(entry => entry.key === 'Saved')).toMatchObject({ status: 'existing', value: 'Existing target saved' });
    expect(plan.batches.flatMap(batch => batch.ids)).not.toContain(stableTranslationId('Back'));
    expect(plan.batches.flatMap(batch => batch.ids)).not.toContain(stableTranslationId('Saved'));
    const extra = createTranslationPlan({ source: { Added: 'Added', ...source }, existing, reused, language: 'ja' });
    expect(extra.entries.find(entry => entry.key === 'Close')?.id).toBe(stableTranslationId('Close'));
    expect(extra.sourceFingerprint).not.toBe(plan.sourceFingerprint);
  });

  it('keeps source batches within the requested character limit', () => {
    const { plan } = fixture(500);
    expect(plan.batches.length).toBeGreaterThan(1);
    for (const batch of plan.batches) expect([...renderSourceBatch(plan, batch)].length).toBeLessThanOrEqual(500);
  });

  it('rejects changed source, target, reuse values, manifest schema and manifest contents', () => {
    const { source, existing, reused, plan } = fixture();
    expect(() => validateTranslationPlan(plan, { source: { ...source, Close: 'Close dialog' }, existing, reused })).toThrow('Stale English');
    expect(() => validateTranslationPlan(plan, { source, existing: { ...existing, Saved: 'New review' }, reused })).toThrow('Target catalog changed');
    expect(() => validateTranslationPlan(plan, { source, existing, reused: { Back: { ...reused.Back, value: 'New map correction' } } })).toThrow('reuse values');
    expect(() => validateTranslationPlan({ ...plan, schema: 'v0' }, { source, existing, reused })).toThrow('schema');
    expect(() => validateTranslationPlan({ ...plan, entries: [...plan.entries, plan.entries[0]] }, { source, existing, reused })).toThrow('Manifest fingerprint');
  });

  it('accepts reordered entries with exact placeholders and restores intentional layout spacing', () => {
    const { plan, responses } = fixture();
    const catalog = validateResponses(plan, responses);
    expect(catalog.Back).toBe('Reviewed map back');
    expect(catalog.Saved).toBe('Existing target saved');
    expect(catalog.Close).toBe('Translated: Close');
    expect(catalog[' · Streamer']).toBe(' Translated: · Streamer');
    const file = plan.batches[0].file;
    const entryBlocks = responses[file].match(/\[\[G[0-9a-f]{16}\]\][\s\S]*?\[\[\/G[0-9a-f]{16}\]\]/g)!;
    const reversed = responses[file].replace(entryBlocks.join('\n\n'), [...entryBlocks].reverse().join('\n\n'));
    expect(validateResponses(plan, { [file]: '\uFEFF' + reversed.replaceAll('\n', '\r\n') })).toEqual(catalog);
    expect(validateResponses(plan, { [file]: responses[file].replace('Compare {{x}} / {{x}} / {{y}}', 'Compare {{y}} / {{x}} / {{x}}') })).toEqual({
      ...catalog, 'Compare {{x}} / {{x}} / {{y}}': 'Translated: Compare {{y}} / {{x}} / {{x}}',
    });
  });

  it.each([
    ['missing file', (_text: string) => undefined, /Missing or unexpected response files/],
    ['missing ID', (text: string) => text.replace(/\[\[G[0-9a-f]{16}\]\][\s\S]*?\[\[\/G[0-9a-f]{16}\]\]/, ''), /Missing IDs/],
    ['repeated ID', (text: string) => text.replace(/(\[\[G[0-9a-f]{16}\]\][\s\S]*?\[\[\/G[0-9a-f]{16}\]\])/, '$1\n\n$1'), /Repeated ID/],
    ['unknown ID', (text: string) => text.replace(/G[0-9a-f]{16}/, 'G0000000000000000'), /Unknown ID/],
    ['empty text', (text: string) => text.replace('Translated: Close', ''), /Incomplete translation/],
    ['unfinished template', (text: string) => text.replace('Translated: Close', 'PASTE_TRANSLATION_HERE'), /Incomplete translation/],
    ['missing closing marker', (text: string) => text.replace(/\[\[\/G[0-9a-f]{16}\]\]/, ''), /Incomplete ID/],
    ['wrong closing marker', (text: string) => text.replace(/\[\[\/G[0-9a-f]{16}\]\]/, '[[/G0000000000000000]]'), /Mismatched closing/],
    ['damaged marker', (text: string) => text.replace(/\[\[G([0-9a-f]{16})\]\]/, '[[ID $1]]'), /Malformed ID/],
    ['stale fingerprint', (text: string) => text.replace('GUESSR_V1_ja_', 'GUESSR_V1_zh_'), /fingerprint\/header\/footer/],
    ['truncated batch', (text: string) => text.slice(0, -100), /fingerprint\/header\/footer/],
    ['unexpected prose', (text: string) => text.replace('\n\n[[G', '\nUnrelated prose\n\n[[G'), /Unexpected text/],
    ['missing placeholder', (text: string) => text.replace('{{round}}', 'round'), /Placeholder multiset/],
    ['changed placeholder', (text: string) => text.replace('{{round}}', '{{rounds}}'), /Placeholder multiset/],
    ['placeholder spacing', (text: string) => text.replace('{{round}}', '{{ round }}'), /Placeholder multiset/],
    ['extra placeholder', (text: string) => text.replace('{{round}}', '{{round}} {{round}}'), /Placeholder multiset/],
    ['lost repeated placeholder', (text: string) => text.replace('{{x}} / {{x}} / {{y}}', '{{x}} / {{y}}'), /Placeholder multiset/],
  ])('rejects %s', (_name, change, error) => {
    const { plan, responses } = fixture();
    const file = plan.batches[0].file;
    const changed = change(responses[file]);
    expect(() => validateResponses(plan, changed === undefined ? {} : { [file]: changed })).toThrow(error);
  });

  it('requires explicit review of intentionally unchanged English', () => {
    const { plan, responses } = fixture();
    const file = plan.batches[0].file;
    const unchanged = { [file]: responses[file].replace('Translated: Close', 'Close') };
    expect(() => validateResponses(plan, unchanged)).toThrow('Unchanged English');
    expect(validateResponses(plan, unchanged, [stableTranslationId('Close')]).Close).toBe('Close');
    expect(() => validateResponses(plan, unchanged, ['G0000000000000000'])).toThrow('Unknown');
    expect(() => validateResponses(plan, unchanged, [stableTranslationId('Close'), stableTranslationId('Close')])).toThrow('unique');
    expect(() => validateResponses(plan, responses, [stableTranslationId('Close')])).toThrow('no longer unchanged');
  });

  it('rejects English source batches and unexpected response files', () => {
    const { plan, responses } = fixture();
    const sourceResponses = Object.fromEntries(plan.batches.map(batch => [batch.file, renderSourceBatch(plan, batch)]));
    expect(() => validateResponses(plan, sourceResponses)).toThrow('Unchanged English');
    expect(() => validateResponses(plan, { ...responses, 'unknown.txt': 'text' })).toThrow('unexpected response files');
  });

  it('accepts a single combined response and rejects missing, repeated, stale or mixed batches', () => {
    const { plan, responses } = fixture(500);
    const combined = Object.values(responses).join('\n');
    expect(validateResponses(plan, { 'all.txt': combined })).toEqual(validateResponses(plan, responses));
    expect(() => validateResponses(plan, { 'all.txt': Object.values(responses)[0] })).toThrow('Missing or unexpected');
    expect(() => validateResponses(plan, { 'all.txt': combined + '\n' + Object.values(responses)[0] })).toThrow('Repeated batch');
    expect(() => validateResponses(plan, { 'all.txt': combined.replace('GUESSR_V1_ja_', 'GUESSR_V1_zh_') })).toThrow('fingerprint');
    expect(() => validateResponses(plan, { 'all.txt': combined, ...responses })).toThrow('not both');
    expect(() => validateResponses(plan, { 'all.txt': combined.slice(0, -100) })).toThrow('Incomplete combined batch');
  });

  it('copies quoted official CSV terminology without generating or normalizing terms', () => {
    const csv = ',en,jp,zh-cn\r\nbiome_coalmine,mines,鉱山,矿场\r\nitem_example,"Example, \\"quoted\\"",公式,官方\r\nitem_missing,Missing,,\r\nitem_desc,Description,説明,描述\r\nanimal_test,Animal,動物,动物\r\n'.replaceAll('\\"', '""');
    expect(officialGlossary(csv, 'ja')).toEqual([
      { key: 'biome_coalmine', english: 'mines', translation: '鉱山' },
      { key: 'item_example', english: 'Example, "quoted"', translation: '公式' },
    ]);
    expect(officialGlossary(csv, 'zh')[0].translation).toBe('矿场');
    expect(parseCsv('a,"b\nc",d\n')).toEqual([['a', 'b\nc', 'd']]);
    expect(() => parseCsv('a,"broken')).toThrow('Unterminated');
  });
});

describe('manual translation import writes', () => {
  it('leaves the target byte-for-byte untouched unless every response passes, then writes the complete catalog', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'guessr-manual-import-'));
    cleanup.push(directory);
    const { source, existing, reused, plan, responses } = fixture(500);
    const sourcePath = join(directory, 'en.json');
    const catalogPath = join(directory, 'ja.json');
    const manifestPath = join(directory, 'manifest.json');
    const responseDirectory = join(directory, 'responses');
    await mkdir(responseDirectory);
    const original = JSON.stringify(existing, null, 4) + '\n';
    await writeFile(sourcePath, JSON.stringify(source));
    await writeFile(catalogPath, original);
    await writeFile(manifestPath, JSON.stringify(plan));
    for (const [file, text] of Object.entries(responses)) await writeFile(join(responseDirectory, file), text);
    const last = plan.batches.at(-1)!;
    const lastFile = join(responseDirectory, last.file);
    await writeFile(lastFile, responses[last.file].replace(/\[\[\/G[0-9a-f]{16}\]\]/, ''));
    const options = { manifestPath, responseDirectory, sourcePath, catalogPath, reused };
    await expect(importTranslationFiles(options)).rejects.toThrow();
    expect(await readFile(catalogPath, 'utf8')).toBe(original);
    expect((await readdir(directory)).filter(name => name.endsWith('.tmp'))).toEqual([]);
    await writeFile(lastFile, responses[last.file]);
    await expect(importTranslationFiles(options)).resolves.toMatchObject({ language: 'ja', entries: Object.keys(source).length, imported: 5 });
    expect(JSON.parse(await readFile(catalogPath, 'utf8'))).toEqual(validateResponses(plan, responses));
    expect(JSON.parse(await readFile(catalogPath, 'utf8')).Back).toBe(reused.Back.value);
    await expect(importTranslationFiles(options)).rejects.toThrow('Target catalog changed');
  });
});
