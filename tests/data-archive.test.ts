import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHash, webcrypto } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import JSZip from 'jszip';
import { dataArchivesPlugin } from '../build_scripts/vite-data-archives';

const manifests = vi.hoisted(() => ({}) as Record<string, any>);
vi.mock('virtual:noitamap-asset-pages', () => ({ assetManifests: manifests }));
const base = 'https://maps.test/';
const hash = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
const pageOf = (bytes: Uint8Array, extension = 'bin') => ({ file: `game-assets/assets-${hash(bytes)}.${extension}`, revision: hash(bytes), bytes: bytes.length });
const response = (bytes: Uint8Array, revision?: string) => new Response(Uint8Array.from(bytes), {
  headers: revision ? { 'X-Noitamap-Asset-Revision': revision } : {},
});
let stored: Map<string, Response>, served: Map<string, Uint8Array>;
let cache: { match: ReturnType<typeof vi.fn>; put: ReturnType<typeof vi.fn> };
let fetcher: ReturnType<typeof vi.fn>, page: ReturnType<typeof pageOf>;
function fixture(value = 'current pixels') {
  const bytes = Uint8Array.from([0, 7, ...new TextEncoder().encode(value), 255]);
  page = pageOf(bytes);
  const index = new TextEncoder().encode(JSON.stringify({version:1,pages:[page],entries:{
    'stable.txt':[0,2,bytes.length-3], 'binary.bin':[0,0,bytes.length], 'empty.txt':[0,1,0],
  }}));
  const catalog = pageOf(index, 'json');
  served.set(base + page.file, bytes); served.set(base + catalog.file, index);
  for (const key of ['main','pixel_scenes','wang_tiles']) manifests[key] = catalog;
}
beforeEach(() => {
  vi.resetModules();
  stored=new Map();served=new Map();fixture();
  cache={match:vi.fn(async (request:Request)=>stored.get(request.url)?.clone()),
    put:vi.fn(async(request:Request,value:Response)=>{stored.set(request.url,value.clone());})};
  fetcher=vi.fn(async (url:string)=>served.has(url)?response(served.get(url)!):new Response('missing',{status:404}));
  vi.stubGlobal('fetch',fetcher);vi.stubGlobal('caches',{open:vi.fn(async()=>cache)});
  vi.stubGlobal('crypto',webcrypto);vi.stubGlobal('location',new URL(base+'assets/worker.js'));
  vi.stubGlobal('document',{baseURI:base});vi.stubGlobal('window',new EventTarget());
  vi.stubGlobal('navigator',{});vi.stubGlobal('self',globalThis);
  vi.spyOn(console,'error').mockImplementation(()=>{});
});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();vi.unstubAllEnvs();vi.useRealTimers();});

it('loads only the catalog initially and coalesces entry reads without unpacking a ZIP',async()=>{
  const progress=vi.fn();window.addEventListener('dataZipProgress',progress);
  const api=await import('../src/data-archive');
  const [a,b]=await Promise.all([api.getZip(),api.getZip()]);
  expect(a).toBe(b);expect(fetcher).toHaveBeenCalledTimes(1);
  const values=await Promise.all([a!.file('stable.txt')!.async('string'),b!.file('stable.txt')!.async('string')]);
  expect(values).toEqual(['current pixels','current pixels']);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(await a!.file('empty.txt')!.async('arraybuffer')).toHaveProperty('byteLength',0);
  expect(await a!.file('binary.bin')!.async('uint8array')).toEqual(served.get(base+page.file));
  expect(await (await a!.file('binary.bin')!.async('blob')).arrayBuffer()).toEqual(served.get(base+page.file)!.buffer);
  expect(a!.file('missing')).toBeNull();expect(a!.file('__proto__')).toBeNull();
  expect(await api.listEntries('stable')).toEqual(['stable.txt']);
  expect(progress).toHaveBeenCalledOnce();
  expect(fetcher.mock.calls.every(([url])=>String(url).includes('/game-assets/'))).toBe(true);
});

it('reuses verified pages after reload without any network validation',async()=>{
  let api=await import('../src/data-archive');
  expect(await api.readText('stable.txt')).toBe('current pixels');
  vi.resetModules();fetcher.mockClear();cache.put.mockClear();
  api=await import('../src/data-archive');
  expect(await api.readText('stable.txt')).toBe('current pixels');
  expect(fetcher).not.toHaveBeenCalled();expect(cache.put).not.toHaveBeenCalled();
});

it('preserves UTF-8 text, BOMs and literal line-break escapes from the original files',async()=>{
  const value='\ufeffkey,Русский\\ntext\n';fixture(value);
  const api=await import('../src/data-archive');
  expect(await api.readText('stable.txt')).toBe(value);
});

it('keeps old and new deployment pages isolated while allowing old tabs to finish',async()=>{
  const api=await import('../src/data-archive'),old=await api.getZip();
  await old!.file('stable.txt')!.async('string');fixture('changed pixels');
  const next=await api.getZip();expect(next).not.toBe(old);
  expect(await next!.file('stable.txt')!.async('string')).toBe('changed pixels');
  expect(await old!.file('stable.txt')!.async('string')).toBe('current pixels');
});

it('shares an optionally prepared index with a cold worker and lets it fetch missing pages',async()=>{
  vi.stubGlobal('document',undefined);vi.stubGlobal('window',undefined);
  let api=await import('../src/data-archive');
  await api.prepareDataArchive('main',base);
  expect(fetcher).toHaveBeenCalledTimes(1);
  vi.resetModules();fetcher.mockClear();api=await import('../src/data-archive');
  expect(await api.readText('stable.txt')).toBe('current pixels');
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(base+page.file,expect.objectContaining({cache:'force-cache'}));
});

it('resolves worker assets from the app base even if Telescope installs a synthetic document',async()=>{
  vi.stubGlobal('WorkerGlobalScope',class {static [Symbol.hasInstance]() {return true;}});
  vi.stubGlobal('document',{baseURI:base+'assets/worker.js'});
  const api=await import('../src/data-archive');
  expect(await api.readText('stable.txt')).toBe('current pixels');
  expect(fetcher.mock.calls.every(([url])=>String(url).startsWith(base+'game-assets/'))).toBe(true);
});

it.each(['main','worker'])('keeps %s reads usable with denied cache storage',async realm=>{
  if(realm==='worker'){vi.stubGlobal('document',undefined);vi.stubGlobal('window',undefined);}
  vi.mocked(caches.open).mockRejectedValue(new Error('denied'));
  const api=await import('../src/data-archive');
  expect(await api.readText('stable.txt')).toBe('current pixels');
  expect(await api.readText('stable.txt')).toBe('current pixels');
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it('does not delay usable bytes for denied or stalled optional writes',async()=>{
  cache.put.mockRejectedValueOnce(new Error('quota'));
  const api=await import('../src/data-archive');
  expect(await api.readText('stable.txt')).toBe('current pixels');
});

it('bounds unavailable cache I/O using the existing cache deadline',async()=>{
  vi.useFakeTimers();vi.mocked(caches.open).mockImplementationOnce(()=>new Promise(()=>{}));
  const api=await import('../src/data-archive');const ready=api.getZip();
  await vi.advanceTimersByTimeAsync(1501);expect(await ready).not.toBeNull();
});

it('ignores obsolete ZIP locks and entries',async()=>{
  const request=vi.fn(()=>{throw new Error('must not acquire ZIP lock');});
  vi.stubGlobal('navigator',{locks:{request}});stored.set(base+'data.zip',new Response('obsolete'));
  const api=await import('../src/data-archive');expect(await api.readText('stable.txt')).toBe('current pixels');
  expect(request).not.toHaveBeenCalled();
});

it('repairs damaged cached bytes even when the size and stored revision match',async()=>{
  let api=await import('../src/data-archive');expect(await api.readText('stable.txt')).toBe('current pixels');
  const key=[...stored.keys()].find(key=>decodeURIComponent(key).endsWith(page.file))!;
  stored.set(key,response(new Uint8Array(page.bytes).fill(99),page.revision));
  vi.resetModules();fetcher.mockClear();api=await import('../src/data-archive');
  expect(await api.readText('stable.txt')).toBe('current pixels');expect(fetcher).toHaveBeenCalledTimes(1);
  vi.resetModules();fetcher.mockClear();api=await import('../src/data-archive');
  expect(await api.readText('stable.txt')).toBe('current pixels');expect(fetcher).not.toHaveBeenCalled();
});

it.each(['HTML','wrong hash','truncated','404'])('rejects a %s deployment response and retries cleanly',async failure=>{
  const api=await import('../src/data-archive');
  const data=served.get(base+manifests.main.file)!;
  fetcher.mockResolvedValueOnce(failure==='HTML'?new Response('fallback',{headers:{'Content-Type':'text/html'}})
    :failure==='404'?new Response('missing',{status:404})
    :response(failure==='truncated'?data.subarray(1):new Uint8Array(data.length).fill(48)));
  expect(await api.getZip()).toBeNull();expect(stored.size).toBe(0);
  expect(await api.readText('stable.txt')).toBe('current pixels');
});

it('validates index ranges and distinguishes absent groups and files',async()=>{
  const {AssetCatalog,getZip}=await import('../src/data-archive');
  expect(()=>new AssetCatalog({version:1,pages:[page],entries:{bad:[0,1,page.bytes]}} as any,base)).toThrow('Invalid game asset range');
  expect(()=>new AssetCatalog({version:1,pages:[page],entries:{bad:[3,0,1]}} as any,base)).toThrow('Invalid game asset range');
  expect(await getZip('unknown')).toBeNull();
});

async function archive(value:string) { return new JSZip().file('stable.txt',value,{date:new Date(2000,0,1)}).generateAsync({type:'uint8array'}); }

it("hashes shipped ZIP content and invalidates the dev manifest when bytes change", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "noitamap-archive-manifest-"));
  try {
    await mkdir(resolve(root, "public/biome_bg"), { recursive: true });
    for (const file of ["data.zip", "pixel_scenes.zip", "wang_tiles.zip"])
      await writeFile(resolve(root, "public", file), await archive("current pixels"));
    const plugin = dataArchivesPlugin(root),
      context = { addWatchFile: vi.fn() };
    const load = plugin.load as Function;
    const first = await load.call(context, "\0virtual:noitamap-data-archives");
    expect(first).toContain(hash(await archive("current pixels")));
    const replacement = await archive("updated source ZIP");
    await writeFile(resolve(root, "public/data.zip"), replacement);
    const second = await load.call(context, "\0virtual:noitamap-data-archives");
    expect(second).toContain(`"main":"${hash(replacement)}"`);
    expect(second).not.toBe(first);
    const module = {},
      invalidateModule = vi.fn(),
      send = vi.fn();
    (plugin.hotUpdate as Function).call({
      environment: {
        moduleGraph: { getModuleById: () => module, invalidateModule },
        hot: { send },
      },
    }, { file: resolve(root, "public/data.zip"), type: 'update' });
    expect(invalidateModule).toHaveBeenCalledWith(module);
    expect(send).toHaveBeenCalledWith({ type: "full-reload", path: "*" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
