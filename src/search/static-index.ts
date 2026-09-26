import { Document as SearchDocument, type Id as FlexSearchId } from 'flexsearch';
import { getAllOverlays, type TargetOfInterest } from '../data_sources/overlays';
import { type MapName } from '../data_sources/tile_data';
import { gameTranslator } from '../game-translations/translator';

const SEARCH_FIELDS = ['text', 'name', 'aliases'];
let index: SearchDocument | undefined;

// Keep the overlay objects separately; search results contain document IDs.
const overlays: Map<FlexSearchId, TargetOfInterest> = new Map();

// Dynamic maps have their own index. Build this one only when a static map is
// searched, then reuse it across maps with tags restricting the visible entries.
function getStaticIndex(): SearchDocument {
  if (index) return index;
  index = new SearchDocument({
    document: { id: 'id', index: SEARCH_FIELDS, tag: 'maps' },
    tokenize: 'forward',
  });

  for (const [type, overlayDatas] of getAllOverlays()) {
    for (const [idx, data] of overlayDatas.entries()) {
      if (data.overlayType === 'path') continue;
      const id = `${type}:${idx}`;
      overlays.set(id, data);

      // Index original names; translations are applied at search time.
      index.add({ id, ...data });
    }
  }
  return index;
}

export const searchOverlays = (mapName: MapName, query: string, filters: Set<string>): TargetOfInterest[] => {
  const index = getStaticIndex();
  // Query fields independently: FlexSearch 0.8's tagged multi-field search can
  // discard prior matches when a later field only matches another map.
  const found = SEARCH_FIELDS.flatMap(field =>
    index.search(query, { index: [field], tag: { maps: mapName } }).flatMap(result => result.result),
  );
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
