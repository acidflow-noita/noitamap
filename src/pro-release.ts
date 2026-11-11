/** Execute only a signed, hash-checked Pro module graph. Lazy feature chunks
 * remain lazy. No hosted wrapper, computed import or unsigned fallback runs. */
export interface ProTrust { keyId: string; key: JsonWebKey }
interface Edge { kind: 'static' | 'dynamic' | 'meta'; start: number; end: number; target?: string }
interface ModuleFile { bytes: number; sha256: string; imports: Edge[] }
interface Manifest { schema: 1; keyId: string; entry: string; files: Record<string, ModuleFile> }
interface Runtime {
  fetch: typeof fetch;
  moduleUrl(code: string): string;
  revokeUrl(url: string): void;
  importModule(url: string): Promise<Record<string, unknown>>;
}
const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true });
const hook = '__noitamapVerifiedProImportV1';
const registryName = '__noitamapVerifiedProRegistryV1';
type Importer = (name: string) => Promise<Record<string, unknown>>;
const shared = globalThis as typeof globalThis & { __noitamapVerifiedProRegistryV1?: Map<string, Importer>; __noitamapVerifiedProImportV1?: (release: string, name: string) => Promise<Record<string, unknown>> };
const releases = shared.__noitamapVerifiedProRegistryV1 ?? new Map<string, Importer>();
if (!shared.__noitamapVerifiedProRegistryV1) {
  Object.defineProperty(globalThis, registryName, { value: releases });
  Object.defineProperty(globalThis, hook, { value: (release: string, name: string) => {
    const load = releases.get(release);
    if (!load) return Promise.reject(Error('The verified Pro release is unavailable.'));
    return load(name);
  } });
}
const defaultRuntime: Runtime = {
  fetch: (...args) => fetch(...args),
  moduleUrl: code => URL.createObjectURL(new Blob([code], { type: 'application/javascript' })),
  revokeUrl: url => URL.revokeObjectURL(url),
  importModule: url => import(/* @vite-ignore */ url),
};
function decode64(text: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(text) || text.length % 4 === 1) throw Error('Invalid Pro signature encoding.');
  const raw = atob(text.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(text.length / 4) * 4, '='));
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}
async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), n => n.toString(16).padStart(2, '0')).join('');
}
async function readBounded(response: Response, maximum: number): Promise<Uint8Array<ArrayBuffer>> {
  if (!response.ok) throw Error(`Pro resource unavailable (HTTP ${response.status}).`);
  if (Number(response.headers.get('Content-Length')) > maximum) throw Error('Pro resource exceeds its size limit.');
  const reader = response.body?.getReader();
  if (!reader) throw Error('Pro resource is empty.');
  const parts: Uint8Array[] = []; let size = 0;
  while (true) {
    const part = await reader.read(); if (part.done) break;
    size += part.value.length;
    if (size > maximum) { await reader.cancel(); throw Error('Pro resource exceeds its size limit.'); }
    parts.push(part.value);
  }
  const result = new Uint8Array(size); let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}
function validateManifest(value: Manifest, trust: ProTrust): void {
  if (value?.schema !== 1 || value.keyId !== trust.keyId || !value.files || typeof value.files !== 'object' || Array.isArray(value.files))
    throw Error('Invalid Pro release manifest.');
  const entries = Object.entries(value.files);
  if (!entries.length || entries.length > 256 || !Object.hasOwn(value.files, value.entry)) throw Error('Invalid Pro module graph.');
  let bytes = 0;
  for (const [name, file] of entries) {
    if (!/^assets\/v2\/[A-Za-z0-9_-]+\.js$/.test(name) || !file || !Number.isSafeInteger(file.bytes)
      || file.bytes <= 0 || file.bytes > 16 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(file.sha256)
      || !Array.isArray(file.imports) || file.imports.length > 4096) throw Error('Invalid Pro module descriptor.');
    bytes += file.bytes; let end = 0;
    for (const edge of file.imports) {
      if (!edge || !['static', 'dynamic', 'meta'].includes(edge.kind) || !Number.isSafeInteger(edge.start) || !Number.isSafeInteger(edge.end)
        || edge.start < end || edge.end <= edge.start || edge.end > file.bytes
        || edge.kind !== 'meta' && (!edge.target || !Object.hasOwn(value.files, edge.target))) throw Error('Invalid Pro import descriptor.');
      end = edge.end;
    }
  }
  if (bytes > 64 * 1024 * 1024) throw Error('Pro release exceeds its size limit.');
  const visiting = new Set<string>(), done = new Set<string>();
  const visit = (name: string) => {
    if (visiting.has(name)) throw Error('Invalid Pro static import cycle.');
    if (done.has(name)) return;
    visiting.add(name);
    for (const edge of value.files[name].imports) if (edge.kind === 'static') visit(edge.target!);
    visiting.delete(name); done.add(name);
  };
  entries.forEach(([name]) => visit(name));
}

export async function loadVerifiedProModule(manifestUrl: string, trust: ProTrust, overrides: Partial<Runtime> = {}): Promise<Record<string, unknown>> {
  const runtime = { ...defaultRuntime, ...overrides };
  const url = new URL(manifestUrl);
  if (url.protocol !== 'https:' || url.username || url.password) throw Error('Invalid Pro release origin.');
  const base = new URL('./', url);
  const response = await runtime.fetch(url.href, { cache: 'no-cache', credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(20000) });
  const signed = JSON.parse(decoder.decode(await readBounded(response, 512 * 1024))) as { payload?: unknown; signature?: unknown };
  if (typeof signed.payload !== 'string' || typeof signed.signature !== 'string' || trust.key.d) throw Error('Invalid Pro release signature.');
  const key = await crypto.subtle.importKey('jwk', trust.key, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  if (!await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, decode64(signed.signature), encoder.encode('noitamap-pro-release-v1\n' + signed.payload)))
    throw Error('Pro release signature did not match.');
  const payload = decode64(signed.payload), manifest = JSON.parse(decoder.decode(payload)) as Manifest;
  validateManifest(manifest, trust);
  const releaseId = await sha256(payload) + ':' + await sha256(encoder.encode(JSON.stringify([trust.key.kty, trust.key.crv, trust.key.x, trust.key.y]))) + ':' + base.href;
  const existing = releases.get(releaseId);
  if (existing) return existing(manifest.entry);
  const urls = new Map<string, string>(), preparing = new Map<string, Promise<string>>(), modules = new Map<string, Promise<Record<string, unknown>>>();
  let disposed = false;
  const createUrl = (name: string): Promise<string> => {
    let pending = preparing.get(name); if (pending) return pending;
    const file = manifest.files[name];
    if (!Object.hasOwn(manifest.files, name)) return Promise.reject(Error('Unsigned Pro module dependency.'));
    pending = (async () => {
      const sourceUrl = new URL(name, base).href;
      const [source, dependencies] = await Promise.all([
        runtime.fetch(sourceUrl, { credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(20000) }).then(response => readBounded(response, file.bytes)),
        Promise.all(file.imports.filter(edge => edge.kind === 'static').map(async edge => [edge.target!, await createUrl(edge.target!)] as const)),
      ]);
      if (source.length !== file.bytes || await sha256(source) !== file.sha256) throw Error('Pro module integrity check failed: ' + name);
      let code = decoder.decode(source);
      const dependencyUrls = new Map(dependencies);
      for (const edge of [...file.imports].reverse()) {
        if (edge.end > code.length) throw Error('Invalid Pro import location.');
        const replacement = edge.kind === 'meta' ? `({url:${JSON.stringify(sourceUrl)}})`
          : edge.kind === 'static' ? dependencyUrls.get(edge.target!)!
          : `globalThis.${hook}(${JSON.stringify(releaseId)},${JSON.stringify(edge.target)})`;
        code = code.slice(0, edge.start) + replacement + code.slice(edge.end);
      }
      if (disposed) throw Error('Pro release loading was cancelled.');
      const blob = runtime.moduleUrl(code); urls.set(name, blob); return blob;
    })();
    preparing.set(name, pending); void pending.catch(() => { preparing.delete(name); }); return pending;
  };
  const load = (name: string): Promise<Record<string, unknown>> => {
    let pending = modules.get(name);
    if (!pending) { pending = createUrl(name).then(url => runtime.importModule(url)); modules.set(name, pending); }
    return pending;
  };
  releases.set(releaseId, load);
  try { return await load(manifest.entry); }
  catch (error) {
    disposed = true; releases.delete(releaseId);
    for (const blob of urls.values()) runtime.revokeUrl(blob);
    throw error;
  }
}
