import type { TerrainViewportInputs, TerrainViewportPlan } from './terrain-viewport-compositor';
import { terrainViewportStrips } from './terrain-viewport-compositor';
import { WORLD_HEIGHT, WORLD_TOP } from './terrain-policy';
import { createGenerationCheckpoint } from './generation-task';

/** One immutable integer texture holds ownership, spatial lists, scene rectangles
 * and packed material/air bits. No RGBA scene expansion occurs during navigation. */
export async function packViewportClipping(inputs: TerrainViewportInputs,
  bounds: { x: number; y: number; width: number; height: number }, signal: AbortSignal) {
  const checkpoint = createGenerationCheckpoint(signal);
  const center = inputs.center * 512;
  const left = Math.floor((Math.min(bounds.x, ...inputs.masks.map(m => m.x)) + center) / 512) * 512 - center;
  const top = Math.floor((Math.min(bounds.y, ...inputs.masks.map(m => m.y)) - WORLD_TOP) / 512) * 512 + WORLD_TOP;
  const right = Math.max(bounds.x + bounds.width, ...inputs.masks.map(m => m.x + m.width));
  const bottom = Math.max(bounds.y + bounds.height, ...inputs.masks.map(m => m.y + m.height));
  const columns = Math.ceil((right - left) / 512), rows = Math.ceil((bottom - top) / 512);
  if (columns * rows > 1_000_000) throw new Error('Terrain clipping grid exceeds its allocation limit');
  const lists: number[][] = Array.from({ length: columns * rows }, () => []);
  const bitPlanes: Uint32Array[] = [], offsets: number[] = [];
  const known = new Map<Uint8Array, Map<Uint8Array | undefined, number>>();
  let bitWords = 0;
  for (let id = 0; id < inputs.masks.length; id++) {
    const pending = checkpoint(); if (pending) await pending;
    const mask = inputs.masks[id];
    let pairs = known.get(mask.bits);
    if (!pairs) known.set(mask.bits, pairs = new Map());
    let offset = pairs.get(mask.airBits);
    if (offset === undefined) {
      offset = bitWords;
      const words = new Uint32Array(Math.ceil(Math.max(mask.bits.length, mask.airBits?.length ?? 0) / 4));
      for (let j = 0; j < words.length; j++) {
        if (j % 16384 === 0) { const pause = checkpoint(); if (pause) await pause; }
        for (let b = 0; b < 4; b++) words[j] |= ((mask.bits[j * 4 + b] ?? 0) | (mask.airBits?.[j * 4 + b] ?? 0)) << (b * 8);
      }
      bitPlanes.push(words); pairs.set(mask.airBits, offset); bitWords += words.length;
    }
    offsets.push(offset);
    for (let y = Math.max(0, Math.floor((mask.y - top) / 512)); y < Math.min(rows, Math.ceil((mask.y + mask.height - top) / 512)); y++)
      for (let x = Math.max(0, Math.floor((mask.x - left) / 512)); x < Math.min(columns, Math.ceil((mask.x + mask.width - left) / 512)); x++)
        lists[y * columns + x].push(id);
  }
  const records = columns * rows * 4, bits = records + inputs.masks.length * 8;
  const listStart = bits + bitWords;
  const data = new Uint32Array(listStart + lists.reduce((sum, list) => sum + list.length, 0));
  const floats = new Float32Array(data.buffer);
  let cursor = listStart;
  for (let y = 0; y < rows; y++) {
    const pause = checkpoint(); if (pause) await pause;
    for (let x = 0; x < columns; x++) {
      const i = y * columns + x, worldY = top + y * 512;
      const plane = Math.floor((worldY - WORLD_TOP) / WORLD_HEIGHT);
      const owner = inputs.owners[plane + 1];
      const cy = Math.floor((worldY - WORLD_TOP - plane * WORLD_HEIGHT) / 512);
      const cx = owner ? ((Math.floor((left + x * 512 + owner.width * 256) / 512) % owner.width) + owner.width) % owner.width : 0;
      data[i * 4] = owner && owner.owners[cy * owner.width + cx] >= 0 ? 1 : 0;
      data[i * 4 + 1] = cursor; data[i * 4 + 2] = lists[i].length;
      for (const id of lists[i]) data[cursor++] = records + id * 8;
    }
  }
  inputs.masks.forEach((mask, i) => {
    const offset = records + i * 8;
    floats[offset] = mask.x; floats[offset + 1] = mask.y;
    data[offset + 2] = mask.width; data[offset + 3] = mask.height;
    data[offset + 4] = bits + offsets[i];
    data[offset + 5] = Math.ceil(Math.max(mask.bits.length, mask.airBits?.length ?? 0) / 4);
  });
  cursor = bits;
  for (const plane of bitPlanes) { data.set(plane, cursor); cursor += plane.length; }
  return { data, left, top, columns, rows };
}

const vertex = `#version 300 es
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;
const fragment = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
uniform sampler2D u_color;
uniform usampler2D u_data;
uniform int u_dataWidth;
uniform ivec2 u_gridSize;
uniform ivec2 u_gridOrigin;
uniform ivec2 u_originInt;
uniform vec2 u_originFrac;
uniform vec2 u_size;
uniform float u_scale;
out vec4 color;
uint word(int index) {
  int texel = index / 4;
  return texelFetch(u_data, ivec2(texel % u_dataWidth, texel / u_dataWidth), 0)[index % 4];
}
void main() {
  vec2 pixel = vec2(gl_FragCoord.x, u_size.y - gl_FragCoord.y);
  vec2 world = u_originFrac + pixel * u_scale;
  ivec2 delta = u_originInt + ivec2(floor(world)) - u_gridOrigin;
  ivec2 cell = delta / 512;
  color = vec4(0.0);
  if (any(lessThan(delta, ivec2(0))) || any(greaterThanEqual(cell, u_gridSize))) return;
  if (word((cell.y * u_gridSize.x + cell.x) * 4) == 0u) return;
  color = texelFetch(u_color, ivec2(gl_FragCoord.xy), 0);
  vec2 halfPixel = vec2(u_scale * 0.5);
  ivec2 lo = max(ivec2(0), (u_originInt + ivec2(floor(world - halfPixel)) - u_gridOrigin) / 512);
  ivec2 hi = min(u_gridSize - 1, (u_originInt + ivec2(floor(world + halfPixel)) - u_gridOrigin) / 512);
  for (int y = lo.y; y <= hi.y; y++) for (int x = lo.x; x <= hi.x; x++) {
    int entry = (y * u_gridSize.x + x) * 4;
    int start = int(word(entry + 1)), count = int(word(entry + 2));
    for (int n = 0; n < count; n++) {
      int meta = int(word(start + n));
      vec2 at = vec2(uintBitsToFloat(word(meta)), uintBitsToFloat(word(meta + 1))) - vec2(u_originInt);
      ivec2 size = ivec2(word(meta + 2), word(meta + 3));
      vec2 overlap = max(vec2(0.0), min(world + halfPixel, at + vec2(size)) - max(world - halfPixel, at));
      if (overlap.x == 0.0 || overlap.y == 0.0) continue;
      // A scene spanning several bins is visited only at its nearest bin.
      ivec2 nearest = (u_originInt + ivec2(floor(clamp(world, at, at + vec2(size) - 0.001))) - u_gridOrigin) / 512;
      if (nearest != ivec2(x, y)) continue;
      vec2 source = world - at;
      if (any(lessThan(source, vec2(0.0))) || any(greaterThan(source, vec2(size)))) continue;
      // Canvas nearest sampling chooses the lower pixel at exact ties.
      ivec2 sampleAt = ivec2(ceil(source)) - 1;
      if (any(lessThan(sampleAt, ivec2(0)))) continue;
      int bit = sampleAt.y * size.x + sampleAt.x;
      if (bit / 32 >= int(word(meta + 5))) continue;
      if ((word(int(word(meta + 4)) + bit / 32) & (1u << uint(bit % 32))) == 0u) continue;
      // Preserve Canvas rectangle coverage and integer premultiplied blending.
      vec2 axes = floor(min(vec2(1.0), overlap / u_scale) * 256.0 + 0.5);
      float coverage = min(255.0, floor(axes.x * axes.y / 256.0)) / 255.0;
      uvec4 product = uvec4(round(color * 255.0)) * uint(round(255.0 * (1.0 - coverage))) + 128u;
      color = vec4((product + (product >> 8u)) >> 8u) / 255.0;
    }
  }
}`;

/** Compose the same procedural samples and authored-scene cutouts entirely on
 * the GPU. Navigation performs no PNG encoding, bitmap transfer or readPixels. */
export async function createGPUViewportCompositor(
  renderer: any, inputs: TerrainViewportInputs,
  bounds: { x: number; y: number; width: number; height: number }, signal: AbortSignal,
  prepared?: Awaited<ReturnType<typeof packViewportClipping>>,
) {
  const packed = prepared ?? await packViewportClipping(inputs, bounds, signal);
  signal.throwIfAborted();
  const gl: WebGL2RenderingContext = renderer.gl;
  const maximum = gl.getParameter(gl.MAX_TEXTURE_SIZE);
  const width = Math.min(1024, maximum), height = Math.max(1, Math.ceil(packed.data.length / (width * 4)));
  if (height > maximum) throw new Error('Terrain clipping texture exceeds GPU capacity');
  const payload = new Uint32Array(width * height * 4); payload.set(packed.data);
  const shaders: WebGLShader[] = [];
  const program = gl.createProgram()!;
  const data = gl.createTexture()!, color = gl.createTexture()!;
  let disposed = false, frameWidth = 0, frameHeight = 0, capacityWidth = 0, capacityHeight = 0, camera = '';
  const dispose = () => {
    if (disposed) return; disposed = true;
    shaders.forEach(shader => gl.deleteShader(shader));
    gl.deleteProgram(program); gl.deleteTexture(data); gl.deleteTexture(color);
  };
  try {
    for (const [type, source] of [[gl.VERTEX_SHADER, vertex], [gl.FRAGMENT_SHADER, fragment]] as const) {
      const shader = gl.createShader(type)!; shaders.push(shader);
      gl.shaderSource(shader, source); gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? 'Clipping shader failed');
      gl.attachShader(program, shader);
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? 'Clipping program failed');
    const configure = (texture: WebGLTexture) => {
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    };
    gl.activeTexture(gl.TEXTURE0); configure(data);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32UI, width, height, 0, gl.RGBA_INTEGER, gl.UNSIGNED_INT, payload);
    configure(color);
    const uniforms = Object.fromEntries(['color','data','dataWidth','gridSize','gridOrigin','originInt','originFrac','size','scale']
      .map(name => [name, gl.getUniformLocation(program, 'u_' + name)]));
    return {
      bytes: payload.byteLength,
      render(resources: { setPlane(plane: -1 | 0 | 1): void; render(view: any): any }, plan: TerrainViewportPlan) {
        if (disposed) throw new DOMException('Terrain view disposed', 'AbortError');
        if (plan.pixelWidth > maximum || plan.pixelHeight > maximum) throw new Error('Terrain viewport exceeds GPU capacity');
        const key = [plan.x, plan.y, plan.scale, plan.pixelWidth, plan.pixelHeight, JSON.stringify(plan.samplingPlan)].join('/');
        frameWidth = plan.pixelWidth; frameHeight = plan.pixelHeight;
        if (camera !== key) {
          gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, color);
          if (capacityWidth < frameWidth || capacityHeight < frameHeight || capacityWidth * capacityHeight > frameWidth * frameHeight * 4) {
            capacityWidth = Math.min(maximum, Math.ceil(frameWidth / 128) * 128);
            capacityHeight = Math.min(maximum, Math.ceil(frameHeight / 128) * 128);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, capacityWidth, capacityHeight, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
          }
          for (const { plane, offsetY, view } of terrainViewportStrips(plan, inputs.center)) {
            resources.setPlane(plane);
            if (!resources.render(view)) throw new Error('GPU terrain draw unavailable');
            gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, color);
            gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, frameHeight - offsetY - view.height, 0, 0, view.width, view.height);
          }
          camera = key;
        }
        if (renderer.canvas.width !== frameWidth) renderer.canvas.width = frameWidth;
        if (renderer.canvas.height !== frameHeight) renderer.canvas.height = frameHeight;
        gl.viewport(0, 0, frameWidth, frameHeight);
        gl.useProgram(program);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, color);
        gl.activeTexture(gl.TEXTURE0 + 1); gl.bindTexture(gl.TEXTURE_2D, data);
        gl.uniform1i(uniforms.color, 0); gl.uniform1i(uniforms.data, 1);
        gl.uniform1i(uniforms.dataWidth, width);
        gl.uniform2i(uniforms.gridSize, packed.columns, packed.rows);
        gl.uniform2i(uniforms.gridOrigin, packed.left, packed.top);
        gl.uniform2i(uniforms.originInt, Math.floor(plan.x), Math.floor(plan.y));
        gl.uniform2f(uniforms.originFrac, plan.x - Math.floor(plan.x), plan.y - Math.floor(plan.y));
        gl.uniform2f(uniforms.size, frameWidth, frameHeight);
        gl.uniform1f(uniforms.scale, plan.scale);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        return renderer.canvas as CanvasImageSource;
      },
      dispose,
    };
  } catch (error) { dispose(); throw error; }
}
