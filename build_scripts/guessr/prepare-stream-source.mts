import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash, createCipheriv, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { PreparedGameCatalog } from '../../src/guessr/prepared-rounds';
import { preparedSourceAad, PREPARED_SOURCE_FILE_LIMIT, type PreparedSourcePackage } from '../../src/guessr/prepared-source-package';

/** Preserve the full weighted mask while bounding each runtime sampler read. */
export function shardPreparedSampler(input: Uint8Array, positions: number, chunkSize = 8192): Uint8Array[] {
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  if (input.byteLength < 8 || String.fromCharCode(...input.subarray(0, 4)) !== 'NGS1') throw Error('Invalid sampler.');
  const count = view.getUint32(4, true);
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1 || chunkSize > 8192 || !count || input.byteLength !== 8 + count * 20
    || view.getUint32(input.byteLength - 4, true) !== positions) throw Error('Invalid sampler size or weight.');
  let previous = 0;
  for (let i = 0; i < count; i++) {
    const at = 8 + i * 20, next = view.getUint32(at + 16, true);
    if (next <= previous || next - previous !== view.getUint32(at + 8, true) * view.getUint32(at + 12, true)) throw Error('Invalid sampler rectangle weight.');
    previous = next;
  }
  const chunks: Uint8Array[] = [];
  for (let first = 0; first < count; first += chunkSize) {
    const length = Math.min(chunkSize, count - first), bytes = new Uint8Array(8 + length * 20), out = new DataView(bytes.buffer);
    bytes.set(input.subarray(0, 4)); out.setUint32(4, length, true);
    bytes.set(input.subarray(8 + first * 20, 8 + (first + length) * 20), 8);
    const base = first ? view.getUint32(8 + first * 20 - 4, true) : 0;
    for (let i = 0; i < length; i++) out.setUint32(8 + i * 20 + 16, out.getUint32(8 + i * 20 + 16, true) - base, true);
    chunks.push(bytes);
  }
  return chunks;
}

export async function prepareStreamSource(workerDirectory: string, clueDirectory: string): Promise<PreparedSourcePackage> {
  const directory = join(workerDirectory, 'game-data');
  const catalog = JSON.parse(await readFile(join(directory, 'catalog.json'), 'utf8')) as PreparedGameCatalog;
  const assets = new Map<string, Uint8Array>(), areas: PreparedGameCatalog['areas'] = [];
  for (const area of catalog.areas) {
    if (!/^[a-f0-9]{32}\.bin$/.test(area.starts)) throw Error('Invalid sampler filename.');
    for (const bytes of shardPreparedSampler(await readFile(join(directory, 'starts', area.starts)), area.positions)) {
      const name = createHash('sha256').update(bytes).digest('hex').slice(0, 32) + '.bin';
      const positions = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(bytes.byteLength - 4, true);
      assets.set('/game-data/starts/' + name, bytes); areas.push({ ...area, starts: name, positions });
    }
  }
  assets.set('/game-data/catalog.json', new TextEncoder().encode(JSON.stringify({ ...catalog, areas })));
  assets.set('/game-data/native-grid.bin', await readFile(join(directory, 'native-grid.bin')));
  if (assets.size > 256) throw Error('Prepared map has too many files.');
  const key = randomBytes(32), files: PreparedSourcePackage['files'] = {}, output = join(clueDirectory, 'prepared');
  await mkdir(output, { recursive: true });
  for (const [path, bytes] of assets) {
    if (bytes.byteLength > PREPARED_SOURCE_FILE_LIMIT) throw Error('Prepared map file exceeds its size bound.');
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(preparedSourceAad(catalog.version, path));
    const payload = Buffer.concat([Buffer.from('NGD1'), iv, cipher.update(bytes), cipher.final(), cipher.getAuthTag()]);
    const file = createHash('sha256').update(payload).digest('hex') + '.bin';
    await writeFile(join(output, file), payload); files[path] = { file, bytes: bytes.byteLength };
  }
  return { schemaVersion: 1, version: catalog.version, root: 'https://images.invalid/prepared', key: key.toString('hex'), files };
}
