import { createPreparedRoundSource, createPreparedSourceCache, type PreparedSourceCache } from '../../../src/guessr/prepared-rounds';
import type { Env } from './index';

// Cache only validated immutable bytes, never responses or pending binding I/O.
// A deployment's ASSETS binding scopes its catalog/grid; configuration changes
// get independent caches. Limit retained variants even in long-lived isolates.
const caches = new WeakMap<Env['ASSETS'], Map<string, PreparedSourceCache>>();
export function preparedSource(env: Env) {
  const images = env.STREAM_IMAGE_ROOT || 'https://guessr-tiles.sage-data.xyz/images';
  const reference = env.STREAM_REFERENCE_ROOT || 'https://guessr-map.sage-data.xyz/map_files/';
  let variants = caches.get(env.ASSETS);
  if (!variants) { variants = new Map(); caches.set(env.ASSETS, variants); }
  const key = images + '\n' + reference;
  let cache = variants.get(key);
  if (!cache) {
    if (variants.size >= 2) variants.delete(variants.keys().next().value!);
    cache = createPreparedSourceCache(); variants.set(key, cache);
  }
  return createPreparedRoundSource(path => env.ASSETS.fetch(new Request('https://private.invalid' + path)), images, reference, undefined, cache);
}
