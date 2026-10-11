import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeScenePack } from '../src/telescope/scene-pack';
import { encodeScenePixelRuns } from '../src/telescope/scene-pixel-runs';

const fixture = vi.hoisted(() => ({ fetch: vi.fn(), packs: { pixels: { url: '/pixels.bin.gz', scenes: 2, bytes: 0 } } }));
vi.mock('virtual:noitamap-scene-assets', () => ({ provenance: 'revision', packs: fixture.packs }));
vi.mock('../src/telescope/immutable-assets', () => ({ immutableTelescopeAssets: { fetch: fixture.fetch }, revisionedAssetUrl: (url: string) => url }));

const pixels = new Uint8Array(256).fill(42);
function pack() {
  const data = { one: encodeScenePixelRuns(pixels, 8, 8), two: encodeScenePixelRuns(pixels.slice().fill(9), 8, 8) };
  const bytes = encodeScenePack({ version: 1, fullPixels: true, data, spawns: { one: [], two: [] } }, 'revision');
  fixture.packs.pixels.bytes = bytes.byteLength;
  return bytes;
}
beforeEach(() => { vi.resetModules(); fixture.fetch.mockReset(); });
afterEach(() => vi.restoreAllMocks());

describe('optional prepared scene pixels', () => {
  it('coalesces loading, expands only requested scenes and preserves already loaded pixels', async () => {
    const bytes = pack(); fixture.fetch.mockResolvedValue(new Response(bytes.buffer as ArrayBuffer));
    const m = await import('../src/telescope/prepared-scene-pixels');
    const [a,b] = await Promise.all([m.prepareScenePixelInputs(),m.prepareScenePixelInputs()]);
    expect(a).toBe(b); expect(fixture.fetch).toHaveBeenCalledOnce();
    const target = { width:8,height:8,imgElement:null };
    m.restorePreparedScenePixels('one',target);
    expect(target.imgElement).toEqual(pixels);
    expect(a!.two.bytes.byteLength).toBe(8);
    const loaded = new Uint8Array([1,2,3,4]);
    const existing = { width:8,height:8,imgElement:loaded };
    m.restorePreparedScenePixels('one',existing);
    expect(existing.imgElement).toBe(loaded);
  });

  it('never waits for an unfinished pack when the original decoder needs pixels', async () => {
    let finish!: (response: Response) => void;
    const bytes = pack();
    fixture.fetch.mockReturnValue(new Promise<Response>(resolve => { finish=resolve; }));
    const m = await import('../src/telescope/prepared-scene-pixels');
    const pending = m.prepareScenePixelInputs();
    const target = { width:8,height:8,imgElement:null };
    expect(m.restorePreparedScenePixels('one',target)).toBeUndefined();
    expect(target.imgElement).toBeNull();
    finish(new Response(bytes.buffer as ArrayBuffer)); await pending;
    m.restorePreparedScenePixels('one',target);
    expect(target.imgElement).toEqual(pixels);
  });

  it('leaves missing/mismatched scenes to the original decoder', async () => {
    fixture.fetch.mockResolvedValue(new Response(pack().buffer as ArrayBuffer));
    vi.spyOn(console,'warn').mockImplementation(() => {});
    const m = await import('../src/telescope/prepared-scene-pixels');
    await m.prepareScenePixelInputs();
    for (const [key,width] of [['missing',8],['one',16]] as const) {
      const target = { width,height:8,imgElement:null };
      m.restorePreparedScenePixels(key,target);
      expect(target.imgElement).toBeNull();
    }
  });

  it('shares a failed optional load instead of retrying it once per scene', async () => {
    fixture.fetch.mockRejectedValue(new Error('offline'));
    const warning=vi.spyOn(console,'warn').mockImplementation(() => {});
    const m = await import('../src/telescope/prepared-scene-pixels');
    expect(await m.prepareScenePixelInputs()).toBeNull();
    expect(await m.prepareScenePixelInputs()).toBeNull();
    const target={width:8,height:8,imgElement:null};m.restorePreparedScenePixels('one',target);
    expect(target.imgElement).toBeNull();
    expect(fixture.fetch).toHaveBeenCalledOnce();expect(warning).toHaveBeenCalledOnce();
  });
});
