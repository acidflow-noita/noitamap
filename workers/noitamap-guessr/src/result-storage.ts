import { STREAM_MAX_DOCUMENT_BYTES, type StreamPublishedResult } from '../../../src/guessr/stream-types';

/** Application payload/overhead budget, below the 500 MB Free database limit.
 * Other game tables and further database overhead retain substantial headroom. */
export const STREAM_STORAGE_BUDGET_BYTES = 256 * 1024 * 1024;
export const STREAM_RESULT_OVERHEAD_BYTES = 4096;
const encoder = new TextEncoder();
export interface StoredResultBody { result_json: string; result_gzip: unknown }

export async function encodeStoredResult(result: StreamPublishedResult, serialized: string, original = encoder.encode(serialized)) {
  if (!original.byteLength || original.byteLength > STREAM_MAX_DOCUMENT_BYTES) throw new Error('Invalid result size.');
  const gzip = await new Response(new Response(original).body!.pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
  const header = JSON.stringify({ storage: 'gzip-json-v1', host: { login: result.host.login, name: result.host.name },
    finishedAt: result.finishedAt, playerCount: result.players.length, rawBytes: original.byteLength });
  const bytes = encoder.encode(header).byteLength + gzip.byteLength;
  // Tiny/incompressible documents keep the original representation.
  return bytes + 128 < original.byteLength
    ? { json: header, gzip, bytes }
    : { json: serialized, gzip: null, bytes: original.byteLength };
}

function gzipBytes(value: unknown): Uint8Array<ArrayBuffer> {
  let bytes: Uint8Array<ArrayBuffer>;
  if (value instanceof ArrayBuffer) bytes = new Uint8Array(value);
  else if (ArrayBuffer.isView(value)) bytes = new Uint8Array(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  else if (Array.isArray(value) && value.length <= STREAM_MAX_DOCUMENT_BYTES
    && value.every(v => Number.isInteger(v) && v >= 0 && v <= 255)) bytes = new Uint8Array(value);
  else throw new Error('Invalid stored result encoding.');
  if (!bytes.byteLength || bytes.byteLength > STREAM_MAX_DOCUMENT_BYTES) throw new Error('Invalid stored result size.');
  return bytes;
}

export function acceptsGzip(value: string | null): boolean {
  let wildcard = false;
  for (const token of (value ?? '').toLowerCase().split(',')) {
    const [name, ...parameters] = token.trim().split(';');
    const quality = parameters.map(p => p.trim()).find(p => p.startsWith('q='));
    const q = quality === undefined ? 1 : Number(quality.slice(2));
    const allowed = Number.isFinite(q) && q > 0 && q <= 1;
    if (name === 'gzip') return allowed;
    if (name === '*') wildcard = allowed;
  }
  return wildcard;
}

export function storedResultResponse(stored: StoredResultBody, request: Request): Response {
  const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'public, max-age=31536000, immutable', Vary: 'Accept-Encoding' });
  if (stored.result_gzip === null || stored.result_gzip === undefined) return new Response(stored.result_json, { headers });
  const header = JSON.parse(stored.result_json);
  if (header.storage !== 'gzip-json-v1' || !Number.isSafeInteger(header.rawBytes)
    || header.rawBytes <= 0 || header.rawBytes > STREAM_MAX_DOCUMENT_BYTES) throw new Error('Invalid stored result header.');
  const compressed = gzipBytes(stored.result_gzip);
  if (acceptsGzip(request.headers.get('Accept-Encoding'))) {
    headers.set('Content-Encoding', 'gzip');
    const init = { headers, encodeBody: 'manual' as const };
    return new Response(compressed, init);
  }
  return new Response(new Response(compressed).body!.pipeThrough(new DecompressionStream('gzip')), { headers });
}
