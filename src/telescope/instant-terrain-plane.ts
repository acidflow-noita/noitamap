import type { VerticalPlane } from './terrain-policy';

const locations = new WeakMap<object, { program: any; location: any }>();

/** Set after ensureResources and before drawing. The renderer's resource map
 * must be prepared for this plane; camera/noise coordinates remain absolute. */
export function setTerrainPlane(renderer: any, plane: VerticalPlane): void {
  if (plane !== -1 && plane !== 0 && plane !== 1) throw new Error('Invalid terrain plane');
  if (renderer.setPlane) { renderer.setPlane(plane); return; }
  const gl = renderer.gl;
  if (!gl || !renderer.program) throw new Error('Terrain renderer is not ready');
  let entry = locations.get(renderer);
  if (!entry || entry.program !== renderer.program) {
    const location = gl.getUniformLocation(renderer.program, 'u_verticalPlane');
    if (location === null || location === -1) throw new Error('Vertical terrain shader is unavailable');
    entry = { program: renderer.program, location };
    locations.set(renderer, entry);
  }
  gl.useProgram(entry.program);
  gl.uniform1i(entry.location, plane);
}
