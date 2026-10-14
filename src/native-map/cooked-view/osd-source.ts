import { CookedMap } from "../cooked-pixels/map-decoder";
import { CookedTileService } from "./service";

declare const OpenSeadragon: any;

/** Site-compatible dynamic OSD source, backed exclusively by a completed map. */
export function createCookedTileSource(options: {
  map: CookedMap;
  id: string;
  tileSize?: number;
  overlap?: number;
}) {
  if (!options.id)
    throw new Error("A completed-map source identity is required");
  const service = new CookedTileService(options.map, options),
    map = options.map;
  const source = new OpenSeadragon.TileSource({
    width: map.width,
    height: map.height,
    tileSize: service.tileSize,
    tileOverlap: service.overlap,
    minLevel: 0,
    maxLevel: map.maxLevel,
  });
  let destroyed = false;
  const pending = new Set<(fail?: boolean) => void>();
  source.__cookedPixels = true;
  source.getTileUrl = (level: number, x: number, y: number) =>
    `cooked-pixels://${encodeURIComponent(options.id)}/${level}/${x}/${y}`;
  source.hasTransparency = () => true;
  source.tileExists = (level: number, x: number, y: number) =>
    !destroyed && service.exists({ level, x, y });
  source.downloadTileStart = (job: any) => {
    const previous = job.userData;
    previous?.abort?.();
    const callback = previous?.loaderCallback ?? job.callback;
    let settled = false;
    const retire = () => {
      settled = true;
      pending.delete(cancel);
    };
    const cancel = (fail = false) => {
      if (settled) return;
      retire();
      if (fail) job.fail("Completed map source was removed");
    };
    job.userData = { abort: () => cancel(), loaderCallback: callback };
    if (typeof callback === "function") {
      let delivered = false;
      job.callback = (...args: any[]) => {
        if (delivered) return;
        delivered = true;
        retire();
        callback.apply(job, args);
      };
    }
    pending.add(cancel);
    // OSD must finish creating its ImageJob before receiving even a cached image.
    void Promise.resolve()
      .then(() => {
        if (settled) return;
        if (destroyed) {
          cancel(true);
          return;
        }
        const tile = service.read(job.tile),
          canvas = document.createElement("canvas");
        canvas.width = tile.width;
        canvas.height = tile.height;
        const context = canvas.getContext("2d");
        if (!context)
          throw new Error("Cannot create the completed pixel tile canvas");
        const image = context.createImageData(tile.width, tile.height);
        image.data.set(tile.rgba);
        context.putImageData(image, 0, 0);
        context.imageSmoothingEnabled = false;
        retire();
        job.finish(context, null, "context2d");
      })
      .catch((error) => {
        if (settled) return;
        retire();
        job.fail(String(error));
      });
  };
  // ImageJob.abort performs its own failure callback.
  source.downloadTileAbort = (job: any) => job.userData?.abort?.();
  source.destroy = () => {
    if (destroyed) return;
    destroyed = true;
    for (const cancel of pending) cancel(true);
  };
  return {
    source,
    service,
    originX: map.manifest.origin.x,
    originY: map.manifest.origin.y,
    width: map.width,
    height: map.height,
  };
}
