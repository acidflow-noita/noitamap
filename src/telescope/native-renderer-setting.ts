/** Native startup is faster on the tested hardware path. Retain the existing
 * software/unknown-adapter default, whose warm draws were faster in native GLES.
 * Explicit overrides remain available for comparison and troubleshooting. */
export function useNativeTerrainRenderer(hardware = false): boolean {
  const override = new URLSearchParams(globalThis.location?.search ?? '').get('terrain-renderer');
  if (override === 'native') return true;
  if (override === 'legacy') return false;
  return hardware;
}
