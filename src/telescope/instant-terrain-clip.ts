import Flatbush from "flatbush";
import { WORLD_TOP, WORLD_HEIGHT, type TerrainOwnership } from "./terrain-policy";
import type { StaticTerrainMask } from "./static-terrain-mask";

export interface InstantClipView {
  x: number;
  y: number;
  scale: number;
  width: number;
  height: number;
}

const MASK_PAGE_SIZE = 256;
const MASK_CACHE_BYTES = 32 * 1024 * 1024;

/** Preserve the existing static-map ownership and the exact authored scene
 * material/force-air masks. Empty PNG pixels do not erase a rectangular room. */
export function createInstantClip(
  owners: Pick<TerrainOwnership, 'width' | 'owners'>[],
  masks: StaticTerrainMask[],
) {
  const index = masks.length ? new Flatbush(masks.length) : null;
  for (const mask of masks)
    index!.add(mask.x, mask.y, mask.x + mask.width, mask.y + mask.height);
  index?.finish();
  const bitmaps = new Map<string, HTMLCanvasElement>();
  const identities = new WeakMap<Uint8Array, number>();
  let nextIdentity = 0;
  const identity = (bits: Uint8Array | undefined) => {
    if (!bits) return 0;
    let id = identities.get(bits);
    if (id === undefined) identities.set(bits, id = ++nextIdentity);
    return id;
  };
  let bytes = 0;
  const bitmap = (mask: StaticTerrainMask, x = 0, y = 0,
    width = mask.width, height = mask.height) => {
    const key = `${identity(mask.bits)}/${identity(mask.airBits)}/${mask.width}/${mask.height}/${x}/${y}/${width}/${height}`;
    let canvas = bitmaps.get(key);
    if (canvas) {
      bitmaps.delete(key);
      bitmaps.set(key, canvas);
      return canvas;
    }
    canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d")!;
    const image = ctx.createImageData(width, height);
    for (let row = 0; row < height; row++)
      for (let column = 0; column < width; column++) {
        const source = (y + row) * mask.width + x + column;
        if (((mask.bits[source >> 3] ?? 0) | (mask.airBits?.[source >> 3] ?? 0)) & (1 << (source & 7)))
          image.data[(row * width + column) * 4 + 3] = 255;
      }
    ctx.putImageData(image, 0, 0);
    bitmaps.set(key, canvas);
    bytes += width * height * 4;
    while (bytes > MASK_CACHE_BYTES && bitmaps.size > 1) {
      const [key, old] = bitmaps.entries().next().value!;
      bytes -= old.width * old.height * 4;
      bitmaps.delete(key);
      old.width = old.height = 0;
    }
    return canvas;
  };
  return {
    hasTerrain(view: InstantClipView) {
      for (let p = 0; p < owners.length; p++) {
        const owner = owners[p], planeY = WORLD_TOP + (p - 1) * WORLD_HEIGHT;
        const cy0 = Math.max(0, Math.floor((view.y - planeY) / 512));
        const cy1 = Math.min(47, Math.ceil((view.y + view.height * view.scale - planeY) / 512) - 1);
        const cx0 = Math.floor((view.x + owner.width * 256) / 512);
        const cx1 = Math.ceil((view.x + view.width * view.scale + owner.width * 256) / 512) - 1;
        for (let cy = cy0; cy <= cy1; cy++)
          for (let cx = cx0; cx <= cx1; cx++)
            if (owner.owners[cy * owner.width + ((cx % owner.width) + owner.width) % owner.width] >= 0)
              return true;
      }
      return false;
    },
    draw(
      ctx: CanvasRenderingContext2D,
      image: CanvasImageSource,
      view: InstantClipView,
    ) {
      const { x, y, scale, width, height } = view;
      ctx.save();
      ctx.beginPath();
      for (let p = 0; p < owners.length; p++) {
        const owner = owners[p],
          planeY = WORLD_TOP + (p - 1) * WORLD_HEIGHT;
        const cy0 = Math.max(0, Math.floor((y - planeY) / 512));
        const cy1 = Math.min(
          47,
          Math.ceil((y + height * scale - planeY) / 512) - 1,
        );
        const cx0 = Math.floor((x + owner.width * 256) / 512);
        const cx1 = Math.ceil((x + width * scale + owner.width * 256) / 512) - 1;
        for (let cy = cy0; cy <= cy1; cy++) {
          let start = -Infinity;
          for (let cx = cx0; cx <= cx1 + 1; cx++) {
            const localX = ((cx % owner.width) + owner.width) % owner.width;
            const owns =
              cx <= cx1 && owner.owners[cy * owner.width + localX] >= 0;
            if (owns && start === -Infinity) start = cx;
            if (!owns && start !== -Infinity) {
              ctx.rect(
                (start * 512 - owner.width * 256 - x) / scale,
                (planeY + cy * 512 - y) / scale,
                ((cx - start) * 512) / scale,
                512 / scale,
              );
              start = -Infinity;
            }
          }
        }
      }
      ctx.clip();
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(image, 0, 0);
      ctx.restore();
      ctx.save();
      ctx.globalCompositeOperation = "destination-out";
      ctx.imageSmoothingEnabled = false;
      for (const id of index?.search(
        x,
        y,
        x + width * scale,
        y + height * scale,
      ) ?? []) {
        const mask = masks[id];
        // Native cooking touches at most 512px at a time. Expanding a complete
        // scene here used to allocate tens of MiB and scan millions of pixels
        // for a single leaf, repeatedly evicting the other large scene masks.
        // Fixed pages share work between neighbouring leaves and placements.
        if (scale === 1 && width <= 512 && height <= 512) {
          const left = Math.max(0, x - mask.x), top = Math.max(0, y - mask.y);
          const right = Math.min(mask.width, x + width - mask.x);
          const bottom = Math.min(mask.height, y + height - mask.y);
          const dx = mask.x - x, dy = mask.y - y;
          if (right <= left || bottom <= top) continue;
          if (!Number.isInteger(dx) || !Number.isInteger(dy)) {
            // Fractional destination-out draws blend their outer edges. One
            // tight crop preserves that coverage without introducing internal
            // page seams. A native request needs at most 513x513 source pixels.
            const cropX = Math.floor(left), cropY = Math.floor(top);
            ctx.drawImage(bitmap(mask, cropX, cropY, Math.ceil(right) - cropX, Math.ceil(bottom) - cropY),
              dx + cropX, dy + cropY);
            continue;
          }
          for (let py = Math.floor(top / MASK_PAGE_SIZE) * MASK_PAGE_SIZE; py < bottom; py += MASK_PAGE_SIZE)
            for (let px = Math.floor(left / MASK_PAGE_SIZE) * MASK_PAGE_SIZE; px < right; px += MASK_PAGE_SIZE) {
              const page = bitmap(mask, px, py,
                Math.min(MASK_PAGE_SIZE, mask.width - px), Math.min(MASK_PAGE_SIZE, mask.height - py));
              ctx.drawImage(page, dx + px, dy + py);
            }
          continue;
        }
        ctx.drawImage(
          bitmap(mask),
          (mask.x - x) / scale,
          (mask.y - y) / scale,
          mask.width / scale,
          mask.height / scale,
        );
      }
      ctx.restore();
    },
    dispose() {
      for (const canvas of bitmaps.values()) canvas.width = canvas.height = 0;
      bitmaps.clear();
      bytes = 0;
    },
  };
}
