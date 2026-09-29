import JSZip from 'jszip';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createSceneSourceAtlas } from './scene-source-atlas.mjs';

const inputs = { main: 'data.zip', pixel_scenes: 'pixel_scenes.zip', wang_tiles: 'wang_tiles.zip' };
const pageBytes = 2 * 1024 * 1024;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const builds = new Map();
const recipeFiles = ['build_scripts/runtime-assets.mjs', 'build_scripts/scene-source-atlas.mjs', 'package-lock.json'];
const assetFile = /^game-assets\/(?:assets|scene-atlas)-([a-f0-9]{64})\.(?:bin|json|png)$/;

async function readPreparedAssets(directory, identity) {
  try {
    const cached = JSON.parse(await readFile(resolve(directory, 'manifest.json'), 'utf8'));
    if (cached.identity !== identity || !Array.isArray(cached.assets) || !cached.assets.length) return;
    const assets = new Map(await Promise.all(cached.assets.map(async ({ file, bytes }) => {
      const match = typeof file === 'string' && file.match(assetFile);
      if (!match) throw new Error('Invalid cached asset path');
      const data = await readFile(resolve(directory, file));
      if (data.length !== bytes || hash(data) !== match[1]) throw new Error('Damaged cached asset');
      return [file, data];
    })));
    for (const descriptor of [cached.sceneAtlas, ...Object.keys(inputs).map(key => cached.manifests?.[key])]) {
      const data = assets.get(descriptor?.file);
      if (!data || data.length !== descriptor.bytes || descriptor.revision !== descriptor.file.match(assetFile)[1])
        throw new Error('Invalid cached asset manifest');
    }
    return { assets, manifests: cached.manifests, sceneAtlas: cached.sceneAtlas };
  } catch {
    // Missing, partial or damaged build output is regenerated from the sources.
  }
}

async function writePreparedAssets(directory, identity, built) {
  await mkdir(resolve(directory, 'game-assets'), { recursive: true });
  const staging = await mkdtemp(resolve(directory, '.pending-'));
  try {
    await mkdir(resolve(staging, 'game-assets'));
    const writes = await Promise.allSettled([...built.assets].map(async ([file, bytes]) => {
      await writeFile(resolve(staging, file), bytes);
      // Files have content-based names. Concurrent public/Pro builds can safely
      // publish the same bytes; readers never see a partially written file.
      await rename(resolve(staging, file), resolve(directory, file));
    }));
    const failure = writes.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
    await writeFile(resolve(staging, 'manifest.json'), JSON.stringify({
      identity,
      assets: [...built.assets].map(([file, bytes]) => ({ file, bytes: bytes.length })),
      manifests: built.manifests,
      sceneAtlas: built.sceneAtlas,
    }));
    await rename(resolve(staging, 'manifest.json'), resolve(directory, 'manifest.json'));
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** ZIP extraction is build-only. Runtime pages concatenate original file bytes
 * without another compression layer; offsets are exact, including PNG alpha. */
export async function buildRuntimeAssets(root) {
  root = resolve(root);
  const paths = [...Object.values(inputs).map(file => `public/${file}`), ...recipeFiles];
  const stamps = await Promise.all(paths.map(async file => {
    const info = await stat(resolve(root, file), { bigint: true });
    return `${info.size}:${info.mtimeNs}:${info.ctimeNs}:${info.ino}`;
  }));
  const stamp = stamps.join('/'), previous = builds.get(root);
  // Dev atlas requests and worker bundles share this promise without rereading
  // the archives. Every new process still fingerprints actual source bytes.
  if (previous?.stamp === stamp) return previous.pending;
  const pending = prepareRuntimeAssets(root);
  builds.set(root, { stamp, pending });
  try { return await pending; } catch (error) {
    if (builds.get(root)?.pending === pending) builds.delete(root);
    throw error;
  }
}

async function prepareRuntimeAssets(root) {
  const archives = await Promise.all(Object.entries(inputs).map(async ([key, file]) => {
    const bytes = await readFile(resolve(root, 'public', file));
    return { key, bytes, revision: hash(bytes) };
  }));
  const recipe = await Promise.all(recipeFiles.map(async file => hash(await readFile(resolve(root, file)))));
  const identity = hash(JSON.stringify([...archives.map(a => a.revision), ...recipe]));
  const directory = resolve(root, 'build_data/runtime-assets');
  const cached = await readPreparedAssets(directory, identity);
  if (cached) {
    console.log('[runtime assets] Sources unchanged; reusing prepared atlases and asset data.');
    return cached;
  }
  const started = performance.now();
  console.log('[runtime assets] Preparing atlases and asset data; subsequent builds will reuse them.');
  const built = await (async () => {
    const assets = new Map(), manifests = {};
    const add = (bytes, extension, prefix = 'assets') => {
      const revision = hash(bytes), file = `game-assets/${prefix}-${revision}.${extension}`;
      assets.set(file, bytes);
      return { file, revision, bytes: bytes.length };
    };
    const atlas = createSceneSourceAtlas(add);
    for (const archive of archives) {
      const zip = await JSZip.loadAsync(archive.bytes);
      const entries = {}, pages = [];
      let chunks = [], length = 0, paths = [];
      const flush = () => {
        if (!paths.length) return;
        const page = add(Buffer.concat(chunks, length), 'bin');
        const index = pages.length; pages.push(page);
        for (const [path, offset, size] of paths) entries[path] = [index, offset, size];
        chunks = []; paths = []; length = 0;
      };
      // Adjacent paths share pages so repeated scene/background reads reuse I/O.
      for (const path of Object.keys(zip.files).sort()) {
        const entry = zip.files[path];
        if (entry.dir) continue;
        const bytes = await entry.async('nodebuffer');
        atlas.add(archive.key, path, bytes, hash(bytes));
        if (length && length + bytes.length > pageBytes) flush();
        paths.push([path, length, bytes.length]); chunks.push(bytes); length += bytes.length;
        if (length >= pageBytes) flush();
      }
      flush();
      manifests[archive.key] = add(Buffer.from(JSON.stringify({ version: 1, pages, entries })), 'json');
    }
    return { assets, manifests, sceneAtlas: atlas.finish() };
  })();
  try { await writePreparedAssets(directory, identity, built); } catch (error) {
    console.warn('[runtime assets] Could not save prepared assets for the next build:', error.message);
  }
  console.log(`[runtime assets] Prepared in ${((performance.now() - started) / 1000).toFixed(2)}s.`);
  return built;
}

export function dataArchivesPlugin(root) {
  const name = 'virtual:noitamap-data-archives', id = '\0' + name;
  let config;
  return {
    name: 'noitamap-runtime-assets',
    configResolved(value) { config = value; },
    resolveId(source) { if (source === name) return id; },
    async load(source) {
      if (source !== id) return;
      for (const file of Object.values(inputs)) this.addWatchFile(resolve(root, 'public', file));
      const { assets, manifests, sceneAtlas } = await buildRuntimeAssets(root);
      if (config.command === 'build') for (const [fileName, bytes] of assets)
        this.emitFile({ type: 'asset', fileName, source: bytes });
      const backgroundDir = resolve(root, 'public/biome_bg');
      const backgrounds = {};
      for (const entry of await readdir(backgroundDir)) if (entry.endsWith('.png')) {
        const path = resolve(backgroundDir, entry); this.addWatchFile(path);
        backgrounds[entry] = hash(await readFile(path));
      }
      return `export const assetManifests = ${JSON.stringify(manifests)};\nexport const sceneAtlas = ${JSON.stringify(sceneAtlas)};\nexport const biomeBackgroundRevisions = ${JSON.stringify(backgrounds)};`;
    },
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const pathname = new URL(req.url, 'http://localhost').pathname;
        const start = pathname.indexOf('/game-assets/');
        if (start < 0) return next();
        try {
          const { assets } = await buildRuntimeAssets(root);
          const file = pathname.slice(start + 1), bytes = assets.get(file);
          if (!bytes) { res.statusCode = 404; res.end(); return; }
          res.setHeader('Content-Type', file.endsWith('.json') ? 'application/json' : file.endsWith('.png') ? 'image/png' : 'application/octet-stream');
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          res.setHeader('Content-Length', bytes.length);
          res.end(req.method === 'HEAD' ? undefined : bytes);
        } catch (error) { next(error); }
      });
    },
    // Vite's public copy includes build inputs unless explicitly removed.
    async closeBundle() {
      if (config.command !== 'build' || !config.build.copyPublicDir) return;
      for (const file of Object.values(inputs))
        await rm(resolve(config.root, config.build.outDir, file), { force: true });
    },
    handleHotUpdate({ file, server }) {
      if (!Object.values(inputs).some(input => resolve(root, 'public', input) === file)) return;
      const module = server.moduleGraph.getModuleById(id);
      if (module) server.moduleGraph.invalidateModule(module);
      server.ws.send({ type: 'full-reload', path: '*' });
      return [];
    },
  };
}
