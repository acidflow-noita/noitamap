export interface CompressedSceneBitmap {
  blob: Blob;
  width: number;
  height: number;
}

type Entry = { bitmap: ImageBitmap; bytes: number };
export type SceneBitmapLoader = (key: string) => Promise<CompressedSceneBitmap | undefined>;

/** Compressed scene artwork is cheap to retain; decoded full-world artwork is
 * not. Tile draws lease a cropped bitmap at the tile's required density. A
 * serial decode/draw queue bounds both decode peaks and ownership, even when
 * OSD requests several coarse tiles simultaneously. Native detail is never
 * downsampled: close views decode only their intersecting original pixels. */
export function createSceneBitmapProvider(
  scenes: Map<string, CompressedSceneBitmap>,
  maxBytes: number,
  loadBitmap?: SceneBitmapLoader,
) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 4)
    throw new RangeError('Scene bitmap budget must hold at least one pixel');
  const cache = new Map<string, Entry>();
  let bytes = 0, peakBytes = 0, decodes = 0, hits = 0, evictions = 0;
  let loads = 0, loading = 0, pendingDraws = 0;
  let destroyed = false;
  let queue = Promise.resolve();
  const remove = (key: string) => {
    const entry = cache.get(key);
    if (!entry) return;
    cache.delete(key);
    bytes -= entry.bytes;
    entry.bitmap.close();
  };
  const check = (cancelled: () => boolean) => {
    if (destroyed || cancelled()) throw new DOMException('Scene bitmap cancelled', 'AbortError');
  };
  return {
    get stats() { return { bytes, peakBytes, maxBytes, entries: cache.size, decodes, hits, evictions,
      loads, loading, pendingDraws, loadedScenes: scenes.size }; },
    draw(key: string, context: CanvasRenderingContext2D,
      dx: number, dy: number, dw: number, dh: number, cancelled: () => boolean = () => false): Promise<void> {
      if (dw <= 0 || dh <= 0) return Promise.resolve();
      pendingDraws++;
      const job = queue.then(async () => {
        check(cancelled);
        let scene = scenes.get(key);
        if (!scene && loadBitmap) {
          // Admission belongs inside the decode/draw queue. Merely asking for
          // many overview tiles must not decode thousands of raw scene PNGs or
          // schedule their native material work simultaneously.
          loads++; loading++;
          try { scene = await loadBitmap(key); } finally { loading--; }
          check(() => false);
          if (scene) scenes.set(key, scene);
          check(cancelled);
        }
        if (!scene) return;
        const rx = dw / scene.width, ry = dh / scene.height;
        const sx = Math.max(0, Math.floor(-dx / rx));
        const sy = Math.max(0, Math.floor(-dy / ry));
        const right = Math.min(scene.width, Math.ceil((context.canvas.width - dx) / rx));
        const bottom = Math.min(scene.height, Math.ceil((context.canvas.height - dy) / ry));
        const sw = right - sx, sh = bottom - sy;
        if (sw <= 0 || sh <= 0) return;
        // Keep original pixels whenever the crop fits. Besides reuse across
        // zoom levels, this avoids double nearest-neighbour sampling of artwork.
        const needsReducedBitmap = sw * sh * 4 > maxBytes;
        let width = needsReducedBitmap ? Math.max(1, Math.ceil(sw * Math.min(1, rx))) : sw;
        let height = needsReducedBitmap ? Math.max(1, Math.ceil(sh * Math.min(1, ry))) : sh;
        // Normally at most a tile plus rounding. Keep custom small budgets safe
        // as well; this limits presentation density, never persistent native data.
        if (width * height * 4 > maxBytes) {
          const ratio = Math.sqrt(maxBytes / (width * height * 4));
          width = Math.max(1, Math.floor(width * ratio));
          height = Math.max(1, Math.floor(height * ratio));
          while (width * height * 4 > maxBytes) {
            if (width >= height) width--; else height--;
          }
        }
        // Unscaled source pixels are identical regardless of how their next
        // draw is filtered. Share that decoded crop across zoom changes.
        const quality = width === sw && height === sh || !context.imageSmoothingEnabled ? 'pixelated' : 'high';
        const requestKey = JSON.stringify([key, sx, sy, sw, sh, width, height, quality]);
        let entry = cache.get(requestKey);
        if (entry) {
          hits++;
          cache.delete(requestKey); cache.set(requestKey, entry);
        } else {
          const expectedBytes = width * height * 4;
          // Evict before decode. No untracked transient full bitmap can sit
          // beside a full cache while browser/GC waits to reclaim old images.
          while (bytes + expectedBytes > maxBytes) {
            remove(cache.keys().next().value!); evictions++;
          }
          const bitmap = await createImageBitmap(scene.blob, sx, sy, sw, sh,
            { resizeWidth: width, resizeHeight: height, resizeQuality: quality });
          decodes++;
          try {
            check(cancelled);
            const size = bitmap.width * bitmap.height * 4;
            if (size !== expectedBytes) throw new Error('Scene bitmap decoder ignored requested dimensions');
            entry = { bitmap, bytes: size };
            cache.set(requestKey, entry); bytes += size;
            peakBytes = Math.max(peakBytes, bytes);
          } catch (error) { bitmap.close(); throw error; }
        }
        context.drawImage(entry.bitmap, 0, 0, width, height,
          dx + sx * rx, dy + sy * ry, sw * rx, sh * ry);
      }).finally(() => { pendingDraws--; });
      queue = job.catch(() => {});
      return job;
    },
    dispose() {
      if (destroyed) return;
      destroyed = true;
      for (const key of cache.keys()) remove(key);
      scenes.clear();
    },
  };
}
