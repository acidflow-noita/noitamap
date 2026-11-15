import { expect, it } from 'vitest';
import { encryptedPreparedReader, preparedSourceAad, type PreparedSourcePackage } from '../../../src/guessr/prepared-source-package';

it('loads a prepared catalog through the actual Worker stream and crypto runtime', async () => {
  const version = 'guessr-images-' + 'a'.repeat(32), path = '/game-data/catalog.json';
  const plain = new TextEncoder().encode(JSON.stringify({ padding: 'x'.repeat(161696) }));
  const rawKey = new Uint8Array(32).fill(7), iv = new Uint8Array(12).fill(9);
  const key = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['encrypt']);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv,
    additionalData: preparedSourceAad(version, path) }, key, plain));
  const encoded = new Uint8Array(16 + ciphertext.length);
  encoded.set(new TextEncoder().encode('NGD1')); encoded.set(iv, 4); encoded.set(ciphertext, 16);
  const data: PreparedSourcePackage = { schemaVersion: 1, version, root: 'https://12345678.clues.pages.dev/prepared',
    key: '07'.repeat(32), files: { [path]: { file: 'b'.repeat(64) + '.bin', bytes: plain.length } } };
  const read = encryptedPreparedReader(data, async (url, init) => {
    // Construct a real Worker Request so unsupported fetch options cannot hide
    // behind a mocked network response.
    const request = new Request(url, init);
    expect(request.url).toBe(data.root + '/' + data.files[path].file);
    expect(request.redirect).toBe('manual');
    return new Response(new ReadableStream({ start(controller) {
    controller.enqueue(encoded.subarray(0, 65536)); controller.enqueue(encoded.subarray(65536)); controller.close();
  } }), { headers: { 'Content-Length': String(encoded.length) } });
  });
  const response = await read(path);
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(plain);
});
