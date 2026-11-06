import { decodeLiquidMask } from './mask-codec';
import { LiquidMaskIndex, assertMaskBounds, cropLiquidMask } from './mask-index';

export interface MaskAsset { url: string; bytes?: number; sha256?: string }
const sources = new Map<string, Promise<LiquidMaskIndex>>();
const active = new Set<number>(), cancelled = new Set<number>();
async function load(asset: MaskAsset) {
  let pending = sources.get(asset.url);
  if (!pending) {
    pending = (async () => {
      const response = await fetch(asset.url, { signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new Error(`Liquid mask unavailable (${response.status})`);
      let bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > 64 * 1024 * 1024 || (asset.bytes !== undefined && bytes.byteLength !== asset.bytes))
        throw new Error('Liquid mask size mismatch');
      if (asset.sha256) {
        const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
          .map(n => n.toString(16).padStart(2, '0')).join('');
        if (digest !== asset.sha256) throw new Error('Liquid mask identity mismatch');
      }
      if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
        const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
        const chunks: Uint8Array[] = []; let length = 0;
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          length += value.byteLength;
          if (length > 64 * 1024 * 1024) { await reader.cancel(); throw new Error('Expanded liquid mask exceeds budget'); }
          chunks.push(value);
        }
        bytes = new Uint8Array(length); let at = 0;
        for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }
      }
      return new LiquidMaskIndex(decodeLiquidMask(bytes));
    })().catch(error => { sources.delete(asset.url); throw error; });
    sources.set(asset.url, pending);
    if (sources.size > 4) sources.delete(sources.keys().next().value!);
  }
  return pending;
}

self.onmessage = async ({ data }) => {
  const { id, type, bounds } = data;
  if (type === 'cancel') { if (active.has(id)) cancelled.add(id); return; }
  active.add(id);
  try {
    assertMaskBounds(bounds);
    if (type === 'paint') {
      const assets = data.sources as MaskAsset[];
      const indices = await Promise.all(assets.map(load));
      if (cancelled.has(id)) return;
      const pixels = new Uint8Array(bounds.width * bounds.height);
      for (const index of indices) index.paint(pixels, bounds);
      self.postMessage({ id, pixels }, { transfer: [pixels.buffer] });
    } else if (type === 'crop') {
      const mask = cropLiquidMask(data.pixels, bounds, data.exclusions);
      self.postMessage({ id, mask }, { transfer: mask ? [mask.pixels.buffer] : [] });
    } else throw new Error('Unknown liquid mask request');
  } catch (error) {
    if (!cancelled.has(id)) self.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  } finally { active.delete(id); cancelled.delete(id); }
};
