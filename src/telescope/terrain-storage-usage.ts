function size(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return 'unknown';
  return bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(2)} GiB`
    : `${(bytes / 1024 ** 2).toFixed(2)} MiB`;
}

/** The browser reports an approximate total for this site, not an individual
 * IndexedDB database. This diagnostic never holds up terrain completion. */
export async function reportTerrainStorageUsage(signal: AbortSignal, seed?: number): Promise<void> {
  if (signal.aborted) return;
  try {
    const storage = globalThis.navigator?.storage;
    if (!storage?.estimate) {
      console.info('[Instant terrain] Site storage estimate unavailable', { seed });
      return;
    }
    const { usage, quota } = await storage.estimate();
    if (signal.aborted) return;
    console.info(`[Instant terrain] Site storage: ${size(usage)} used / ${size(quota)} quota`, {
      seed,
      usageBytes: usage,
      quotaBytes: quota,
      scope: 'Browser estimate for the whole site: terrain, shared assets, other cached seeds and databases; excludes GPU/RAM usage',
    });
  } catch {
    if (!signal.aborted)
      console.info('[Instant terrain] Site storage estimate unavailable', { seed });
  }
}
