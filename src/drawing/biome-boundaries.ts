import biomeBoundariesData from '../data/biome_boundries_py.json';
import { PathOfInterest } from '../data_sources/overlays';


const BIOME_IMAGE_TOP_CHUNK = -14;
const BIOME_IMAGE_TOP_Y = BIOME_IMAGE_TOP_CHUNK * 512; // -7168

// X offset from DZI
const MAP_TOP_LEFT_X = -17920;
const CHUNK_SIZE = 512;

// Transform from svg_map_path (image pixel coordinates) to game coordinates
function transformMapPathToGameCoords(mapPath: string): string {
  const parts = mapPath.split(' ');
  let isX = true;
  
  return parts
    .map(part => {
      if (part === 'M' || part === 'L' || part === 'Z') {
        isX = true;
        return part;
      }
      const pixelCoord = Number(part);
      if (isX) {
        isX = false;
        // Convert image X pixel to game coordinate
        return pixelCoord * CHUNK_SIZE + MAP_TOP_LEFT_X;
      } else {
        isX = true;
        // Convert image Y pixel to game coordinate (top aligns with chunk -14)
        return pixelCoord * CHUNK_SIZE + BIOME_IMAGE_TOP_Y;
      }
    })
    .join(' ');
}

export const biomeBoundaries: PathOfInterest[] = biomeBoundariesData.biomes.map(biome => ({
  overlayType: 'path' as const,
  maps: ['regular-main-branch'],
  path: transformMapPathToGameCoords(biome.svg_map_path),
  color: biome.biome_color,
  text: biome.filename,
}));
