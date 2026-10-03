/** OSD presents one completed frame. Native sources are private to the frame
 * renderer: the viewer cannot request their whole-world overview ancestors. */
declare const OpenSeadragon: any;

export interface TerrainRect { x: number; y: number; width: number; height: number }
export type TerrainFrameRenderer = (bounds: TerrainRect, scale: number, signal: AbortSignal) => Promise<HTMLCanvasElement>;
export interface TerrainRegion extends TerrainRect {
  /** CPU frames request visible native leaves, avoiding offscreen pyramid descendants. */
  nativeOnly?: boolean;
  source: {
    maxLevel: number;
    getFinalTile(level: number, x: number, y: number, signal: AbortSignal): Promise<HTMLCanvasElement>;
  };
}

export function visibleTerrainTiles(region: TerrainRegion, bounds: TerrainRect, pixelsPerWorld: number) {
  const left = Math.max(region.x, bounds.x), top = Math.max(region.y, bounds.y);
  const right = Math.min(region.x + region.width, bounds.x + bounds.width);
  const bottom = Math.min(region.y + region.height, bounds.y + bounds.height);
  if (left >= right || top >= bottom) return [];
  if (!(pixelsPerWorld > 0) || !Number.isFinite(pixelsPerWorld)) throw new Error("Invalid terrain viewport scale");
  // Never select a source with fewer pixels than the screen. Every reduced
  // source is made from final native pixels, with all composition passes on.
  const reduction = region.nativeOnly ? 0 : Math.min(region.source.maxLevel, Math.max(0, Math.floor(Math.log2(1 / pixelsPerWorld))));
  const level = region.source.maxLevel - reduction, scale = 2 ** reduction;
  const span = 512 * scale;
  const tiles = [];
  for (let y = Math.floor((top - region.y) / span); y < Math.ceil((bottom - region.y) / span); y++)
    for (let x = Math.floor((left - region.x) / span); x < Math.ceil((right - region.x) / span); x++)
      tiles.push({ region, level, x, y, scale, worldX: region.x + x * span, worldY: region.y + y * span });
  return tiles;
}

/** Coalesce camera changes; a cancelled or older frame can never be published. */
export class TerrainFrameController<View, Frame> {
  private current: AbortController | undefined;
  private disposed = false;
  constructor(
    private render: (view: View, signal: AbortSignal) => Promise<Frame>,
    private publish: (frame: Frame, view: View) => void,
    private error: (error: unknown) => void,
  ) {}
  async request(view: View): Promise<void> {
    if (this.disposed) return;
    this.current?.abort();
    const controller = this.current = new AbortController();
    try {
      const frame = await this.render(view, controller.signal);
      if (!controller.signal.aborted && !this.disposed) this.publish(frame, view);
    } catch (error) {
      if (!controller.signal.aborted && !this.disposed) this.error(error);
    }
  }
  dispose() { this.disposed = true; this.current?.abort(); }
}

export async function renderTerrainFrame(
  regions: TerrainRegion[], bounds: TerrainRect, pixelsPerWorld: number, signal: AbortSignal,
): Promise<HTMLCanvasElement> {
  signal.throwIfAborted();
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(bounds.width * pixelsPerWorld));
  canvas.height = Math.max(1, Math.ceil(bounds.height * pixelsPerWorld));
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingEnabled = true;
  const jobs = regions.flatMap(region => visibleTerrainTiles(region, bounds, pixelsPerWorld));
  const cx = bounds.x + bounds.width / 2, cy = bounds.y + bounds.height / 2;
  const distance = (t: typeof jobs[number]) => (t.worldX + 256 * t.scale - cx) ** 2 + (t.worldY + 256 * t.scale - cy) ** 2;
  jobs.sort((a, b) => distance(a) - distance(b));
  // Bounded fan-out; one frame owns only its visible source tiles, not all
  // lower OSD levels. Completed source data stays in the existing memory/IDB cache.
  await Promise.all(Array.from({ length: Math.min(4, jobs.length) }, async () => {
    while (jobs.length) {
      signal.throwIfAborted();
      const job = jobs.shift()!;
      const tile = await job.region.source.getFinalTile(job.level, job.x, job.y, signal);
      signal.throwIfAborted();
      const x = (job.worldX - bounds.x) * pixelsPerWorld;
      const y = (job.worldY - bounds.y) * pixelsPerWorld;
      ctx.drawImage(tile, x, y, tile.width * job.scale * pixelsPerWorld, tile.height * job.scale * pixelsPerWorld);
    }
  }));
  return canvas;
}

/** A frame remains attached to its world coordinates during animation. Replace
 * it only when the next complete image is loaded by OSD, below existing POIs. */
export function mountTerrainViewport(
  viewer: any, regions: TerrainRegion[] | TerrainFrameRenderer, isCurrent: () => boolean,
  onItem: (item: any, removed?: boolean) => void, firstPaint?: () => void,
) {
  const osd = viewer.viewer || viewer;
  let item: any = null, staged: any = null, timer: ReturnType<typeof setTimeout> | undefined;
  let revision = 0, disposed = false, painted = false;
  const initialIndex = osd.world.getItemCount();
  type View = { bounds: TerrainRect; scale: number; revision: number };
  let cameraKey: string | undefined;
  let pendingView: View | undefined;
  const remove = (value: any) => {
    if (!value) return;
    if (osd.world.getIndexOfItem(value) >= 0) osd.world.removeItem(value);
    onItem(value, true);
  };
  const controller = new TerrainFrameController<View, HTMLCanvasElement>(
    ({ bounds, scale }, signal) => typeof regions === 'function'
      ? regions(bounds, scale, signal) : renderTerrainFrame(regions, bounds, scale, signal),
    (canvas, view) => {
      if (disposed || !isCurrent() || view.revision !== revision) return;
      remove(staged); staged = null;
      const source = new OpenSeadragon.TileSource({
        width: canvas.width, height: canvas.height,
        tileSize: Math.max(canvas.width, canvas.height), minLevel: 0, maxLevel: 0,
      });
      source.__glTerrain = true;
      const url = `terrain-frame://${view.revision}/${performance.now()}`;
      source.getTileUrl = () => url;
      source.hasTransparency = () => true;
      source.downloadTileStart = (context: any) => context.finish(canvas.getContext("2d"), null, "context2d");
      source.downloadTileAbort = () => {};
      const index = item ? osd.world.getIndexOfItem(item) : initialIndex;
      viewer.addTiledImage({
        tileSource: source, x: view.bounds.x, y: view.bounds.y, width: view.bounds.width,
        index: Math.max(0, index), blendTime: 0,
        success: ({ item: next }: any) => {
          if (disposed || !isCurrent() || view.revision !== revision) { remove(next); return; }
          staged = next;
          onItem(next);
          const commit = ({ fullyLoaded }: { fullyLoaded: boolean }) => {
            if (!fullyLoaded) return;
            next.removeHandler("fully-loaded-change", commit);
            if (disposed || !isCurrent() || view.revision !== revision) { remove(next); return; }
            remove(item); item = next; staged = null;
            if (!painted) { painted = true; firstPaint?.(); }
          };
          next.addHandler("fully-loaded-change", commit);
          if (next.getFullyLoaded()) commit({ fullyLoaded: true });
          osd.forceRedraw();
        },
      });
    },
    error => {
      console.error("[Full-pixel terrain] Viewport frame failed:", error);
      window.dispatchEvent(new CustomEvent("fullPixelTerrainError", { detail: { message: String(error) } }));
    },
  );
  const render = () => {
    timer = undefined;
    if (disposed || !isCurrent() || !pendingView) return;
    void controller.request(pendingView);
  };
  const changed = () => {
    if (disposed || !isCurrent()) return;
    const rect = osd.viewport.getBounds(true).getBoundingBox();
    const bounds = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    const size = osd.viewport.getContainerSize();
    const unrotated = osd.viewport.getBoundsNoRotate(true);
    const scale = size.x * (window.devicePixelRatio || 1) / unrotated.width;
    if (![bounds.x, bounds.y, bounds.width, bounds.height, scale].every(Number.isFinite) || bounds.width <= 0 || bounds.height <= 0 || scale <= 0) return;
    // OSD's animation event also covers TiledImage updates (new terrain,
    // markers, image bounds), not just camera movement. Invalidating on those
    // events made each frame cancel itself before fully-loaded-change fired.
    const key = [bounds.x, bounds.y, bounds.width, bounds.height, scale].join('/');
    if (key === cameraKey) return;
    cameraKey = key;
    revision++;
    pendingView = { bounds, scale, revision };
    if (timer !== undefined) clearTimeout(timer);
    // Retain the last complete frame while the camera moves. Coalesce rapid
    // zoom/pan events instead of launching a whole render on every spring tick.
    timer = setTimeout(render, 80);
  };
  const events = ["animation", "animation-finish", "resize"];
  for (const event of events) osd.addHandler(event, changed);
  const dispose = () => {
    disposed = true; revision++;
    if (timer !== undefined) clearTimeout(timer);
    controller.dispose();
    for (const event of events) osd.removeHandler(event, changed);
    window.removeEventListener("fullPixelTerrainReset", dispose);
    remove(staged); remove(item);
  };
  window.addEventListener("fullPixelTerrainReset", dispose);
  changed();
  return dispose;
}
