import json from '../data/tilesources.json';

export type TileData = {
  url: string;
  dziContent: string;
};

export type MapName = keyof typeof tileSources;

type TileSourceMap = Record<string, TileData[]>;

const tileSources = json satisfies TileSourceMap;

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

const versions = new Map<string, string>();
const versionRequests = new Map<string, Promise<string | undefined>>();
export function getKnownMapVersions(mapName: MapName): Record<string, string> {
  return Object.fromEntries(tileSources[mapName].flatMap(({ url }) => {
    const origin = new URL(url).origin;
    let version = versions.get(origin);
    if (!version) {
      try { version = localStorage.getItem(`noitamap-map-version:${origin}`) ?? undefined; } catch {}
      if (version) versions.set(origin, version);
    }
    return version ? [[origin, version]] : [];
  }));
}

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
  const promises = tileSources[mapName].map(async ({ url }): Promise<[string, string] | null> => {
    const versionFile = new URL('/currentVersion.txt', url);
    const origin = versionFile.origin;
    let request = versionRequests.get(origin);
    if (!request) {
      request = fetch(versionFile, { signal: AbortSignal.timeout(5000) })
      .then(async res => {
        if (res.status !== 200) throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
        const version = (await res.text()).trim();
        if (!version) throw new Error('Empty map version');
        versions.set(origin, version);
        try { localStorage.setItem(`noitamap-map-version:${origin}`, version); } catch {}
        return version;
      })
      .catch(err => {
        console.warn('[Map] Version check unavailable:', origin, err);
        return versions.get(origin);
      }).finally(() => versionRequests.delete(origin));
      versionRequests.set(origin, request);
    }
    const version = await request;
    return version ? [origin, version] : null;
  });

  // Wait for all requests to have set their key, then return the object
  const entries = await Promise.all(promises);

  return Object.fromEntries(entries.filter((entry): entry is [string, string] => entry !== null));
}
