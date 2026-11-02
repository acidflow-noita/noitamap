import { getAllOverlays, type TargetOfInterest } from './data_sources/overlays';
import { type MapName } from './data_sources/tile_data';
import { gameTranslator } from './game-translations/translator';

import FlexSearch from 'flexsearch';
import type { Id as FlexSearchId } from 'flexsearch';

let index: any;
const overlays: Map<FlexSearchId, TargetOfInterest> = new Map();

/** Static search is not a prerequisite for opening the map or its toolbar. */
function getIndex() {
  if (index) return index;
  index = new FlexSearch.Document({
    document: { id: 'id', index: ['text', 'name', 'aliases'], tag: 'maps' },
    tokenize: 'forward',
  });
  for (const [type, entries] of getAllOverlays()) {
    for (const [position, data] of entries.entries()) {
      if (data.overlayType === 'path') continue;
      const id = `${type}:${position}`;
      overlays.set(id, data);
      index.add({ id, ...data });
    }
  }
  return index;
}

export const searchOverlays = (mapName: MapName, query: string, filters: Set<string>): TargetOfInterest[] => {
  // do the search
  const found = getIndex().search(query, { tag: { maps: mapName } }).flatMap((v: any) => v.result);
  // deduplicate the ids we get back
  const ids = new Set<FlexSearchId>(found);
  // turn the ids back into TargetOfInterest objects, but with translated display names
  return [...ids.values()].flatMap(key => {
    if (!overlays.has(key)) return [];

    // Determine overlay type from the key (format: "type:index")
    const overlayType = (key as any).split(':')[0] as string;
    const shortKeys: Record<string, string> = {
      'bosses': 'b',
      'items': 'i',
      'structures': 'st',
      'orbs': 'or',
      'spatialAwareness': 'sa',
      'hiddenMessages': 'msg'
    };
    const filterKey = shortKeys[overlayType] || overlayType;
    if (filters.size > 0 && !filters.has(filterKey)) return [];

    const originalData = overlays.get(key)!;

    // Apply translations at search time using the processed translation files
    let displayName = (originalData as any).name;

    switch (overlayType) {
      case 'bosses':
        displayName = gameTranslator.translateBoss((originalData as any).name);
        break;
      case 'items':
        displayName = gameTranslator.translateItem((originalData as any).name);
        break;
      case 'structures':
        displayName = gameTranslator.translateStructure((originalData as any).name);
        break;
      case 'orbs':
        displayName = gameTranslator.translateContent('orbs', (originalData as any).name);
        break;
      default:
        displayName = gameTranslator.translateGameContent((originalData as any).name);
        break;
    }

    // Return the original data but with translated display properties
    return [
      {
        ...originalData,
        displayName,
        displayText: (originalData as any).text ? gameTranslator.translateGameContent((originalData as any).text as any) : (originalData as any).text,
      },
    ];
  });
};
