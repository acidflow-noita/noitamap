import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import JSZip from 'jszip';
import { build } from 'vite';
import { afterEach, expect, it, vi } from 'vitest';
import { archiveFiles, buildRuntimeAssets, type RuntimeAssetIndex } from '../build_scripts/runtime-assets';
import { dataArchivesPlugin } from '../build_scripts/vite-data-archives';

const roots: string[] = [];
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
type Entries = Record<string, Uint8Array | string>;
async function archive(root: string, key: keyof typeof archiveFiles, entries: Entries, date = 0) {
  const zip = new JSZip();
  for (const [name, bytes] of Object.entries(entries)) zip.file(name, bytes, { date: new Date(2000 + date, 0, 1) });
  const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  await writeFile(resolve(root, 'public', archiveFiles[key]), bytes);
  return bytes;
}
async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), 'noitamap-runtime-assets-')); roots.push(root);
  await mkdir(resolve(root, 'public/biome_bg'), { recursive: true });
  for (const key of Object.keys(archiveFiles) as (keyof typeof archiveFiles)[])
    await archive(root, key, { [`${key}.txt`]: key });
  return root;
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it('preserves each original byte and path across page boundaries, including PNGs and empty files', async () => {
  const root = await fixture();
  const entries: Entries = {
    'data/empty.txt': '',
    'data/日本語.txt': 'actual\ntext with \\n preserved',
    'data/small.bin': new Uint8Array([0, 1, 2, 255, 0]),
    'data/large.bin': new Uint8Array(2 * 1024 * 1024 + 17).fill(71),
    'data/image.png': Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==', 'base64'),
  };
  const bytes = await archive(root, 'main', entries);
  const built = await buildRuntimeAssets(root);
  const manifest = built.manifests.main;
  const index: RuntimeAssetIndex = JSON.parse(built.assets.get(manifest.file)!.toString());
  expect(built.archiveRevisions.main).toBe(digest(bytes));
  expect(index.version).toBe(1);
  expect(Object.keys(index.entries)).toEqual(Object.keys(entries).sort());
  expect(index.pages).toHaveLength(3);
  for (const [name, expected] of Object.entries(entries)) {
    const [page, offset, length] = index.entries[name];
    const descriptor = index.pages[page], original = Buffer.from(expected);
    const data = built.assets.get(descriptor.file)!;
    expect(descriptor).toEqual({ file: `game-assets/assets-${digest(data)}.bin`, revision: digest(data), bytes: data.length });
    expect(offset).toBeGreaterThanOrEqual(0);
    expect(offset + length).toBeLessThanOrEqual(data.length);
    expect(data.subarray(offset, offset + length).equals(original)).toBe(true);
    if (data.length > 2 * 1024 * 1024) expect(data.equals(Buffer.from(entries['data/large.bin']))).toBe(true);
  }
  for (const descriptor of Object.values(built.manifests)) {
    const contents = built.assets.get(descriptor.file)!;
    expect(descriptor.revision).toBe(digest(contents));
    expect(descriptor.bytes).toBe(contents.length);
  }
  expect(await readFile(resolve(root, 'public/data.zip'))).toEqual(bytes);
});

it('shares concurrent builds, ignores ZIP metadata for page identity and detects changed source bytes', async () => {
  const root = await fixture();
  const entries = { 'b.txt': 'second', 'a.txt': 'first' };
  await archive(root, 'main', entries);
  const [a, b] = await Promise.all([buildRuntimeAssets(root), buildRuntimeAssets(root)]);
  expect(a).toBe(b);
  await archive(root, 'main', { 'a.txt': 'first', 'b.txt': 'second' }, 1);
  const reordered = await buildRuntimeAssets(root);
  expect(reordered.archiveRevisions.main).not.toBe(a.archiveRevisions.main);
  expect(reordered.manifests).toEqual(a.manifests);
  expect(reordered.assets).toEqual(a.assets);
  await archive(root, 'main', { ...entries, 'a.txt': 'other' }, 1);
  const changed = await buildRuntimeAssets(root);
  expect(changed.manifests.main).not.toEqual(a.manifests.main);
  expect(changed.manifests.wang_tiles).toEqual(a.manifests.wang_tiles);
  expect(changed.manifests.pixel_scenes).toEqual(a.manifests.pixel_scenes);
});

it('keeps roots independent and retries a broken build instead of retaining a rejected preparation', async () => {
  const root = await fixture(), other = await fixture();
  await writeFile(resolve(root, 'public/data.zip'), 'not a zip');
  await expect(buildRuntimeAssets(root)).rejects.toThrow();
  const reference = await buildRuntimeAssets(other);
  await archive(root, 'main', { 'main.txt': 'fixed' });
  const recovered = await buildRuntimeAssets(root);
  expect(recovered.manifests.main).not.toEqual(reference.manifests.main);
  expect(await buildRuntimeAssets(other)).toBe(reference);
});

it('emits a valid empty catalog for an empty archive', async () => {
  const root = await fixture();
  await archive(root, 'main', {});
  const built = await buildRuntimeAssets(root);
  expect(JSON.parse(built.assets.get(built.manifests.main.file)!.toString()))
    .toEqual({ version: 1, entries: {}, pages: [] });
});

it('serves immutable dev assets under the configured base with exact bytes, HEAD and a real missing-file response', async () => {
  const root = await fixture(), plugin = dataArchivesPlugin(root);
  (plugin.configResolved as Function)({ command: 'serve', base: '/preview/' });
  let handle: Function | undefined;
  (plugin.configureServer as Function)({ middlewares: { use: (handler: Function) => { handle = handler; } } });
  const built = await buildRuntimeAssets(root), descriptor = built.manifests.main;
  const request = async (url: string, method = 'GET') => {
    const response = { statusCode: 200, setHeader: vi.fn(), end: vi.fn() }, next = vi.fn();
    await handle!({ url, method }, response, next);
    return { response, next };
  };
  for (const method of ['GET', 'HEAD']) {
    const { response, next } = await request('/preview/' + descriptor.file + '?test=1', method);
    expect(next).not.toHaveBeenCalled();
    expect(response.setHeader).toHaveBeenCalledWith('Content-Type', 'application/json');
    expect(response.setHeader).toHaveBeenCalledWith('Cache-Control', 'public, max-age=31536000, immutable');
    expect(response.setHeader).toHaveBeenCalledWith('Content-Length', descriptor.bytes);
    expect(response.end).toHaveBeenCalledWith(method === 'HEAD' ? undefined : built.assets.get(descriptor.file));
  }
  const { response } = await request('/preview/game-assets/missing.json');
  expect(response.statusCode).toBe(404);
  expect((await request('/preview/unrelated')).next).toHaveBeenCalledOnce();
});

it.each([false, true])('emits byte-identical pages for the app and worker when the map checkout is external: %s', async outsideRoot => {
  const root = await fixture();
  const app = outsideRoot ? resolve(root, 'contributor/pro') : root;
  await mkdir(app, { recursive: true });
  await writeFile(resolve(app, 'index.html'), '<script type="module" src="./entry.js"></script>');
  await writeFile(resolve(app, 'entry.js'), `import { assetManifests } from 'virtual:noitamap-asset-pages';
    console.log(assetManifests); new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });`);
  await writeFile(resolve(app, 'worker.js'), `import { assetManifests } from 'virtual:noitamap-asset-pages'; postMessage(assetManifests);`);
  const expected = await buildRuntimeAssets(root), outDir = resolve(app, 'output');
  await build({ configFile: false, root: app, base: '/preview/', logLevel: 'silent',
    plugins: [dataArchivesPlugin(root)], worker: { plugins: () => [dataArchivesPlugin(root)] },
    build: { outDir, minify: false } });
  for (const [file, bytes] of expected.assets) expect(await readFile(resolve(outDir, file))).toEqual(bytes);
  if (!outsideRoot) for (const file of Object.values(archiveFiles))
    expect(await readFile(resolve(outDir, file))).toEqual(await readFile(resolve(root, 'public', file)));
});
