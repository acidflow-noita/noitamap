export interface CachedTileLayer {
  biomeName: string;
  isFill?: boolean;
  correctedX: number;
  correctedY: number;
  w: number;
  h: number;
  buffer: ArrayBuffer | null;
  width: number;
  height: number;
  mapH: number;
  minX: number;
  minY: number;
  validChunks?: string[];
  chunkBasePos?: { x: number; y: number };
}

/** Preserve region ownership: without it a cached wang region becomes a static rectangle. */
export function serializeTileLayer(layer: any): CachedTileLayer {
  return {
    biomeName: layer.biomeName || "",
    isFill: layer.isFill,
    correctedX: layer.correctedX,
    correctedY: layer.correctedY,
    w: layer.w,
    h: layer.h,
    buffer: layer.buffer
      ? layer.buffer.buffer.slice(
          layer.buffer.byteOffset,
          layer.buffer.byteOffset + layer.buffer.byteLength,
        )
      : null,
    width: layer.width,
    height: layer.height,
    mapH: layer.mapH,
    minX: layer.minX,
    minY: layer.minY,
    validChunks: layer.validChunks
      ? (Array.from(layer.validChunks) as string[])
      : undefined,
    chunkBasePos: layer.chunkBasePos,
  };
}

export function restoreTileLayer(layer: CachedTileLayer) {
  return {
    biomeName: layer.biomeName,
    isFill: layer.isFill,
    canvas: null,
    correctedX: layer.correctedX,
    correctedY: layer.correctedY,
    w: layer.w,
    h: layer.h,
    buffer: layer.buffer ? new Uint8Array(layer.buffer) : null,
    width: layer.width,
    height: layer.height,
    mapH: layer.mapH,
    minX: layer.minX,
    minY: layer.minY,
    validChunks: layer.validChunks ? new Set(layer.validChunks) : undefined,
    chunkBasePos: layer.chunkBasePos,
  };
}
