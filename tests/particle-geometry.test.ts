import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GpuScene as PortalScene } from '../src/portals/runtime/gpu-scene.mjs';
import { stepParticle as stepPortal } from '../src/portals/runtime/portal-physics.mjs';
import { GpuScene as SunScene } from '../src/portals/suns/runtime/gpu-scene.mjs';
import { stepParticle as stepSun } from '../src/portals/suns/runtime/portal-physics.mjs';
import { PARTICLE_SHADERS as portalShaders } from '../src/portals/runtime/gpu-particle-shaders.mjs';
import { PARTICLE_SHADERS as sunShaders } from '../src/portals/suns/runtime/gpu-particle-shaders.mjs';
import { nativeSunGL } from './helpers/native-sun-gl.mjs';

let native: ReturnType<typeof nativeSunGL>;
let gl: WebGL2RenderingContext;
beforeAll(() => {
  native = nativeSunGL();
  gl = native.gl as unknown as WebGL2RenderingContext;
});
afterAll(() => native?.dispose());

// Read one real vertex from the production program before rasterization.
function readVertex(vertex: string, fragment: string, varying: string, configure: (program: WebGLProgram) => void) {
  const { program } = native.program(vertex, fragment, [], [varying]);
  gl.useProgram(program);
  configure(program);
  const result = new Float32Array(4);
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.TRANSFORM_FEEDBACK_BUFFER, buffer);
  gl.bufferData(gl.TRANSFORM_FEEDBACK_BUFFER, result.byteLength, gl.DYNAMIC_COPY);
  gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, buffer);
  gl.enable(gl.RASTERIZER_DISCARD);
  gl.beginTransformFeedback(gl.POINTS);
  gl.drawArrays(gl.POINTS, 0, 1);
  gl.endTransformFeedback();
  gl.disable(gl.RASTERIZER_DISCARD);
  gl.getBufferSubData(gl.TRANSFORM_FEEDBACK_BUFFER, 0, result);
  gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, null);
  gl.deleteBuffer(buffer);
  expect(gl.getError()).toBe(gl.NO_ERROR);
  return result;
}

// Native reference values from Dust 00dc4ed.
const trail = { x: -.9524089097976685, y: 1.1954476833343506, vx: 424.2105712890625, vy: -34.34992980957031,
  gx: 15, gy: 25, friction: .5697060823440552 };
const expectedEndpoint = [-.8888273239135742, 1.1902992725372314];
describe.each([
  { name: 'portals', step: stepPortal, Scene: PortalScene, shaders: portalShaders },
  { name: 'Suns', step: stepSun, Scene: SunScene, shaders: sunShaders },
])('$name particle geometry', ({ step, Scene, shaders }) => {
  it('matches the native endpoint and fractional point-glow origin in the GPU shaders', () => {
    const endpoint = readVertex(shaders.updateVertex, shaders.updateFragment, 'nextAppearance', () => {
      gl.vertexAttrib4f(0, trail.x, trail.y, trail.vx, trail.vy);
      gl.vertexAttrib4f(1, 0, 0, 1, 2);
      gl.vertexAttrib4f(2, trail.gx, trail.gy, trail.friction, 0);
      gl.vertexAttrib4f(5, 0, 0, 0, 0);
    });
    expect([endpoint[0], endpoint[1]]).toEqual(expectedEndpoint);

    const position = readVertex(shaders.drawVertex, shaders.updateFragment, 'gl_Position', program => {
      gl.vertexAttrib4f(0, -3.75, 7.625, 0, 0);
      gl.vertexAttrib4f(1, 0, 0, 1, 2);
      gl.vertexAttrib4f(5, 10, 0, 0, 0); // On-grid point with cosmetic glow.
      gl.uniform1i(gl.getUniformLocation(program, 'glowPass'), 1);
      gl.uniform2f(gl.getUniformLocation(program, 'origin'), 31.75, 40.375);
      // The portal shader has this view size built in. GLES ignores location -1.
      gl.uniform2f(gl.getUniformLocation(program, 'viewSize'), 480, 320);
    });
    expect((position[0] + 1) * 240).toBeCloseTo(16.75, 4);
    expect((1 - position[1]) * 160).toBeCloseTo(36.375, 4);
  });

  it('rounds travel to float32 before projecting the trail endpoint', () => {
    const particle = { ...trail, prevX: 0, prevY: 0, alpha: 1, fadeRate: 0, life: 2, airflowForce: 0, age: 0 };
    step(particle, 0);
    expect([particle.prevX, particle.prevY]).toEqual(expectedEndpoint);
  });

  it('adds the fractional camera origin after snapping the glow to the world grid', () => {
    const scene = new Scene({ assets: {} }, {});
    scene.width = 64;
    scene.height = 80;
    scene.build({ effect: 'test', x: .25, y: -.375, definition: { sprites: [] },
      particles: [{ x: -3.75, y: 7.625, life: 2, alpha: 1, onGrid: true, glow: true }],
    }, { core: false });
    expect([...scene.glow[0].data.subarray(0, 8)]).toEqual(
      [16.75, 36.375, 40.75, 36.375, 40.75, 60.375, 16.75, 60.375]);
  });
});
