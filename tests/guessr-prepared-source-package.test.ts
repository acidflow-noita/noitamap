import { expect, it } from 'vitest';
import { createCipheriv } from 'node:crypto';
import { shardPreparedSampler } from '../build_scripts/guessr/prepare-stream-source.mts';
import { encryptedPreparedReader, preparedSourceAad, validatePreparedSourcePackage, type PreparedSourcePackage } from '../src/guessr/prepared-source-package';

it('splits every rectangle without changing geometry or total position weights', () => {
  const bytes = new Uint8Array(8 + 3 * 20), view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode('NGS1')); view.setUint32(4, 3, true);
  let sum = 0;
  for (let i = 0; i < 3; i++) {
    const at = 8 + i * 20; view.setInt32(at, -100 + i * 10, true); view.setInt32(at + 4, i, true);
    view.setUint32(at + 8, i + 1, true); view.setUint32(at + 12, 2, true); sum += (i + 1) * 2; view.setUint32(at + 16, sum, true);
  }
  const shards = shardPreparedSampler(bytes, sum, 1);
  expect(shards).toHaveLength(3);
  expect(shards.map(b => new DataView(b.buffer).getUint32(b.length - 4, true))).toEqual([2, 4, 6]);
  for (let i = 0; i < shards.length; i++) expect(shards[i].subarray(8, 24)).toEqual(bytes.subarray(8 + i * 20, 24 + i * 20));
  view.setUint32(24, 99, true); expect(() => shardPreparedSampler(bytes, sum, 1)).toThrow('weight');
});

it('decrypts only the bound dataset and path and rejects swapped or oversized files', async () => {
  const key = Buffer.alloc(32, 7), iv = Buffer.alloc(12, 9), version = 'guessr-images-' + 'a'.repeat(32);
  const path = '/game-data/catalog.json', plain = Buffer.from('{"private":"sample metadata"}');
  const cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(preparedSourceAad(version, path));
  const encrypted = Buffer.concat([Buffer.from('NGD1'), iv, cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  const source: PreparedSourcePackage = { schemaVersion: 1, version, root: 'https://12345678.clues.pages.dev/prepared', key: key.toString('hex'), files: {
    [path]: { file: 'b'.repeat(64) + '.bin', bytes: plain.length },
    '/game-data/native-grid.bin': { file: 'c'.repeat(64) + '.bin', bytes: plain.length },
    ['/game-data/starts/' + 'd'.repeat(32) + '.bin']: { file: 'd'.repeat(64) + '.bin', bytes: 28 },
  } };
  expect(validatePreparedSourcePackage(source, version, 'https://12345678.clues.pages.dev')).toBe(source);
  const read = encryptedPreparedReader(source, async (_url, options) => {
    expect(options?.redirect).toBe('manual'); return new Response(new Uint8Array(encrypted));
  });
  expect(await (await read(path)).text()).toBe(plain.toString());
  await expect(read('/game-data/native-grid.bin')).rejects.toThrow();
  await expect(read('/game-data/../secret')).rejects.toThrow('missing');
  const bad = encryptedPreparedReader(source, async () => new Response(new Uint8Array(encrypted.length + 1)));
  await expect(bad(path)).rejects.toThrow('size bound');
  expect(() => validatePreparedSourcePackage({ ...source, root: 'https://evil.test/prepared' }, version, 'https://12345678.clues.pages.dev')).toThrow();
});

it.each([301, 302, 303, 307, 308])('rejects a %s redirect without following it', async status => {
  const path = '/game-data/catalog.json';
  const source: PreparedSourcePackage = { schemaVersion: 1, version: 'guessr-images-' + 'a'.repeat(32),
    root: 'https://12345678.clues.pages.dev/prepared', key: '07'.repeat(32),
    files: { [path]: { file: 'b'.repeat(64) + '.bin', bytes: 8 } } };
  let calls = 0;
  const read = encryptedPreparedReader(source, async (_url, init) => {
    calls++; expect(init?.redirect).toBe('manual');
    return new Response(null, { status, headers: { Location: 'https://other.test/private' } });
  });
  await expect(read(path)).rejects.toMatchObject({ code: 'http', status });
  expect(calls).toBe(1);
});
