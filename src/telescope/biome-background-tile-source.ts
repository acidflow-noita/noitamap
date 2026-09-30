declare const OpenSeadragon: any;

export interface BiomeBackgroundRegion {
  /** Keep all subpaths in one nonzero-winding clip, including holes. */
  rings: Array<Array<{ x: number; y: number }>>;
  textureKey: string;
}

interface BiomeBackgroundTiles {
  regions: BiomeBackgroundRegion[];
  textures: Map<string, ImageBitmap>;
  originX: number;
  originY: number;
  width: number;
  height: number;
  phaseX: number;
  phaseY: number;
}

const TILE_SIZE = 256;
let nextSource = 0;

/** Repeat the original artwork in small tiles, cached and released by OSD.
 * Native-level pixels are original game pixels; no world-sized canvas needed. */
export function createBiomeBackgroundTiles(options: BiomeBackgroundTiles) {
  const { textures, originX, originY, width, height, phaseX, phaseY } = options;
  const maxLevel = Math.max(0, Math.ceil(Math.log2(Math.max(width, height))));
  const regions = options.regions.map(region => {
    const points = region.rings.flat();
    return {
      ...region,
      minX: Math.min(...points.map(p => p.x)), minY: Math.min(...points.map(p => p.y)),
      maxX: Math.max(...points.map(p => p.x)), maxY: Math.max(...points.map(p => p.y)),
    };
  });

  function render(level: number, x: number, y: number, worldOffsetX: number) {
    const scale = 2 ** (level - maxLevel);
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(Math.min(TILE_SIZE, width * scale - x * TILE_SIZE));
    canvas.height = Math.ceil(Math.min(TILE_SIZE, height * scale - y * TILE_SIZE));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Cannot render biome background tile');
    ctx.imageSmoothingEnabled = false;
    const left = originX + x * TILE_SIZE / scale, top = originY + y * TILE_SIZE / scale;
    const right = left + canvas.width / scale, bottom = top + canvas.height / scale;
    ctx.setTransform(scale, 0, 0, scale, -left * scale, -top * scale);
    for (const region of regions) {
      if (region.maxX <= left || region.maxY <= top || region.minX >= right || region.minY >= bottom) continue;
      const texture = textures.get(region.textureKey);
      if (!texture) continue;
      ctx.save();
      ctx.beginPath();
      for (const ring of region.rings) {
        if (ring.length < 3) continue;
        ctx.moveTo(ring[0].x, ring[0].y);
        for (let i = 1; i < ring.length; i++) ctx.lineTo(ring[i].x, ring[i].y);
        ctx.closePath();
      }
      ctx.clip('nonzero');
      // Texture phase follows absolute world coordinates, including PWs.
      const textureOriginX = phaseX - worldOffsetX;
      if (scale === 1) {
        // Direct 1:1 blits preserve authored pixels without pattern filtering.
        const startX = Math.floor((left - textureOriginX) / texture.width) * texture.width + textureOriginX;
        const startY = Math.floor((top - phaseY) / texture.height) * texture.height + phaseY;
        for (let ty = startY; ty < bottom; ty += texture.height)
          for (let tx = startX; tx < right; tx += texture.width) ctx.drawImage(texture, tx, ty);
      } else {
        // Coarse tiles may span an entire world. Repeating a pattern avoids
        // issuing millions of individual draws while zoomed out.
        const pattern = ctx.createPattern(texture, 'repeat');
        if (!pattern) throw new Error(`Cannot repeat biome background ${region.textureKey}`);
        ctx.translate(textureOriginX, phaseY);
        ctx.fillStyle = pattern;
        ctx.fillRect(left - textureOriginX, top - phaseY, right - left, bottom - top);
      }
      ctx.restore();
    }
    return canvas;
  }

  return {
    createSource(worldOffsetX = 0): any {
      const source = new OpenSeadragon.TileSource({ width, height, tileSize: TILE_SIZE, tileOverlap: 0, minLevel: 0, maxLevel });
      const id = ++nextSource;
      let destroyed = false;
      source.__biomeBg = true;
      source.hasTransparency = () => true;
      source.getTileUrl = (level: number, x: number, y: number) => `biome-background://${id}/${level}/${x}/${y}`;
      const tileExists = source.tileExists.bind(source);
      source.tileExists = (level: number, x: number, y: number) => !destroyed && tileExists(level, x, y);
      source.downloadTileStart = (context: any) => {
        const request = { aborted: false };
        context.userData = request;
        // ImageLoader must finish asynchronously so OSD records tile coverage.
        queueMicrotask(() => {
          if (request.aborted) return;
          const { level, x, y } = context.tile;
          if (!source.tileExists(level, x, y)) {
            context.fail('Biome background tile removed');
            return;
          }
          try { context.finish(render(level, x, y, worldOffsetX), null, 'image'); }
          catch (error) { context.fail(String(error)); }
        });
      };
      source.downloadTileAbort = (context: any) => { if (context.userData) context.userData.aborted = true; };
      // Original textures are shared across seeds; only OSD owns rendered tiles.
      source.destroy = () => { destroyed = true; };
      return source;
    },
  };
}
