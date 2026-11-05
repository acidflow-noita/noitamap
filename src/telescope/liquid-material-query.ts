import type { VerticalPlane } from './terrain-policy';
export interface LiquidMaterialRect { x0: number; y0: number; w: number; h: number }

/** Reuse the warm terrain program's asynchronous material readback. This runs
 * once per nearby mask block, never per animation frame or at map startup. */
export function queryLiquidMaterials(renderer: any, resources: { setPlane(plane: VerticalPlane): void },
  rects: readonly LiquidMaterialRect[], plane: VerticalPlane): Promise<Uint8Array[] | null> {
  if (![-1, 0, 1].includes(plane) || !rects.length || rects.length > 2 || rects.some(rect =>
    ![rect.x0, rect.y0, rect.w, rect.h].every(Number.isSafeInteger) ||
    Math.abs(rect.x0) > 0x3fffffff || Math.abs(rect.y0) > 0x3fffffff || rect.w < 1 || rect.h < 1 || rect.w > 256 || rect.h > 256 ||
    rect.w !== rects[0].w || rect.h !== rects[0].h)) throw new Error('Invalid liquid material query');
  if (!renderer.engineReady || renderer.contextLost) return Promise.resolve(null);
  resources.setPlane(plane);
  const gl: WebGL2RenderingContext = renderer.gl;
  gl.useProgram(renderer.program);
  const uniform = gl.getUniformLocation(renderer.program, 'u_liquidMaskOut');
  if (uniform === null) return Promise.resolve(null);
  gl.uniform1i(uniform, 1);
  try { return renderer.resolveMaterialTiles(rects); }
  finally { gl.uniform1i(uniform, 0); }
}
