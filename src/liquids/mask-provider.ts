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
  constructor(private inputs: LiquidMaskInputs) {}
  async prepare(view: MaskBounds, signal: AbortSignal): Promise<ViewLiquidMask | null> {
    signal.throwIfAborted(); if (this.destroyed) return null;
    const x = Math.floor(view.x / BLOCK) * BLOCK, y = Math.floor(view.y / BLOCK) * BLOCK;
    const bounds = { x, y, width: Math.ceil((view.x + view.width - x) / BLOCK) * BLOCK,
      height: Math.ceil((view.y + view.height - y) / BLOCK) * BLOCK };
    assertMaskBounds(bounds); this.preparations++;
    const visibleWorlds = (this.inputs.baked ?? []).filter(world => world.x + world.width > bounds.x && world.x < bounds.x + bounds.width);
    this.missingBakedWorlds = visibleWorlds.filter(world => !world.liquidMask).map(world => world.pw);
    const legacyWorlds = visibleWorlds.filter(world => !world.liquidMask?.preservesCapturedFluids)
      .map(({ x, width }) => ({ x, width }));
    const assets: MaskAsset[] = this.inputs.staticBackground ? [{ url: STATIC_MASK, excludeCapturedFluidsIn: legacyWorlds }] : [];
    for (const world of visibleWorlds) {
      if (!world.liquidMask) continue;
      if (!assets.some(asset => asset.url === world.liquidMask!.url)) assets.push(world.liquidMask);
    }
    const worker = this.worker ??= new LiquidMaskWorkerClient();
    const pixels = await worker.paint(bounds, assets, signal);
    signal.throwIfAborted();
    this.pendingLiveBlocks = 0;
    if (this.inputs.live) {
      const input = this.inputs.live;
      this.live ??= import('./live-source').then(module => module.createLiveLiquidSource(input))
        .catch(error => { this.live = undefined; throw error; });
      const live = await this.live;
      signal.throwIfAborted();
      this.liveReady = !!live;
      // A map can finish its first paint before its GPU query inputs become
      // available. Do not permanently cache that initial absence.
      if (!live) this.live = undefined;
      if (live) for (let by = 0; by < bounds.height; by += BLOCK) for (let bx = 0; bx < bounds.width; bx += BLOCK) {
        signal.throwIfAborted();
        const block = { x: bounds.x + bx, y: bounds.y + by, width: BLOCK, height: BLOCK };
        const key = `${block.x},${block.y}`;
        let tile = this.cache.get(key);
        if (!tile) {
          tile = new Uint8Array(BLOCK * BLOCK);
          for (let row = 0; row < BLOCK; row++)
            tile.set(pixels.subarray((by + row) * bounds.width + bx, (by + row) * bounds.width + bx + BLOCK), row * BLOCK);
          if (await live.paint(block, tile, signal)) {
            this.cache.set(key, tile);
            while (this.cache.size > 128) this.cache.delete(this.cache.keys().next().value!);
          } else this.pendingLiveBlocks++;
          // Yield between blocks, so the next navigation can cancel immediately.
          await new Promise(resolve => setTimeout(resolve, 0));
        }
        for (let row = 0; row < BLOCK; row++)
          pixels.set(tile.subarray(row * BLOCK, (row + 1) * BLOCK), (by + row) * bounds.width + bx);
      }
    }
    signal.throwIfAborted();
    return worker.crop(bounds, pixels, this.inputs.exclusions(bounds), signal);
  }
  stats() { return { preparations: this.preparations, cachedBlocks: this.cache.size, cachedBytes: this.cache.size * BLOCK * BLOCK,
    capturedMask: this.inputs.staticBackground, missingBakedWorlds: [...this.missingBakedWorlds],
    liveReady: this.liveReady, generatedPending: this.liveReady === false || this.pendingLiveBlocks > 0 }; }
  destroy() { this.destroyed = true; this.worker?.destroy(); this.cache.clear(); }
}
