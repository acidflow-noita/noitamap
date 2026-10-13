/** Keep the candidate opt-in until target-driver startup and warm performance
 * are measured. It renders the existing HD map; no alternate page or UI. */
export function useNativeTerrainRenderer(): boolean {
  return new URLSearchParams(globalThis.location?.search ?? '').get('terrain-renderer') === 'native';
}
