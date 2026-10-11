import { packs, provenance } from 'virtual:noitamap-scene-assets';
import { immutableTelescopeAssets, revisionedAssetUrl } from './immutable-assets';
import { unpackSceneInputs } from './unpack-scene-inputs';
import { decodeScenePixelRuns, type ScenePixelRuns } from './scene-pixel-runs';

let pending: Promise<Record<string, ScenePixelRuns> | null> | undefined;
let ready: Record<string, ScenePixelRuns> | undefined;

/** Optional fast path: the original PNG decoder remains available if this
 * asset cannot load. A failure is shared, never retried once per scene. */
export function prepareScenePixelInputs(): Promise<Record<string, ScenePixelRuns> | null> {
  return pending ??= (async () => {
    const pack = packs.pixels;
    const response = await immutableTelescopeAssets.fetch('prepared-scenes/pixels', provenance,
      () => fetch(revisionedAssetUrl(pack.url, provenance), {
        cache: 'force-cache', signal: AbortSignal.timeout(30000),
      }));
    if (!response.ok) throw new Error(`Prepared scene pixels: HTTP ${response.status}`);
    const result = await unpackSceneInputs(await response.arrayBuffer(), pack.bytes, provenance);
    if (!result.fullPixels || Object.keys(result.data).length !== pack.scenes)
      throw new Error('Prepared scene pixel count differs');
    ready = result.data as Record<string, ScenePixelRuns>;
    return ready;
  })().catch(error => {
    console.warn('[Telescope] Prepared scene pixels unavailable; using original PNGs:', error);
    return null;
  });
}

/** Reconstruct only requested images; metadata/PW workers stay pixel-free.
 * A slow/missing optional download must never delay the original PNG path. */
export function restorePreparedScenePixels(key: string, target: any): void {
  const record = ready?.[key];
  if (!record || ArrayBuffer.isView(target.imgElement)) return;
  try {
    if (record.width !== target.width || record.height !== target.height)
      throw new Error('Prepared scene pixel dimensions differ');
    target.imgElement = decodeScenePixelRuns(record);
  } catch (error) {
    console.warn('[Telescope] Prepared scene pixels rejected; using original PNG:', key, error);
  }
}
