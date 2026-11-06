import { LiquidMaskWorkerClient } from './mask-worker-client';
import type { ViewLiquidMask } from './mask-worker-client';
import { assertMaskBounds, type MaskBounds } from './mask-index';
import { artifact, pools } from './holy-mountain-water.json';

const WATER_MASK = new URL('./assets/holy-mountain-water.bin.gz', import.meta.url).href;
const BLOCK = 256;
export interface LiquidMaskInputs {
  staticBackground: boolean;
  exclusions(bounds: MaskBounds): readonly MaskBounds[];
}

/** Only the captured Holy Mountain water pools animate. No terrain material
 * queries or Daily sidecar downloads are needed for this fixed geometry. */
export class LiquidMaskProvider {
  private worker?: LiquidMaskWorkerClient;
  private destroyed = false;
  private preparations = 0;
  private lastPrepareMs = 0;
  constructor(private inputs: LiquidMaskInputs) {}
  async prepare(view: MaskBounds, signal: AbortSignal, _onProgress?: (mask: ViewLiquidMask) => void): Promise<ViewLiquidMask | null> {
    signal.throwIfAborted(); if (this.destroyed || !this.inputs.staticBackground) return null;
    const started = performance.now();
    const x = Math.floor(view.x / BLOCK) * BLOCK, y = Math.floor(view.y / BLOCK) * BLOCK;
    const bounds = { x, y, width: Math.ceil((view.x + view.width - x) / BLOCK) * BLOCK,
      height: Math.ceil((view.y + view.height - y) / BLOCK) * BLOCK };
    assertMaskBounds(bounds); this.preparations++;
    // Do not even start the mask worker while looking at other liquids/areas.
    if (!pools.some(pool => pool.x < view.x + view.width && pool.y < view.y + view.height &&
      pool.x + pool.width > view.x && pool.y + pool.height > view.y)) return null;
    const worker = this.worker ??= new LiquidMaskWorkerClient();
    const pixels = await worker.paint(bounds, [{ url: WATER_MASK, bytes: artifact.bytes, sha256: artifact.sha256 }], signal);
    signal.throwIfAborted();
    const mask = await worker.crop(bounds, pixels, this.inputs.exclusions(bounds), signal);
    signal.throwIfAborted(); this.lastPrepareMs = performance.now() - started;
    return mask ? { ...mask, coverage: bounds, complete: true } : null;
  }
  stats() { return { preparations: this.preparations, capturedMask: this.inputs.staticBackground,
    generatedPending: false, lastPrepareMs: this.lastPrepareMs }; }
  destroy() { this.destroyed = true; this.worker?.destroy(); }
}
