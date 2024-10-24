import { getAllOverlays, type TargetOfInterest } from './data_sources/overlays';
import { type MapName } from './data_sources/tile_data';

import type FFlexSearch from 'flexsearch';
import type { Id as FlexSearchId, IndexOptionsForDocumentSearch, StoreOption } from 'flexsearch';

// on load, we'll instantiate flexsearch just once, but we'll tell it
// about the different maps and require that when a user queries the
// list, they supply the map they're searching. we can use the "tags"
// feature to only return items that are present in the map being searched

// FlexSearch's types are _fucked_, so we have to do a bunch of hacky nonsense
// to get types that agree with the actual interfaces present in the window
type DocumentFactory<T, Store extends StoreOption = false> = (
  options: IndexOptionsForDocumentSearch<T, Store>
) => FFlexSearch.Document<unknown, false>;

const index = (FlexSearch.Document as DocumentFactory<unknown, false>)({
  document: {
    id: 'id',
    index: ['text', 'name', 'aliases'],
    tag: 'maps',
  },
  tokenize: 'forward',
});

// FlexSearch's ability to return the document we gave it sucks. Instead,
// we'll just use its core behavior of returning an ID and dereference
// that from the list of all overlays.
const overlays: Map<FlexSearchId, TargetOfInterest> = new Map();

for (const [type, overlayDatas] of getAllOverlays()) {
  for (const [idx, data] of overlayDatas.entries()) {
    // Since we want to be able to search all kinds of things, we need to namespace
    // the array index (id) by its overlay type to keep everything unique
    const id = `${type}:${idx}`;
    overlays.set(id, data);
    index.add({
      id,
      ...data,
    });
  }
}

export const searchOverlays = (mapName: MapName, query: string): TargetOfInterest[] => {
  // do the search
  const found = index.search(query, { tag: mapName }).flatMap(v => v.result);
  // deduplicate the ids we get back
  const ids = new Set<FlexSearchId>(found);
  // turn the ids back into TargetOfInterest objects
  return [...ids.values()].flatMap(key => (overlays.has(key) ? [overlays.get(key)!] : []));
};
