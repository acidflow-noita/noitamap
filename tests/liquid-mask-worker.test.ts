import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { encodeLiquidMask, maskBlock } from '../src/liquids/mask-codec';

let worker: { onmessage: (event: any) => Promise<void>; postMessage: ReturnType<typeof vi.fn> };
const bounds = { x: -3, y: 10, width: 3, height: 2 };
const bytes = encodeLiquidMask([maskBlock(-3, 10, 3, 2, new Uint8Array([0, 255, 0, 255, 255, 0]))!]);
beforeEach(async () => {
  vi.resetModules();
  worker = { onmessage: null!, postMessage: vi.fn() }; vi.stubGlobal('self', worker);
  await import('../src/liquids/mask-worker');
});
afterEach(() => vi.unstubAllGlobals());

describe('worker-owned sparse masks', () => {
  it('removes only the covered basin strip from old bakes before applying any generated fluid', async () => {
    const bounds = { x: 768, y: 1008, width: 3, height: 17 };
    const full = new Uint8Array(51).fill(255), generated = new Uint8Array(51);
    generated[4] = 255;
    const captured = encodeLiquidMask([maskBlock(bounds.x, bounds.y, 3, 17, full)!]);
    const live = encodeLiquidMask([maskBlock(bounds.x, bounds.y, 3, 17, generated)!]);
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(Uint8Array.from(url === '/captured' ? captured : live).buffer)));
    const sources = [{ url: '/captured', excludeCapturedFluidsIn: [{ x: -17920, width: 35840 }] }];
    await worker.onmessage({ data: { id: 1, type: 'paint', bounds, sources } });
    const pixels = worker.postMessage.mock.calls[0][0].pixels;
    expect([...pixels.slice(0, 9)]).toEqual([255, 255, 255, 255, 0, 0, 0, 0, 0]);
    expect([...pixels.slice(48)]).toEqual([255, 255, 255]); // world 1024 is visibly liquid
    await worker.onmessage({ data: { id: 2, type: 'paint', bounds, sources: [...sources, { url: '/generated' }] } });
    expect(worker.postMessage.mock.calls[1][0].pixels[4]).toBe(255);
  });
  it.each([false, true])('decodes bounded assets once and reuses them without repeated fetches (gzip=%s)', async compressed => {
    const body = compressed ? gzipSync(bytes) : bytes;
    const fetcher = vi.fn(async () => new Response(Uint8Array.from(body).buffer)); vi.stubGlobal('fetch', fetcher);
    const sources = [{ url: '/mask', bytes: body.length, sha256: createHash('sha256').update(body).digest('hex') }];
    await worker.onmessage({ data: { id: 1, type: 'paint', bounds, sources } });
    expect([...worker.postMessage.mock.calls[0][0].pixels]).toEqual([0, 255, 0, 255, 255, 0]);
    await worker.onmessage({ data: { id: 2, type: 'paint', bounds, sources } });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each(['html', 'size', 'hash', 'missing'])('rejects %s assets instead of painting an inferred mask', async failure => {
    vi.stubGlobal('fetch', vi.fn(async () => failure === 'missing'
      ? new Response('Not found', { status: 404 }) : new Response(failure === 'html' ? '<html>wrong route</html>' : Uint8Array.from(bytes).buffer)));
    const source = { url: '/mask', ...(failure === 'size' ? { bytes: 100000 } : {}),
      ...(failure === 'hash' ? { sha256: '0'.repeat(64) } : {}) };
    await worker.onmessage({ data: { id: 1, type: 'paint', bounds, sources: [source] } });
    expect(worker.postMessage.mock.calls[0][0]).toMatchObject({ id: 1, error: expect.any(String) });
    expect(worker.postMessage.mock.calls[0][0].pixels).toBeUndefined();
  });
  it('cancels an obsolete viewport while a shared asset loads, retaining that asset for the next view', async () => {
    let release!: (value: Response) => void;
    const fetcher = vi.fn(() => new Promise<Response>(resolve => { release = resolve; })); vi.stubGlobal('fetch', fetcher);
    const pending = worker.onmessage({ data: { id: 1, type: 'paint', bounds, sources: [{ url: '/mask' }] } });
    await worker.onmessage({ data: { id: 1, type: 'cancel' } });
    release(new Response(Uint8Array.from(bytes).buffer)); await pending;
    expect(worker.postMessage).not.toHaveBeenCalled();
    await worker.onmessage({ data: { id: 2, type: 'paint', bounds, sources: [{ url: '/mask' }] } });
    expect(fetcher).toHaveBeenCalledOnce(); expect(worker.postMessage.mock.calls[0][0].id).toBe(2);
  });
  it('crops in the worker and returns no frame for an empty or fully excluded view', async () => {
    const pixels = new Uint8Array([0, 255, 0, 255, 255, 0]);
    await worker.onmessage({ data: { id: 1, type: 'crop', bounds, pixels: pixels.slice(), exclusions: [] } });
    expect(worker.postMessage.mock.calls[0][0].mask).toMatchObject({ x: -3, y: 10, width: 2, height: 2 });
    await worker.onmessage({ data: { id: 2, type: 'crop', bounds, pixels, exclusions: [bounds] } });
    expect(worker.postMessage.mock.calls[1][0].mask).toBeNull();
  });
});
