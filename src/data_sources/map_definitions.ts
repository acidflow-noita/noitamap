import mapDefinitions from '../data/map_definitions.json';

import { assertMapName, MapName } from './tile_data';

export type Badge = {
  icon?: string;
  label: string;
  labelKey?: string;
  class: string | string[];
};

export type MapDefinition = {
  key: MapName;
  label: string;
  labelKey?: string;
  badges: Badge[];
  patchDate: string;
  seed: string;
  tileSets: ('middle' | 'left' | 'right')[];
};

export const getAllMapDefinitions = (): [mapName: MapName, definition: MapDefinition][] =>
  (mapDefinitions as MapDefinition[]).map(def => [assertMapName(def.key), def]);
