import { EFFECTS } from "./portal-physics.mjs";
import { MATH_EFFECTS, MATH_GROUPS } from "./math-figures.mjs";

export const TILE_WIDTH = 480;
export const TILE_HEIGHT = 320;

export function figureGroups(catalog) {
  const custom = Object.entries(catalog.effects).filter(([, effect]) => effect.imageEmitter);
  return [
    ...(custom.length
      ? [{ label: "Custom, Image emitter", entries: custom }]
      : []),
    { label: "Noita, Portals", entries: Object.entries(EFFECTS) },
    ...[
      ["objects", "Objects & ambient effects"],
      ["images", "Image-driven effects"],
    ].map(([group, label]) => ({
      label: `Noita, ${label}`,
      entries: Object.entries(catalog.effects).filter(
        ([, effect]) => effect.group === group,
      ),
    })),
    ...Object.entries(MATH_GROUPS).map(([group, label]) => ({
      label: `Math, ${label}`,
      entries: Object.entries(MATH_EFFECTS).filter(
        ([, effect]) => effect.group === group,
      ),
    })),
  ];
}

// Fit whole native-aspect previews; never crop or distort a figure to fill a cell.
export function fitGrid(count, width, height, showNames = true, columns = 0) {
  if (
    !Number.isInteger(count) ||
    count < 0 ||
    count > 256 ||
    !Number.isInteger(columns) || columns < 0 || columns > 256 ||
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 160 ||
    height < 120 ||
    width > 2048 ||
    height > 2048
  )
    throw new RangeError("Invalid grid size");
  if (!count) return { width, height, columns: 0, rows: 0, tiles: [] };
  const root = Math.ceil(Math.sqrt(count));
  const gap = Math.max(
    1,
    Math.min(12, Math.floor(Math.min(width, height) / (4 * root))),
  );
  const labelHeight = showNames ? Math.min(
    22,
    Math.floor(Math.min(width, height) / root / 3),
  ) : 0;
  let best;
  const fixedColumns = columns ? Math.min(columns, count) : 0;
  for (let columns = fixedColumns || 1; columns <= (fixedColumns || count); columns++) {
    const rows = Math.ceil(count / columns);
    const cellWidth = Math.floor((width - gap * (columns + 1)) / columns);
    const cellHeight =
      Math.floor((height - gap * (rows + 1)) / rows) - labelHeight;
    const scale = Math.min(cellWidth / TILE_WIDTH, cellHeight / TILE_HEIGHT);
    if (scale > 0 && (!best || scale > best.scale))
      best = { columns, rows, scale };
  }
  if (!best) throw new RangeError("Grid is too small");
  const tileWidth = Math.max(1, Math.floor(TILE_WIDTH * best.scale));
  const imageHeight = Math.max(1, Math.floor(TILE_HEIGHT * best.scale));
  const tileHeight = imageHeight + labelHeight;
  const top = Math.floor(
    (height - best.rows * tileHeight - (best.rows - 1) * gap) / 2,
  );
  const tiles = Array.from({ length: count }, (_, i) => {
    const row = Math.floor(i / best.columns);
    const inRow = Math.min(best.columns, count - row * best.columns);
    const left = Math.floor(
      (width - inRow * tileWidth - (inRow - 1) * gap) / 2,
    );
    return {
      x: left + (i % best.columns) * (tileWidth + gap),
      y: top + row * (tileHeight + gap),
      width: tileWidth,
      imageHeight,
      height: tileHeight,
      labelHeight,
    };
  });
  return { width, height, columns: best.columns, rows: best.rows, tiles };
}

// Which tile (image or label) contains a canvas point; -1 for gaps and margins.
export function tileAt(layout, x, y) {
  return layout.tiles.findIndex(
    (tile) =>
      x >= tile.x &&
      x < tile.x + tile.width &&
      y >= tile.y &&
      y < tile.y + tile.height,
  );
}

// Down/upscale only the finished image, not the simulation or glow calculation.
export function blitTile(source, target, targetWidth, tile, sourceWidth = TILE_WIDTH, sourceHeight = TILE_HEIGHT) {
  const crop = tile.crop ?? { x: 0, y: 0, width: sourceWidth, height: sourceHeight };
  for (let y = 0; y < tile.imageHeight; y++) {
    const sy = Math.min(
      sourceHeight - 1,
      Math.floor(crop.y + ((y + 0.5) * crop.height) / tile.imageHeight),
    );
    for (let x = 0; x < tile.width; x++) {
      const sx = Math.min(
        sourceWidth - 1,
        Math.floor(crop.x + ((x + 0.5) * crop.width) / tile.width),
      );
      const from = (sy * sourceWidth + sx) * 4;
      const to = ((tile.y + y) * targetWidth + tile.x + x) * 4;
      target[to] = source[from];
      target[to + 1] = source[from + 1];
      target[to + 2] = source[from + 2];
      target[to + 3] = source[from + 3];
    }
  }
}
