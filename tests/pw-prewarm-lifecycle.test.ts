// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ workers: [] as any[] }));
vi.mock('../src/data-archive', () => ({ getDataZip: vi.fn() }));
vi.mock('../src/renderer_settings', () => ({ useRenderPerfGeneration: () => true }));
vi.mock('../src/telescope/terrain-elevator', () => ({ prepareElevatorShafts: vi.fn(), withoutElevatorEndpointSpawns: vi.fn() }));
vi.mock('../src/telescope/load-telescope', () => ({ loadTelescopeModules: vi.fn() }));
vi.mock('../src/telescope/telescope-dom-shim', () => ({ installTelescopeShim: vi.fn() }));
vi.mock('../src/telescope/telescope-data-bridge', () => ({ installFetchInterceptor: vi.fn(), installImageSrcInterceptor: vi.fn() }));
vi.mock('../src/telescope/telescope-cache-version', () => ({ ensureTelescopeCacheVersion: vi.fn() }));
vi.mock('../src/telescope/pw-worker?worker', () => ({ default: class {
  onmessage: any = null;
  onerror: any = null;
  messages: any[] = [];
  terminate = vi.fn();
  constructor() { state.workers.push(this); }
  postMessage(data: any) { this.messages.push(data); }
} }));
import { getDataZip } from '../src/data-archive';
import { prewarmParallelWorlds, releaseParallelWorlds } from '../src/telescope/telescope-adapter';

function archiveBarrier() {
  let resolve!: (value: any) => void;
  const promise = new Promise<any>(done => { resolve = done; });
  vi.mocked(getDataZip).mockReturnValue(promise);
  return { resolve };
}

describe('side-world prewarm archive/lifecycle ordering', () => {
  beforeEach(() => {
    releaseParallelWorlds();
    vi.clearAllMocks();
    state.workers.length = 0;
    vi.stubGlobal('Worker', class {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(async () => {
    releaseParallelWorlds();
    await Promise.resolve();
    await Promise.resolve();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('creates no workers until the cold archive cache write finishes', async () => {
    const archive = archiveBarrier();
    prewarmParallelWorlds();
    prewarmParallelWorlds();
    expect(state.workers).toHaveLength(0);
    archive.resolve({});
    await vi.waitFor(() => expect(state.workers).toHaveLength(2));
    expect(state.workers.every(worker => worker.messages.length === 1 && worker.messages[0].prepareOnly)).toBe(true);
    for (const worker of state.workers) {
      const job = worker.messages[0];
      worker.onmessage({ data: { requestId: job.requestId, pw: 0, success: true, pois: [], pixelScenes: [] } });
    }
  });

  it('cannot revive workers after leaving the map during archive loading', async () => {
    const archive = archiveBarrier();
    prewarmParallelWorlds();
    releaseParallelWorlds();
    archive.resolve({});
    await vi.waitFor(() => expect(console.warn).toHaveBeenCalled());
    expect(state.workers).toHaveLength(0);
    expect(String(vi.mocked(console.warn).mock.calls[0][1])).toContain('disposed');
  });

  it('does not create workers when the archive is unavailable or only one world is requested', async () => {
    const archive = archiveBarrier();
    prewarmParallelWorlds([0]);
    expect(getDataZip).not.toHaveBeenCalled();
    prewarmParallelWorlds();
    archive.resolve(null);
    await vi.waitFor(() => expect(console.warn).toHaveBeenCalled());
    expect(state.workers).toHaveLength(0);
    expect(String(vi.mocked(console.warn).mock.calls[0][1])).toContain('data.zip is unavailable');
  });
});
