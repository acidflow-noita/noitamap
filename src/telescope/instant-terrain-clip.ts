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
  const bitmaps = new Map<Uint8Array, HTMLCanvasElement>();
  let bytes = 0;
  const bitmap = (mask: StaticTerrainMask) => {
    let canvas = bitmaps.get(mask.bits);
    if (canvas) {
      bitmaps.delete(mask.bits);
      bitmaps.set(mask.bits, canvas);
      return canvas;
    }
    canvas = document.createElement("canvas");
    canvas.width = mask.width;
    canvas.height = mask.height;
    const ctx = canvas.getContext("2d")!;
    const image = ctx.createImageData(mask.width, mask.height);
    for (let p = 0; p < mask.width * mask.height; p++)
      if (
        ((mask.bits[p >> 3] ?? 0) | (mask.airBits?.[p >> 3] ?? 0)) &
        (1 << (p & 7))
      )
        image.data[p * 4 + 3] = 255;
    ctx.putImageData(image, 0, 0);
    bitmaps.set(mask.bits, canvas);
    bytes += mask.width * mask.height * 4;
    while (bytes > 32 * 1024 * 1024 && bitmaps.size > 1) {
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
