// A frozen map crop plus a native-resolution eligibility mask. The owner supplies
// fresh crops and schedules frames; this presenter never retains CPU image data.
export const LIQUID_MAX_COLOR_PIXELS = 4 * 1024 * 1024;
export const LIQUID_MAX_MASK_PIXELS = 16 * 1024 * 1024;

const VERTEX = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAGMENT = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D u_color;
uniform sampler2D u_mask;
uniform vec2 u_size;
uniform vec2 u_maskSize;
uniform vec2 u_maskOrigin;
uniform vec3 u_worldX;
uniform vec3 u_worldY;
uniform vec2 u_screenX;
uniform vec2 u_screenY;
uniform float u_phase;
uniform float u_strength;
out vec4 outColor;

vec2 worldAt(vec2 p) {
  return vec2(dot(u_worldX, vec3(p, 1.0)), dot(u_worldY, vec3(p, 1.0)));
}
bool liquidAt(vec2 world) {
  vec2 cell = floor(world - u_maskOrigin);
  if (any(lessThan(cell, vec2(0.0))) || any(greaterThanEqual(cell, u_maskSize))) return false;
  return texelFetch(u_mask, ivec2(cell), 0).r > 0.0;
}
bool inColor(vec2 p) {
  return all(greaterThanEqual(p, vec2(0.0))) && all(lessThan(p, u_size));
}
vec4 premultiplied(vec4 color) { return vec4(color.rgb * color.a, color.a); }
void addSample(ivec2 cell, float weight, inout vec4 total, inout float weights) {
  vec2 center = vec2(cell) + 0.5;
  if (weight <= 0.0 || !inColor(center) || !liquidAt(worldAt(center))) return;
  total += premultiplied(texelFetch(u_color, cell, 0)) * weight;
  weights += weight;
}
void main() {
  // Both uploaded textures are top-down. GL's output coordinates are bottom-up.
  vec2 screen = vec2(gl_FragCoord.x, u_size.y - gl_FragCoord.y);
  vec2 world = worldAt(screen);
  outColor = vec4(0.0);
  if (!liquidAt(world)) return;
  vec4 original = premultiplied(texelFetch(u_color, ivec2(screen), 0));
  outColor = original;
  if (u_strength == 0.0) return;

  // Noita data/shaders/post_final.frag: time*10, scale 50, offset .002;
  // native viewport 427x242 gives .854/.484 world pixels. post_final.vert
  // maps world Y = camera Y + (1 - texture Y)*height, hence this Y phase/sign.
  vec2 offset = vec2(0.854 * sin(u_phase + world.x * (50.0 / 427.0)),
                    -0.484 * cos(u_phase + 50.0 - world.y * (50.0 / 242.0))) * u_strength;
  vec2 displaced = screen + vec2(dot(u_screenX, offset), dot(u_screenY, offset));
  // Match the native original/displaced mask gates. Reject rather than clamp
  // out-of-crop coordinates, which would stretch edge texels into a halo.
  if (!inColor(displaced) || !liquidAt(world + offset)) return;

  vec2 samplePixel = displaced - 0.5;
  ivec2 base = ivec2(floor(samplePixel));
  // Narrow the interpolation interval to preserve pixel-art plateaus while
  // keeping subpixel movement continuous. Guard and renormalize all four taps;
  // ordinary hardware linear filtering could still mix a neighboring solid.
  vec2 f = smoothstep(vec2(0.2), vec2(0.8), fract(samplePixel));
  vec4 total = vec4(0.0);
  float weights = 0.0;
  addSample(base, (1.0 - f.x) * (1.0 - f.y), total, weights);
  addSample(base + ivec2(1, 0), f.x * (1.0 - f.y), total, weights);
  addSample(base + ivec2(0, 1), (1.0 - f.x) * f.y, total, weights);
  addSample(base + ivec2(1, 1), f.x * f.y, total, weights);
  if (weights > 0.0) outColor = total / weights;
}`;

function dimensions(width, height, maxWidth, maxHeight, maxPixels, label) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 ||
      width > maxWidth || height > maxHeight || width * height > maxPixels) {
    throw new RangeError(`${label} dimensions exceed the liquid renderer budget`);
  }
}

function affine(value) {
  if (!value || value.length !== 6 || Array.from(value).some(x => !Number.isFinite(x) || !Number.isFinite(Math.fround(x))))
    throw new TypeError('screenToWorld must contain six finite affine coefficients');
  const [a, b, c, d, e, f] = value;
  const determinant = a * d - b * c;
  if (!determinant || !Number.isFinite(determinant) ||
      Math.abs(determinant) <= Number.EPSILON * (Math.abs(a * d) + Math.abs(b * c)) * 16)
    throw new RangeError('screenToWorld must be invertible');
  const inverse = [d / determinant, -c / determinant, -b / determinant, a / determinant];
  if (inverse.some(x => !Number.isFinite(Math.fround(x)))) throw new RangeError('screenToWorld inverse exceeds GPU precision');
  return { worldX: [a, c, e], worldY: [b, d, f], inverse };
}

/**
 * Dedicated WebGL2 overlay. Source pixels and mask rows run left-to-right,
 * top-to-bottom. screenToWorld uses Canvas affine order [a,b,c,d,e,f] and maps
 * physical crop pixel centers to absolute Noita world coordinates. Color is a
 * same-sized CanvasImageSource, or { data: Uint8Array, width, height } RGBA8.
 * Any nonzero mask byte denotes eligible liquid, including lava. Outside the
 * original mask output is transparent; eligible source alpha is preserved.
 * setSource uploads only when called, and does not retain the source objects.
 * setSource/render return true when submitted, null while earlier GPU work is
 * pending, and false when unavailable. The owner retains a refused source for
 * a later retry. There is at most one outstanding GPU sync, including uploads.
 * Context restoration requires the owner to call setSource again.
 */
export class LiquidRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = canvas.getContext('webgl2', {
      alpha: true, premultipliedAlpha: true, antialias: false,
      depth: false, stencil: false, preserveDrawingBuffer: false,
    });
    if (!this.gl) throw new Error('Liquid refraction requires WebGL2');
    const gl = this.gl;
    const textureLimit = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    const viewport = gl.getParameter(gl.MAX_VIEWPORT_DIMS);
    const renderbufferLimit = gl.getParameter(gl.MAX_RENDERBUFFER_SIZE);
    this.maxMaskDimension = textureLimit;
    this.maxWidth = Math.min(textureLimit, renderbufferLimit, viewport[0]);
    this.maxHeight = Math.min(textureLimit, renderbufferLimit, viewport[1]);
    this.disposed = false;
    this.lost = false;
    this.ready = false;
    this.width = this.height = this.maskWidth = this.maskHeight = 0;
    this.frames = this.uploads = this.uploadBytes = this.allocations = this.sourceUpdates = 0;
    this.skippedFrames = this.skippedSourceUpdates = this.fencesCreated = 0;
    this.fence = this.pendingGPU = null;
    this.syncFailed = false;
    this.restores = 0;
    this.lastError = null;
    this.program = this.vao = this.colorTexture = this.maskTexture = null;
    this.onLost = event => {
      event.preventDefault();
      this.lost = true;
      this._forget(); // Lost-context resources are already owned by the driver.
    };
    this.onRestored = () => {
      if (this.disposed) return;
      this.lost = false;
      this.restores++;
      try { this._initialize(); } catch (error) { this.lastError = String(error); }
    };
    this._initialize();
    canvas.addEventListener('webglcontextlost', this.onLost);
    canvas.addEventListener('webglcontextrestored', this.onRestored);
  }

  _initialize() {
    const gl = this.gl, shaders = [];
    try {
      this.program = gl.createProgram();
      if (!this.program) throw new Error('Cannot allocate liquid shader program');
      for (const [type, source] of [[gl.VERTEX_SHADER, VERTEX], [gl.FRAGMENT_SHADER, FRAGMENT]]) {
        const shader = gl.createShader(type);
        if (!shader) throw new Error('Cannot allocate liquid shader');
        shaders.push(shader);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) || 'Liquid shader compilation failed');
        gl.attachShader(this.program, shader);
      }
      gl.linkProgram(this.program);
      if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(this.program) || 'Liquid shader linking failed');
      this.uniforms = Object.fromEntries(['color', 'mask', 'size', 'maskSize', 'maskOrigin', 'worldX', 'worldY', 'screenX', 'screenY', 'phase', 'strength']
        .map(name => [name, gl.getUniformLocation(this.program, `u_${name}`)]));
      this.vao = gl.createVertexArray();
      this.colorTexture = gl.createTexture();
      this.maskTexture = gl.createTexture();
      if (!this.vao || !this.colorTexture || !this.maskTexture) throw new Error('Cannot allocate liquid GPU resources');
      for (const texture of [this.colorTexture, this.maskTexture]) {
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      }
      this.lastError = null;
      this.syncFailed = false;
    } catch (error) {
      this._delete();
      throw error;
    } finally {
      for (const shader of shaders) gl.deleteShader(shader);
    }
  }

  setSource({ color, width, height, mask, maskWidth, maskHeight, maskX = 0, maskY = 0, screenToWorld }) {
    if (this.disposed || this.lost || this.syncFailed || this.gl.isContextLost()) return false;
    dimensions(width, height, this.maxWidth, this.maxHeight, LIQUID_MAX_COLOR_PIXELS, 'Color');
    dimensions(maskWidth, maskHeight, this.maxMaskDimension, this.maxMaskDimension, LIQUID_MAX_MASK_PIXELS, 'Mask');
    if (!(mask instanceof Uint8Array) || mask.length !== maskWidth * maskHeight)
      throw new TypeError('Liquid mask must be a tightly packed R8 Uint8Array');
    if (!Number.isSafeInteger(maskX) || !Number.isSafeInteger(maskY)) throw new TypeError('Mask origin must use integer world pixels');
    const transform = affine(screenToWorld);
    if (!color) throw new TypeError('Liquid color source is required');
    const data = color.data;
    if (data !== undefined && (!(data instanceof Uint8Array || data instanceof Uint8ClampedArray) || data.length !== width * height * 4))
      throw new TypeError('Liquid color data must be tightly packed RGBA8');
    const sourceWidth = color.videoWidth ?? color.naturalWidth ?? color.displayWidth ?? color.width;
    const sourceHeight = color.videoHeight ?? color.naturalHeight ?? color.displayHeight ?? color.height;
    if (sourceWidth !== width || sourceHeight !== height) throw new RangeError('Liquid color dimensions must match the output crop');
    const available = this._pollFence();
    if (available !== true) {
      if (available === null) this.skippedSourceUpdates++;
      return available;
    }
    if (!this.program) this._initialize();
    const gl = this.gl, u = this.uniforms;
    this.ready = false;
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.colorTexture);
    if (width !== this.width || height !== this.height) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      this.allocations++;
    }
    // WebGL2 accepts explicit dimensions for DOM sources too. Never let the
    // legacy overload infer a larger ImageBitmap backing-surface size.
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, data ?? color);
    this._checkUpload('color', width, height);
    gl.activeTexture(gl.TEXTURE0 + 1);
    gl.bindTexture(gl.TEXTURE_2D, this.maskTexture);
    if (maskWidth !== this.maskWidth || maskHeight !== this.maskHeight) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, maskWidth, maskHeight, 0, gl.RED, gl.UNSIGNED_BYTE, null);
      this.allocations++;
    }
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, maskWidth, maskHeight, gl.RED, gl.UNSIGNED_BYTE, mask);
    this._checkUpload('mask', maskWidth, maskHeight);
    this.width = width; this.height = height;
    this.maskWidth = maskWidth; this.maskHeight = maskHeight;
    this.uploads += 2;
    this.uploadBytes += width * height * 4 + maskWidth * maskHeight;
    this.sourceUpdates++;
    gl.useProgram(this.program);
    gl.uniform1i(u.color, 0); gl.uniform1i(u.mask, 1);
    gl.uniform2f(u.size, width, height);
    gl.uniform2f(u.maskSize, maskWidth, maskHeight);
    gl.uniform2f(u.maskOrigin, maskX, maskY);
    gl.uniform3f(u.worldX, ...transform.worldX);
    gl.uniform3f(u.worldY, ...transform.worldY);
    gl.uniform2f(u.screenX, transform.inverse[0], transform.inverse[1]);
    gl.uniform2f(u.screenY, transform.inverse[2], transform.inverse[3]);
    this.ready = true;
    this.lastError = null;
    // Repeated source refreshes must not queue uploads behind a stalled GPU,
    // even if the owner has paused animation between those refreshes.
    return this._placeFence('source');
  }

  _checkUpload(kind, width, height) {
    const error = this.gl.getError();
    if (!error) return;
    this.lastError = `Liquid ${kind} upload failed (${width}x${height}, WebGL ${error})`;
    this._delete();
    throw new Error(this.lastError);
  }

  render(timeSeconds, strength = 1) {
    if (this.disposed || this.lost || this.syncFailed || !this.ready || this.gl.isContextLost()) return false;
    if (!Number.isFinite(timeSeconds) || !Number.isFinite(strength)) throw new TypeError('Liquid time and strength must be finite');
    const available = this._pollFence();
    if (available !== true) {
      if (available === null) this.skippedFrames++;
      return available;
    }
    const gl = this.gl;
    gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST); gl.disable(gl.SCISSOR_TEST); gl.disable(gl.DITHER);
    gl.viewport(0, 0, this.width, this.height);
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.colorTexture);
    gl.activeTexture(gl.TEXTURE0 + 1); gl.bindTexture(gl.TEXTURE_2D, this.maskTexture);
    // Reduce only the temporal phase, retaining a long-running stable clock.
    gl.uniform1f(this.uniforms.phase, (timeSeconds % (Math.PI / 5)) * 10);
    gl.uniform1f(this.uniforms.strength, Math.max(0, Math.min(1, strength)));
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.frames++;
    return this._placeFence('frame');
  }

  _placeFence(kind) {
    const gl = this.gl;
    this.fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    if (!this.fence) {
      // Stop after an untracked submission; never fall back to an unbounded
      // command stream when the driver cannot provide a completion signal.
      this.syncFailed = true; this.ready = false;
      this.lastError = 'Liquid GPU fence unavailable';
      return false;
    }
    this.pendingGPU = kind;
    this.fencesCreated++;
    gl.flush(); // Submit without waiting. Production never calls finish().
    return true;
  }

  _pollFence() {
    if (!this.fence) return true;
    const gl = this.gl;
    const status = gl.clientWaitSync(this.fence, 0, 0);
    if (status === gl.TIMEOUT_EXPIRED) return null;
    if (!this.lost && !gl.isContextLost()) gl.deleteSync(this.fence);
    this.fence = this.pendingGPU = null;
    if (status === gl.ALREADY_SIGNALED || status === gl.CONDITION_SATISFIED) return true;
    this.syncFailed = true; this.ready = false;
    this.lastError = 'Liquid GPU fence failed';
    return false;
  }

  stats() {
    const textureBytes = this.width * this.height * 4 + this.maskWidth * this.maskHeight;
    return {
      ready: this.ready, contextLost: this.lost || (!this.disposed && this.gl.isContextLost()), disposed: this.disposed,
      width: this.width, height: this.height, maskWidth: this.maskWidth, maskHeight: this.maskHeight,
      textureBytes, estimatedGPUBytes: textureBytes + this.width * this.height * 8, // Two presentation buffers assumed.
      textures: Number(!!this.colorTexture) + Number(!!this.maskTexture),
      busy: !!this.fence, pendingGPU: this.pendingGPU, pendingSyncs: Number(!!this.fence), syncFailed: this.syncFailed,
      skippedFrames: this.skippedFrames, skippedSourceUpdates: this.skippedSourceUpdates, fencesCreated: this.fencesCreated,
      frames: this.frames, uploads: this.uploads, uploadBytes: this.uploadBytes,
      allocations: this.allocations, sourceUpdates: this.sourceUpdates, restores: this.restores,
      maxColorPixels: LIQUID_MAX_COLOR_PIXELS, maxMaskPixels: LIQUID_MAX_MASK_PIXELS,
      maxWidth: this.maxWidth, maxHeight: this.maxHeight, maxMaskDimension: this.maxMaskDimension,
      lastError: this.lastError,
    };
  }

  _forget() {
    this.program = this.vao = this.colorTexture = this.maskTexture = null;
    this.fence = this.pendingGPU = null;
    this.width = this.height = this.maskWidth = this.maskHeight = 0;
    this.ready = false;
  }

  _delete() {
    const gl = this.gl;
    if (this.fence) gl.deleteSync(this.fence);
    if (this.program) gl.deleteProgram(this.program);
    if (this.vao) gl.deleteVertexArray(this.vao);
    if (this.colorTexture) gl.deleteTexture(this.colorTexture);
    if (this.maskTexture) gl.deleteTexture(this.maskTexture);
    this._forget();
  }

  dispose() {
    if (this.disposed) return;
    this.canvas.removeEventListener('webglcontextlost', this.onLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onRestored);
    if (!this.lost && !this.gl.isContextLost()) this._delete();
    else this._forget();
    this.canvas.width = this.canvas.height = 0;
    this.disposed = true;
  }
}
