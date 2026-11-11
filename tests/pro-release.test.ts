import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { loadVerifiedProModule } from '../src/pro-release';
const dataUrl = (code: string) => 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
afterEach(() => vi.restoreAllMocks());
function fixture() {
  const keyPair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const trust = { keyId: 'test', key: keyPair.publicKey.export({ format: 'jwk' }) };
  const base = 'https://pro.test/';
  const entry = 'assets/v2/entry-A.js', shared = 'assets/v2/shared-B.js', lazy = 'assets/v2/lazy-C.js';
  const source: Record<string, string> = {
    [entry]: 'import { value } from "./shared-B.js"; export const initial = value; export const later = () => import("./lazy-C.js"); export const sourceUrl = import.meta.url;',
    [shared]: 'export const value = "shared";',
    [lazy]: 'import { value } from "./shared-B.js"; export const value2 = value + " lazy";',
  };
  const edge = (name: string, text: string, kind: string, target?: string) => ({ kind, start: source[name].indexOf(text), end: source[name].indexOf(text) + text.length, ...(target ? { target } : {}) });
  const imports: Record<string, unknown[]> = {
    [entry]: [edge(entry, './shared-B.js', 'static', shared), edge(entry, 'import("./lazy-C.js")', 'dynamic', lazy), edge(entry, 'import.meta', 'meta')],
    [shared]: [], [lazy]: [edge(lazy, './shared-B.js', 'static', shared)],
  };
  const manifest = { schema: 1, keyId: 'test', entry, files: Object.fromEntries(Object.entries(source).map(([name, code]) => [name,
    { bytes: Buffer.byteLength(code), sha256: createHash('sha256').update(code).digest('hex'), imports: imports[name] }])) };
  const seal = () => {
    const payload = Buffer.from(JSON.stringify(manifest)).toString('base64url');
    return { payload, signature: sign('sha256', Buffer.from('noitamap-pro-release-v1\n' + payload), { key: keyPair.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url') };
  };
  let signed = seal();
  const fetcher = vi.fn<typeof fetch>(async input => {
    const path = new URL(String(input)).pathname.slice(1);
    return path === 'pro.manifest.json' ? Response.json(signed) : new Response(source[path], { status: source[path] === undefined ? 404 : 200 });
  });
  const moduleUrl = vi.fn(dataUrl), revokeUrl = vi.fn();
  const load = () => loadVerifiedProModule(base + 'pro.manifest.json', trust, { fetch: fetcher, moduleUrl, revokeUrl });
  return { trust, source, manifest, fetcher, moduleUrl, revokeUrl, entry, shared, lazy, load,
    reseal() { signed = seal(); }, tamperSignature() { signed = { ...signed, signature: Buffer.alloc(64).toString('base64url') }; } };
}
it('verifies the entry and static graph before execution while keeping feature imports lazy', async () => {
  const f = fixture(), module = await f.load();
  expect(module.initial).toBe('shared'); expect(module.sourceUrl).toBe('https://pro.test/' + f.entry);
  expect(f.fetcher.mock.calls.map(([url]) => String(url))).not.toContain('https://pro.test/' + f.lazy);
  expect(await (module.later as () => Promise<unknown>)()).toMatchObject({ value2: 'shared lazy' });
  expect(f.fetcher.mock.calls.filter(([url]) => String(url).endsWith(f.shared))).toHaveLength(1);
  expect(f.moduleUrl).toHaveBeenCalledTimes(3);
});
it('rejects a forged manifest before fetching or evaluating any JavaScript', async () => {
  const f = fixture(); f.tamperSignature();
  await expect(f.load()).rejects.toThrow('signature did not match');
  expect(f.fetcher).toHaveBeenCalledOnce(); expect(f.moduleUrl).not.toHaveBeenCalled();
});
it.each(['entry', 'shared'] as const)('rejects a changed %s chunk and cleans up generated URLs', async target => {
  const f = fixture(); f.source[f[target]] = f.source[f[target]].replace('value', 'wrong');
  await expect(f.load()).rejects.toThrow(/integrity|size limit/);
  expect(f.revokeUrl.mock.calls.length).toBe(f.moduleUrl.mock.calls.length);
});
it('checks a lazy chunk when it is requested without running changed code', async () => {
  const f = fixture(), module = await f.load();
  f.source[f.lazy] = f.source[f.lazy].replace('lazy', 'evil');
  await expect((module.later as () => Promise<unknown>)()).rejects.toThrow('integrity');
  expect(f.moduleUrl).toHaveBeenCalledTimes(2);
});
it('rejects a signed cyclic or missing dependency graph before module requests', async () => {
  const f = fixture();
  (f.manifest.files[f.shared].imports as unknown[]).push({ kind: 'static', start: 1, end: 2, target: f.entry }); f.reseal();
  await expect(f.load()).rejects.toThrow('cycle'); expect(f.fetcher).toHaveBeenCalledOnce();
  const missing = fixture();
  (missing.manifest.files[missing.shared].imports as unknown[]).push({ kind: 'static', start: 1, end: 2, target: 'assets/v2/missing.js' }); missing.reseal();
  await expect(missing.load()).rejects.toThrow('descriptor'); expect(missing.fetcher).toHaveBeenCalledOnce();
});
it('bounds signed resource sizes and rejects insecure origins', async () => {
  const f = fixture(); f.manifest.files[f.entry].bytes = 17 * 1024 * 1024; f.reseal();
  await expect(f.load()).rejects.toThrow('descriptor'); expect(f.moduleUrl).not.toHaveBeenCalled();
  await expect(loadVerifiedProModule('http://pro.test/pro.manifest.json', f.trust)).rejects.toThrow('origin');
});
