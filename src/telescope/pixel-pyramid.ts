/** A genuine image pyramid: only leaves invoke the terrain shader, always at 1:1.
 * Parents are reduced from ALL their children, never point-sampled from the world.
 * Work is depth-first and the cache is bounded; no world-sized canvas is allocated.
 */
export interface PyramidTile {
  level: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PixelPyramidOptions<T> {
  width: number;
  height: number;
  tileSize: number;
  maxCachedTiles?: number;
  readTile?: (tile: PyramidTile) => Promise<T | null>;
  writeTile?: (tile: PyramidTile, image: T) => Promise<void>;
  onMissing?: (tile: PyramidTile) => void;
  /** Image-space focus, used to refine the visible area first. */
  focus?: () => { x: number; y: number };
  create: (tile: PyramidTile) => T;
  renderLeaf: (tile: PyramidTile, signal: AbortSignal) => Promise<T>;
  reduceChild: (
    parent: T,
    child: T,
    quadrantX: number,
    quadrantY: number,
  ) => void;
}

export class PixelPyramid<T> {
  readonly maxLevel: number;
  private cache = new Map<string, T>();

  constructor(private opts: PixelPyramidOptions<T>) {
    if (
      ![opts.width, opts.height, opts.tileSize].every(
        (n) => Number.isSafeInteger(n) && n > 0,
      )
    ) {
      throw new Error("Pyramid dimensions must be positive integers");
    }
    this.maxLevel = Math.ceil(Math.log2(Math.max(opts.width, opts.height)));
  }

  tile(level: number, x: number, y: number): PyramidTile | null {
    if (
      ![level, x, y].every(Number.isInteger) ||
      level < 0 ||
      level > this.maxLevel ||
      x < 0 ||
      y < 0
    )
      return null;
    const scale = 2 ** (this.maxLevel - level);
    const width = Math.min(
      this.opts.tileSize,
      Math.ceil(this.opts.width / scale) - x * this.opts.tileSize,
    );
    const height = Math.min(
      this.opts.tileSize,
      Math.ceil(this.opts.height / scale) - y * this.opts.tileSize,
    );
    return width > 0 && height > 0 ? { level, x, y, width, height } : null;
  }

  async get(
    level: number,
    x: number,
    y: number,
    signal: AbortSignal,
    onProgress?: (image: T, complete: boolean) => void,
  ): Promise<T> {
    signal.throwIfAborted();
    const tile = this.tile(level, x, y);
    if (!tile) throw new Error(`Tile outside pyramid: ${level}/${x}/${y}`);
    const key = `${level}/${x}/${y}`;
    if (this.cache.has(key)) {
      const cached = this.cache.get(key)!;
      this.cache.delete(key);
      this.cache.set(key, cached);
      onProgress?.(cached, true);
      return cached;
    }
    const stored = await this.opts.readTile?.(tile);
    signal.throwIfAborted();
    if (stored) {
      this.remember(key, stored);
      onProgress?.(stored, true);
      return stored;
    }
    this.opts.onMissing?.(tile);
    let result: T;
    if (level === this.maxLevel) {
      result = await this.opts.renderLeaf(tile, signal);
    } else {
      result = this.opts.create(tile);
      const children: { dx: number; dy: number; tile: PyramidTile }[] = [];
      for (let dy = 0; dy < 2; dy++)
        for (let dx = 0; dx < 2; dx++) {
          const child = this.tile(level + 1, x * 2 + dx, y * 2 + dy);
          if (child) children.push({ dx, dy, tile: child });
        }
      while (children.length) {
        const focus = this.opts.focus?.();
        if (focus) {
          const scale = 2 ** (this.maxLevel - level - 1);
          const distance = ({ tile: t }: (typeof children)[number]) => {
            const left = t.x * this.opts.tileSize * scale,
              top = t.y * this.opts.tileSize * scale;
            const dx = Math.max(
              left - focus.x,
              0,
              focus.x - left - t.width * scale,
            );
            const dy = Math.max(
              top - focus.y,
              0,
              focus.y - top - t.height * scale,
            );
            return dx * dx + dy * dy;
          };
          children.sort((a, b) => distance(a) - distance(b));
        }
        const child = children.shift()!;
        await this.get(
          level + 1,
          child.tile.x,
          child.tile.y,
          signal,
          (image) => {
            signal.throwIfAborted();
            // Replace this quadrant on EVERY update, including transparent pixels.
            // Publishing each completed leaf must not wait for its entire quadrant.
            this.opts.reduceChild(result, image, child.dx, child.dy);
            onProgress?.(result, false);
          },
        );
      }
    }
    signal.throwIfAborted();
    await this.opts.writeTile?.(tile, result);
    signal.throwIfAborted();
    this.remember(key, result);
    onProgress?.(result, true);
    return result;
  }

  private remember(key: string, image: T): void {
    this.cache.set(key, image);
    while (this.cache.size > (this.opts.maxCachedTiles ?? 32))
      this.cache.delete(this.cache.keys().next().value!);
  }

  /** Completed data only; previews/in-flight canvases must never masquerade as final pixels. */
  cachedTiles(): { tile: PyramidTile; image: T }[] {
    return [...this.cache]
      .map(([key, image]) => {
        const [level, x, y] = key.split("/").map(Number);
        return { tile: this.tile(level, x, y)!, image };
      })
      .sort((a, b) => a.tile.level - b.tile.level);
  }

  clear(): void {
    this.cache.clear();
  }
}
