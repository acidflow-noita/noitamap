/** A general/temple scene can inherit the biome at its placement. Its warmed
 * folder-only composite must not replace that biome-specific artwork. */
export function sceneRenderKey(scene: { key: string; variantKey?: string }): string {
  const folder = scene.key.split('/')[0];
  const variants = (scene.variantKey ?? '').split('&').filter(part =>
    part && part !== `biome=${folder}`);
  return variants.length ? `${scene.key}|${variants.join('&')}` : scene.key;
}
