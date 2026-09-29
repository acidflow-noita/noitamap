import { expect, it } from 'vitest';
import { sceneRenderKey } from '../src/telescope/scene-render-key';

it('never reuses a prefetched general scene for a placement-specific biome variant', () => {
  const key = 'general/the_end_shop';
  const keys = ['', 'biome=general@the_end', 'biome=general@coalmine',
    'f0bbee=ebcd01&biome=general@the_end', 'f0bbee=103344&biome=general@the_end']
    .map(variantKey => sceneRenderKey({ key, variantKey }));
  expect(new Set(keys).size).toBe(keys.length);
});

it('shares prefetch only when the explicit biome is the folder default', () => {
  expect(sceneRenderKey({ key: 'coalmine/shop', variantKey: 'biome=coalmine' })).toBe('coalmine/shop');
  expect(sceneRenderKey({ key: 'coalmine/shop', variantKey: 'biome=coalmine_alt' }))
    .not.toBe('coalmine/shop');
  expect(sceneRenderKey({ key: 'vault/liquid', variantKey: 'f0bbee=ebcd01&biome=vault' }))
    .toBe('vault/liquid|f0bbee=ebcd01');
});
