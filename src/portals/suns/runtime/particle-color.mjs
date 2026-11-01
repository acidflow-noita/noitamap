// Presentation-only recolor settings shared by both pages, both workers and
// the headless tests. Colors travel as "#rrggbb" strings or null (original).
// The presets are the drawing-sidebar swatches from noitamap-pro.
export const COLOR_PALETTE = Object.freeze([
  "#ffffff",
  "#ef4444",
  "#f97316",
  "#eab308",
  "#22c55e",
  "#06b6d4",
  "#3b82f6",
  "#8b5cf6",
]);

export function validateColor(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !/^#[0-9a-f]{6}$/i.test(value))
    throw new RangeError("Invalid color; expected #rrggbb or null");
  return value.toLowerCase();
}

export function packColor(value) {
  const hex = validateColor(value);
  return hex === null ? null : parseInt(hex.slice(1), 16);
}
