import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import JSZip from 'jszip';

export const archiveFiles = {
  main: 'data.zip', pixel_scenes: 'pixel_scenes.zip', wang_tiles: 'wang_tiles.zip',
};

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const pageBytes = 2 * 1024 * 1024;
const builds = new Map();

/** Build-only extraction. Pages contain the original file bytes, including PNGs;
 * no decoding, recolouring, atlas packing or extra compression takes place. */
export async function buildRuntimeAssets(root) {
  root = resolve(root);
  // Match the existing manifest's byte-based freshness, even on filesystems
  // that retain a timestamp across rapid same-size archive replacements.
  const sources = await Promise.all(Object.entries(archiveFiles).map(async ([key, file]) => {
    const bytes = await readFile(resolve(root, 'public', file));
    return { key, bytes, revision: hash(bytes) };
  }));
  const stamp = sources.map(source => source.revision).join('/');
  const previous = builds.get(root);
  if (previous?.stamp === stamp) return previous.pending;
  const pending = prepare(sources);
  // Main and worker Vite plugins share one build; a changed input replaces it.
  builds.set(root, { stamp, pending });
  try { return await pending; }
  catch (error) {
    if (builds.get(root)?.pending === pending) builds.delete(root);
    throw error;
  }
}

async function prepare(sources) {
  const assets = new Map();
  const manifests = {};
  const archiveRevisions = {};
  const add = (bytes, extension) => {
    const revision = hash(bytes), file = `game-assets/assets-${revision}.${extension}`;
    assets.set(file, bytes);
    return { file, revision, bytes: bytes.length };
  };
  for (const { key, bytes, revision } of sources) {
    archiveRevisions[key] = revision;
    const zip = await JSZip.loadAsync(bytes);
    const index = { version: 1, pages: [], entries: Object.create(null) };
    let chunks = [], length = 0;
    let entries = [];
    const flush = () => {
      if (!entries.length) return;
      const page = index.pages.length;
      index.pages.push(add(Buffer.concat(chunks, length), 'bin'));
      for (const [name, offset, size] of entries) index.entries[name] = [page, offset, size];
      chunks = []; entries = []; length = 0;
    };
    // Stable path ordering keeps page identities independent of ZIP metadata.
    for (const name of Object.keys(zip.files).sort()) {
      const entry = zip.files[name];
      if (entry.dir) continue;
      const content = await entry.async('nodebuffer');
      if (length && length + content.length > pageBytes) flush();
      entries.push([name, length, content.length]); chunks.push(content); length += content.length;
      // A file larger than the target gets its own page without splitting it.
      if (length >= pageBytes) flush();
    }
    flush();
    manifests[key] = add(Buffer.from(JSON.stringify(index)), 'json');
  }
  return { assets, manifests, archiveRevisions };
}
