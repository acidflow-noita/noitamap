import json from '../data/tilesources.json';
import { STARTUP_REQUEST_TIMEOUT_MS } from '../startup';

export type TileData = {
  url: string;
  dziContent: string;
};

export type MapName = keyof typeof tileSources;

type TileSourceMap = Record<string, TileData[]>;

const tileSources = json satisfies TileSourceMap;
const versionCache = new Map<string, string>();
const VERSION_KEY = 'noitamap-map-version:';
const fallbackVersion = typeof __BUILD_VERSION__ === 'undefined' ? 'startup' : __BUILD_VERSION__;

/** Open from bundled geometry and a stable cached version, without a network gate. */
export function getCachedMapVersions(mapName: MapName): Record<string, string> {
  return Object.fromEntries(tileSources[mapName].map(({ url }) => {
    const origin = new URL(url).origin;
    let version = versionCache.get(origin);
    if (!version) try {
      const stored = localStorage.getItem(VERSION_KEY + origin);
      if (stored && /^[A-Za-z0-9_.:-]{1,128}$/.test(stored)) version = stored;
    } catch { /* Storage is optional. */ }
    return [origin, version ?? fallbackVersion];
  }));
}

export const isValidMapName = (name: string | undefined): name is MapName => {
  return typeof name === 'string' && Object.prototype.hasOwnProperty.call(tileSources, name);
};
export const assertMapName = (name: string): MapName => {
  if (!isValidMapName(name)) {
    throw new Error(`Invalid MapName: '${name}'`);
  }
  return name;
};
export const asMapName = (name: string | undefined): MapName | undefined => (isValidMapName(name) ? name : undefined);

export const getTileData = (name: MapName): TileData[] => tileSources[name];

/**
 * Fetches map versions for a given map name.
 *
 * @example
 *
 * fetchMapVersions('regular-main-branch') => [
 *  'https://regular-main-branch-middle.acidflow.stream': 1234567890,
 *  'https://regular-main-branch-left.acidflow.stream': 1234567890,
 *  'https://regular-main-branch-right.acidflow.stream': 1234567890,
 * ]
 */
export async function fetchMapVersions(mapName: MapName): Promise<Record<string, string>> {
  const cached = getCachedMapVersions(mapName);
  const promises = tileSources[mapName].map(async ({ url }): Promise<[string, string]> => {
    const versionFile = new URL('/currentVersion.txt', url);

    // We don't want to fetch a cached version of the manifest!
    const cacheBustString = await fetch(versionFile, {
      cache: 'no-store',
      signal: AbortSignal.timeout(STARTUP_REQUEST_TIMEOUT_MS),
    })
      .then(async res => {
        if (res.status !== 200) throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
        const version = (await res.text()).trim();
        if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(version)) throw new Error('Invalid map version response');
        versionCache.set(versionFile.origin, version);
        try { localStorage.setItem(VERSION_KEY + versionFile.origin, version); } catch { /* Storage is optional. */ }
        return version;
      })
      .catch(err => {
        console.error(err);
        return cached[versionFile.origin];
      });

    return [versionFile.origin, cacheBustString];
  });

  // Wait for all requests to have set their key, then return the object
  const entries = await Promise.all(promises);

  return Object.fromEntries(entries);
}
