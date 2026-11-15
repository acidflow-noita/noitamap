/** Private publisher metadata. The key and logical file map never enter game responses. */
export interface PreparedSourcePackage {
  schemaVersion: 1;
  version: string;
  root: string;
  key: string;
  files: Record<string, { file: string; bytes: number }>;
}
export const PREPARED_SOURCE_FILE_LIMIT = 1024 * 1024;
const logicalFile = /^\/game-data\/(?:catalog\.json|native-grid\.bin|starts\/[a-f0-9]{32}\.bin)$/;

export function validatePreparedSourcePackage(value: unknown, version: string, imageOrigin: string): PreparedSourcePackage {
  const data = value as PreparedSourcePackage;
  if (data?.schemaVersion !== 1 || data.version !== version || !/^[a-f0-9]{64}$/.test(data.key)
    || data.root !== imageOrigin + '/prepared' || !data.files || typeof data.files !== 'object' || Array.isArray(data.files))
    throw Error('Invalid prepared map package.');
  const entries = Object.entries(data.files);
  if (entries.length < 3 || entries.length > 256 || !data.files['/game-data/catalog.json'] || !data.files['/game-data/native-grid.bin']
    || entries.some(([path, file]) => !logicalFile.test(path) || !file || !/^[a-f0-9]{64}\.bin$/.test(file.file)
      || !Number.isSafeInteger(file.bytes) || file.bytes < 8 || file.bytes > PREPARED_SOURCE_FILE_LIMIT))
    throw Error('Invalid prepared map file list.');
  return data;
}

export function preparedSourceAad(version: string, path: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`noitaguessr-prepared-v1\n${version}\n${path}`);
}

/** Bounded immutable Pages reads. No plaintext catalog is publicly hosted. */
export function encryptedPreparedReader(data: PreparedSourcePackage, fetcher: typeof fetch = fetch) {
  let key: CryptoKey | undefined;
  return async (path: string): Promise<Response> => {
    const file = data.files[path];
    if (!logicalFile.test(path) || !file) throw Error('Prepared map file is missing.');
    const response = await fetcher(`${data.root}/${file.file}`, { redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!response.ok || Number(response.headers.get('Content-Length')) > file.bytes + 32) throw Error('Prepared map file is unavailable.');
    const reader = response.body?.getReader();
    if (!reader) throw Error('Prepared map file is empty.');
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        const part = await reader.read(); if (part.done) break;
        size += part.value.byteLength; if (size > file.bytes + 32) throw Error('Prepared map file exceeds its size bound.');
        chunks.push(part.value);
      }
    } finally { await reader.cancel().catch(() => {}); }
    if (size !== file.bytes + 32) throw Error('Prepared map file is truncated.');
    const encoded = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { encoded.set(chunk, offset); offset += chunk.length; }
    if (String.fromCharCode(...encoded.subarray(0, 4)) !== 'NGD1') throw Error('Invalid prepared map encoding.');
    key ??= await crypto.subtle.importKey('raw', Uint8Array.from(data.key.match(/../g)!, value => parseInt(value, 16)), 'AES-GCM', false, ['decrypt']);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: encoded.subarray(4, 16),
      additionalData: preparedSourceAad(data.version, path) }, key, encoded.subarray(16));
    return new Response(plain);
  };
}
