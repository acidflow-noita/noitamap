/**
 * Shared drawing constants
 *
 * Single source of truth for color palette, stroke widths, and type codes.
 */

// Color palette (3 bits, 8 colors) - order matters for binary encoding
export const COLOR_PALETTE = [
  '#ffffff', // 0 - white
  '#ef4444', // 1 - red
  '#f97316', // 2 - orange
  '#eab308', // 3 - yellow
  '#22c55e', // 4 - green
  '#06b6d4', // 5 - cyan
  '#3b82f6', // 6 - blue
  '#8b5cf6', // 7 - violet
] as const;

export type PaletteColor = (typeof COLOR_PALETTE)[number];

// Color name i18n keys (same order as COLOR_PALETTE)
export const COLOR_NAME_KEYS = [
  'drawing.color.white',
  'drawing.color.red',
  'drawing.color.orange',
  'drawing.color.yellow',
  'drawing.color.green',
  'drawing.color.cyan',
  'drawing.color.blue',
  'drawing.color.violet',
] as const;

// Reverse lookup: hex → palette index
export const COLOR_TO_INDEX: Record<string, number> = Object.fromEntries(
  COLOR_PALETTE.map((c, i) => [c.toLowerCase(), i])
);

// Stroke width palette (2 bits) - order matters for binary encoding
export const STROKE_WIDTHS = [2, 5, 10, 15] as const; // thin, normal, thick, heavy

// Type codes (4 bits) - order matters for binary encoding
export const TYPE_CODES: Record<string, number> = {
  point: 0,
  circle: 1,
  line: 2,
  arrow_line: 3,
  rect: 4,
  ellipse: 5,
  path: 6,
  closed_path: 7,
  polygon: 8,
  text: 9,
};

export const CODE_TO_TYPE: Record<number, string> = Object.fromEntries(
  Object.entries(TYPE_CODES).map(([k, v]) => [v, k])
);
