import type { LiquidMaskInputs } from './mask-provider';
import type { LiquidOverlay } from './overlay';
let overlay: LiquidOverlay | undefined, epoch = 0;
let state = 'disabled';

export function clearLiquidWobble() { epoch++; overlay?.destroy(); overlay = undefined; state = 'disabled'; }
export function installLiquidWobble(viewer: any, inputs: LiquidMaskInputs) {
  clearLiquidWobble();
  if (new URLSearchParams(location.search).get('liquidWobble') === '0' || typeof createImageBitmap !== 'function') return;
  const current = epoch;
  state = 'loading';
  void import('./overlay').then(({ LiquidOverlay }) => {
    if (current !== epoch) return;
    overlay = new LiquidOverlay(viewer, inputs); state = 'ready';
  }).catch(error => {
    if (current !== epoch) return;
    state = 'error'; console.warn('[Liquid wobble] Optional renderer unavailable:', error);
  });
}
export function getLiquidWobbleStats() { return overlay?.stats() ?? { status: state }; }
if (typeof window !== 'undefined') (window as any).__liquidWobbleStats = getLiquidWobbleStats;
if (typeof window !== 'undefined') (window as any).__setLiquidWobble = (enabled: boolean) => {
  overlay?.setEnabled(!!enabled); return !!overlay;
};
