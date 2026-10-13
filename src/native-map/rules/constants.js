// Adapted into the owned Noitamap rules runtime. See NOTICE.txt for provenance.
export const CHUNK_SIZE = 512;
export const TILE_SIZE = 10;
export const BIOME_EDGE_NOISE_EXTENT = 42;
export const BIOME_EDGE_NOISE_PADDING_TILES = 4; //Math.ceil(BIOME_EDGE_NOISE_EXTENT / TILE_SIZE);
export const BIOME_EDGE_NOISE_PADDING_PIXELS = BIOME_EDGE_NOISE_PADDING_TILES * TILE_SIZE;
export const WORLD_CHUNK_CENTER_X = 35;
export const WORLD_CHUNK_CENTER_Y = 14;
export const WORLD_CHUNK_CENTER_X_NGP = 32;

export const TILE_SCALE_RATIO = CHUNK_SIZE / TILE_SIZE;
export const TIME_UNTIL_LOADING = 50; // ms to wait before showing loading overlay, to avoid flashing on fast operations
export const POI_RADIUS = 50;
export const DEFAULT_OFFSET_Y = 4;

export const TILE_OFFSET_X = 5;
export const TILE_OFFSET_Y = -13;

// Working, mostly
//export const TILE_OFFSET_X = 5;
//export const TILE_OFFSET_Y = -3;

export const VISUAL_TILE_OFFSET_X = -5;
export const VISUAL_TILE_OFFSET_Y = -5;

export const MIN_CAM_Z = 0.025;

export const SKY_EXTRA_HEIGHT = 5; // Just to remove the gap in between the worlds