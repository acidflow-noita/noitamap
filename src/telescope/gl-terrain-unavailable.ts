/**
 * Stand-in for the WebGL2 final-pixel terrain renderer when the resolved
 * telescope fork does not ship one.
 *
 * Only vitaminmoo's render-perf branch has js/gl/; the default Lymm37 fork does
 * not. A bare `import("noita-telescope/gl/terrain_renderer.js")` has a literal
 * specifier, so Vite resolves it while scanning and the whole build fails on the
 * fork without it — a runtime try/catch is too late to help.
 *
 * vite.config.ts therefore aliases "virtual:gl-terrain" to the real module when
 * the selected fork has it and to this file otherwise, mirroring how
 * virtual:noitamap-pro falls back to pro-unavailable.ts. Callers just check
 * whether GLTerrainRenderer came back undefined.
 */

export const GLTerrainRenderer = undefined;
