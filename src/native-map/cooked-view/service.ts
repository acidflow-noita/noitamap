import { CookedMap } from "../cooked-pixels/map-decoder";

export interface TileAddress {
  readonly level: number;
  readonly x: number;
  readonly y: number;
}
export interface CookedTile extends TileAddress {
  readonly nativeLevel: number;
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8ClampedArray;
}

/** Worker-compatible final-byte service. No DOM, cache, seed or render callbacks. */
export class CookedTileService {
  readonly map: CookedMap;
  readonly tileSize: number;
  readonly overlap: number;
  constructor(
    map: CookedMap,
    options: { tileSize?: number; overlap?: number } = {},
  ) {
    if (!(map instanceof CookedMap) || map.ready !== true)
      throw new Error("A sealed complete CookedMap is required");
    this.map = map;
    this.tileSize = options.tileSize ?? 512;
    this.overlap = options.overlap ?? 2;
    if (
      !Number.isSafeInteger(this.tileSize) ||
      this.tileSize < 1 ||
      !Number.isSafeInteger(this.overlap) ||
      this.overlap < 0 ||
      this.overlap > this.tileSize
    )
      throw new RangeError("Invalid cooked tile dimensions");
    Object.freeze(this);
  }

  bounds({ level, x, y }: TileAddress): Omit<CookedTile, "rgba"> {
    if (
      ![level, x, y].every(Number.isSafeInteger) ||
      level < 0 ||
      level > this.map.maxLevel ||
      x < 0 ||
      y < 0
    )
      throw new RangeError("Invalid cooked tile address");
    const nativeLevel = this.map.maxLevel - level,
      size = this.map.levelSize(nativeLevel);
    if (
      x >= Math.ceil(size.width / this.tileSize) ||
      y >= Math.ceil(size.height / this.tileSize)
    )
      throw new RangeError("Cooked tile is outside the complete map");
    const left = Math.max(0, x * this.tileSize - this.overlap),
      top = Math.max(0, y * this.tileSize - this.overlap);
    const right = Math.min(size.width, (x + 1) * this.tileSize + this.overlap),
      bottom = Math.min(size.height, (y + 1) * this.tileSize + this.overlap);
    return {
      level,
      x,
      y,
      nativeLevel,
      left,
      top,
      width: right - left,
      height: bottom - top,
    };
  }

  exists(address: TileAddress): boolean {
    try {
      this.bounds(address);
      return true;
    } catch {
      return false;
    }
  }
  read(address: TileAddress): CookedTile {
    const tile = this.bounds(address);
    return {
      ...tile,
      rgba: this.map.readRect(
        tile.nativeLevel,
        tile.left,
        tile.top,
        tile.width,
        tile.height,
      ),
    };
  }

  /** The successful response's rgba.buffer can be transferred directly. */
  handleMessage(request: TileAddress & { id: number | string }) {
    try {
      return { id: request.id, ok: true as const, tile: this.read(request) };
    } catch (error) {
      return {
        id: request.id,
        ok: false as const,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
