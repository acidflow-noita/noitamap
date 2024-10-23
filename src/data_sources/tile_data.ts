import json from '../data/tilesources.json';

export type TileData = {
  url: string;
  // dziContent: string;
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
  const promises = tileSources[mapName].map(async ({ url }): Promise<[string, string]> => {
    const versionFile = new URL('/currentVersion.txt', url);

    // We don't want to fetch a cached version of the manifest!
    const cacheBustString = await fetch(versionFile, {
      // Commented out because it's causing CORS issues
      // headers: { 'cache-control': 'no-cache' }
    })
      .then(async res => {
        if (res.status !== 200) throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
        return (await res.text()).trim();
      })
      .catch(err => {
        console.error(err);
        return Math.random().toString(36).slice(2);
      });

    return [versionFile.origin, cacheBustString];
  });

  // Wait for all requests to have set their key, then return the object
  const entries = await Promise.all(promises);

  return Object.fromEntries(entries);
}
