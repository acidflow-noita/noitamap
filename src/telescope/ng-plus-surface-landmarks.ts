import { getDataZip } from '../data-archive';
import { decodePngToRgba } from './png-decode';
import type { StaticTerrainMask } from './static-terrain-mask';

export interface NGPlusSurfaceLandmarkMask extends StaticTerrainMask {
  /** Grayscale scene cells resolve through the new biome's density-1 material bands. */
  densityBits?: Uint8Array;
}

// Fixed placements in _pixel_scenes_newgame_plus.xml that intersect replaced
// Hills cells at ground level. The game's _mountain_lake.bat places this
// complete material PNG at (2560, 0). Both placements are absolute in Noita.
const landmarks = [
  { x: -6948, y: -270, material: 'overworld/essence_altar', visual: 'overworld/essence_altar_visual' },
  { x: 2560, y: 0, material: 'spliced/mountain_lake' },
];

let ready: Promise<NGPlusSurfaceLandmarkMask[]> | undefined;

async function readMasks(): Promise<NGPlusSurfaceLandmarkMask[]> {
  const archive = await getDataZip();
  if (!archive) throw new Error('NG+ surface landmark archive unavailable');
  const read = async (name: string) => {
    const file = archive.file('data/biome_impl/' + name + '.png');
    if (!file) throw new Error('Missing NG+ surface landmark ' + name);
    return decodePngToRgba(await file.async('arraybuffer'));
  };
  return Promise.all(landmarks.map(async ({ x, y, material, visual }) => {
    const [scene, art] = await Promise.all([read(material), visual && read(visual)]);
    const { width, height, data } = scene;
    if (art && (art.width !== width || art.height !== height)) throw new Error('Mismatched NG+ landmark artwork ' + visual);
    const bits = new Uint8Array(Math.ceil(width * height / 8));
    let densityBits: Uint8Array | undefined;
    for (let p = 0; p < width * height; p++) {
      const i = p * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
      // Visible artwork, explicit materials and force-air keep the capture.
      // Unpainted cells leave room for the replacement surface. Positive gray
      // shades all select the same density class as scene-material-grid.ts.
      if ((art && art.data[i + 3]) || (a && (r !== g || g !== b))) {
        bits[p >> 3] |= 1 << (p & 7);
      } else if (a && r) {
        densityBits ??= new Uint8Array(bits.length);
        densityBits[p >> 3] |= 1 << (p & 7);
      }
    }
    return { x, y, width, height, bits, densityBits };
  }));
}

export function loadNGPlusSurfaceLandmarkMasks(): Promise<NGPlusSurfaceLandmarkMask[]> {
  return ready ??= readMasks().catch(error => { ready = undefined; throw error; });
}
