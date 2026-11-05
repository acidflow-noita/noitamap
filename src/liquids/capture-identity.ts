import { capture } from './static-sources.json';
import { getTileData } from '../data_sources/tile_data';

/** Never apply one capture's liquid geometry to a different background map. */
export function supportsCapturedLiquidMask(sources = getTileData('dynamic-main-branch')) {
  if (sources.length !== capture.parallelWorlds.length) return false;
  return sources.every(({ url }) => {
    try {
      return new URL(url).pathname.endsWith(`-${capture.sourceDate}-${capture.filenameSeed}.dzi`) &&
        new URL(url).pathname.includes(`/${capture.mapKey}-`);
    } catch { return false; }
  });
}
