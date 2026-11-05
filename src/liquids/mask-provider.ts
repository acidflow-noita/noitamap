import { LiquidMaskWorkerClient } from './mask-worker-client';
import type { ViewLiquidMask } from './mask-worker-client';
import type { MaskAsset } from './mask-worker';
import { assertMaskBounds, type MaskBounds } from './mask-index';
import type { LiveLiquidInput } from './live-source';
import type { BakedDziPlacement } from '../telescope/baked-dzi-loader';

const STATIC_MASK = new URL('./assets/static-mask.bin.gz', import.meta.url).href;
const BLOCK = 256;
export interface LiquidMaskInputs {
  baked?: readonly BakedDziPlacement[];
  staticBackground: boolean;
  live?: LiveLiquidInput;
  exclusions(bounds: MaskBounds): readonly MaskBounds[];
}

export class LiquidMaskProvider {
  private worker?: LiquidMaskWorkerClient;
  private live?: Promise<Awaited<ReturnType<typeof import('./live-source').createLiveLiquidSource>>>;
  private cache = new Map<string, Uint8Array>();
  private destroyed = false;
  private preparations = 0;
  private missingBakedWorlds: number[] = [];
  private liveReady: boolean | null = null;
  private pendingLiveBlocks = 0;
  private progressUpdates = 0;
  private lastPrepareMs = 0;
  constructor(private inputs: LiquidMaskInputs) {}
  async prepare(view: MaskBounds, signal: AbortSignal, onProgress?: (mask: ViewLiquidMask) => void): Promise<ViewLiquidMask | null> {
    signal.throwIfAborted(); if (this.destroyed) return null;
    const started = performance.now();
    const x = Math.floor(view.x / BLOCK) * BLOCK, y = Math.floor(view.y / BLOCK) * BLOCK;
    const bounds = { x, y, width: Math.ceil((view.x + view.width - x) / BLOCK) * BLOCK,
      height: Math.ceil((view.y + view.height - y) / BLOCK) * BLOCK };
    assertMaskBounds(bounds); this.preparations++;
    const visibleWorlds = (this.inputs.baked ?? []).filter(world => world.x + world.width > bounds.x && world.x < bounds.x + bounds.width);
    this.missingBakedWorlds = visibleWorlds.filter(world => !world.liquidMask).map(world => world.pw);
    const legacyWorlds = visibleWorlds.filter(world => !world.liquidMask?.preservesCapturedFluids)
      .map(({ x, width }) => ({ x, width }));
    const assets: MaskAsset[] = [];
    for (const world of visibleWorlds) {
      if (!world.liquidMask) continue;
      if (!assets.some(asset => asset.url === world.liquidMask!.url)) assets.push(world.liquidMask);
    }
    const worker = this.worker ??= new LiquidMaskWorkerClient();
    const pixels = await worker.paint(bounds, this.inputs.staticBackground ? [{ url: STATIC_MASK, excludeCapturedFluidsIn: legacyWorlds }] : [], signal);
    signal.throwIfAborted();
    let lastProgress = -Infinity;
    const publish = async (force = false) => {
      if (!onProgress || !force && performance.now() - lastProgress < 160 || !pixels.includes(255)) return;
      // crop transfers its buffer. Keep the working mask for the remaining
      // blocks and publish an immutable partial result, never a mutable view.
      const mask = await worker.crop(bounds, pixels.slice(), this.inputs.exclusions(bounds), signal);
      signal.throwIfAborted();
      if (mask) { lastProgress = performance.now(); this.progressUpdates++; onProgress({ ...mask, complete: false }); }
    };
    // Captured pools must not wait for a large Daily sidecar download.
    if (assets.length) {
      await publish(true);
      const generated = await worker.paint(bounds, assets, signal);
      signal.throwIfAborted();
      for (let i = 0; i < pixels.length; i++) if (generated[i]) pixels[i] = generated[i];
    }
    this.pendingLiveBlocks = 0;
    if (this.inputs.live) {
      const missing: MaskBounds[] = [];
      const copyBlock = (block: MaskBounds, tile: Uint8Array) => {
        const bx = block.x - bounds.x, by = block.y - bounds.y;
        for (let row = 0; row < BLOCK; row++)
          pixels.set(tile.subarray(row * BLOCK, (row + 1) * BLOCK), (by + row) * bounds.width + bx);
      };
      for (let by = 0; by < bounds.height; by += BLOCK) for (let bx = 0; bx < bounds.width; bx += BLOCK) {
        const block = { x: bounds.x + bx, y: bounds.y + by, width: BLOCK, height: BLOCK };
        const tile = this.cache.get(`${block.x},${block.y}`);
        if (tile) copyBlock(block, tile); else missing.push(block);
      }
      this.pendingLiveBlocks = missing.length;
      // Publish fixed pools and previously visited blocks before waiting for
      // any new material query. Resolve the visible center first afterwards.
      if (missing.length) await publish(true);
      const cx = view.x + view.width / 2, cy = view.y + view.height / 2;
      const distance = (block: MaskBounds) => (block.x + BLOCK / 2 - cx) ** 2 + (block.y + BLOCK / 2 - cy) ** 2;
      missing.sort((a, b) => distance(a) - distance(b));
      const input = this.inputs.live;
      this.live ??= import('./live-source').then(module => module.createLiveLiquidSource(input))
        .catch(error => { this.live = undefined; throw error; });
      const live = await this.live;
      signal.throwIfAborted();
      this.liveReady = !!live;
      // A map can finish its first paint before its GPU query inputs become
      // available. Do not permanently cache that initial absence.
      if (!live) this.live = undefined;
      if (live) for (const block of missing) {
        signal.throwIfAborted();
        const bx = block.x - bounds.x, by = block.y - bounds.y;
        const key = `${block.x},${block.y}`;
        const tile = new Uint8Array(BLOCK * BLOCK);
        for (let row = 0; row < BLOCK; row++)
          tile.set(pixels.subarray((by + row) * bounds.width + bx, (by + row) * bounds.width + bx + BLOCK), row * BLOCK);
        if (await live.paint(block, tile, signal)) {
          this.pendingLiveBlocks--;
          this.cache.set(key, tile);
          while (this.cache.size > 128) this.cache.delete(this.cache.keys().next().value!);
        }
        copyBlock(block, tile);
        if (tile.includes(255)) await publish();
        // Yield between blocks, so navigation/terrain keep their priority.
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }
    signal.throwIfAborted();
    const mask = await worker.crop(bounds, pixels, this.inputs.exclusions(bounds), signal);
    signal.throwIfAborted(); this.lastPrepareMs = performance.now() - started;
    return mask ? { ...mask, coverage: bounds, complete: !this.stats().generatedPending } : null;
  }
  stats() { return { preparations: this.preparations, cachedBlocks: this.cache.size, cachedBytes: this.cache.size * BLOCK * BLOCK,
    capturedMask: this.inputs.staticBackground, missingBakedWorlds: [...this.missingBakedWorlds],
    liveReady: this.liveReady, generatedPending: this.liveReady === false || this.pendingLiveBlocks > 0,
    pendingBlocks: this.pendingLiveBlocks, progressUpdates: this.progressUpdates, lastPrepareMs: this.lastPrepareMs }; }
  destroy() { this.destroyed = true; this.worker?.destroy(); this.cache.clear(); }
}
