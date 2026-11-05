// The production renderer executes on real Mesa GLES. Only browser canvas/event
// and upload adapters live here; no browser, game, or animation loop is started.
import { nativeSunGL } from './native-sun-gl.mjs';
import koffi from 'koffi';

export function nativeLiquidGL() {
  const native = nativeSunGL();
  /** @type {any} Native bindings implement the WebGL subset below. */
  const gl = native.gl;
  Object.assign(gl, {
    R8: 0x8229, NONE: 0, SCISSOR_TEST: 0x0c11, MAX_RENDERBUFFER_SIZE: 0x84e8,
    UNPACK_FLIP_Y_WEBGL: 0x9240, UNPACK_PREMULTIPLY_ALPHA_WEBGL: 0x9241,
    UNPACK_COLORSPACE_CONVERSION_WEBGL: 0x9243,
    SYNC_GPU_COMMANDS_COMPLETE: 0x9117, ALREADY_SIGNALED: 0x911a,
    TIMEOUT_EXPIRED: 0x911b, CONDITION_SATISFIED: 0x911c, WAIT_FAILED: 0x911d,
  });
  const counts = { uploads: 0, allocations: 0, draws: 0, uploadBytes: 0,
    syncsCreated: 0, syncsDeleted: 0, syncPolls: 0, flushes: 0, maxLiveSyncs: 0 };
  const live = { Texture: new Set(), Program: new Set(), Shader: new Set(), VertexArray: new Set(), Sync: new Set() };
  const remove = {};
  for (const name of Object.keys(live).filter(name => name !== 'Sync')) {
    const create = gl[`create${name}`], del = gl[`delete${name}`];
    remove[name] = del;
    gl[`create${name}`] = (...args) => {
      const id = create(...args);
      if (id) live[name].add(id);
      return id;
    };
    gl[`delete${name}`] = id => { live[name].delete(id); return del(id); };
  }
  const lib = koffi.load('libGLESv2.so.2');
  const fence = lib.func('void *glFenceSync(uint condition,uint flags)');
  const wait = lib.func('uint glClientWaitSync(void *sync,uint flags,uint64 timeout)');
  const deleteSync = lib.func('void glDeleteSync(void *sync)');
  const flush = lib.func('void glFlush()');
  remove.Sync = deleteSync;
  gl.fenceSync = (condition, flags) => {
    const sync = fence(condition, flags);
    if (sync) { live.Sync.add(sync); counts.syncsCreated++; counts.maxLiveSyncs = Math.max(counts.maxLiveSyncs, live.Sync.size); }
    return sync;
  };
  gl.clientWaitSync = (sync, flags, timeout) => {
    if (flags !== 0 || timeout !== 0) throw new Error('Liquid GPU polling must be nonblocking');
    counts.syncPolls++;
    return wait(sync, flags, timeout);
  };
  gl.deleteSync = sync => { live.Sync.delete(sync); counts.syncsDeleted++; deleteSync(sync); };
  gl.flush = () => { counts.flushes++; flush(); };
  const pixelStore = gl.pixelStorei;
  gl.pixelStorei = (name, value) => {
    if ([gl.UNPACK_FLIP_Y_WEBGL, gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, gl.UNPACK_COLORSPACE_CONVERSION_WEBGL].includes(name)) {
      if (Number(value) !== 0) throw new Error('Native liquid fixture expects unflipped, straight-alpha source pixels');
      return;
    }
    pixelStore(name, Number(value));
  };
  const allocate = gl.texImage2D, upload = gl.texSubImage2D, draw = gl.drawArrays;
  gl.texImage2D = (...args) => { counts.allocations++; return allocate(...args); };
  gl.texSubImage2D = (...args) => {
    counts.uploads++;
    if (args.length === 7) {
      const [target, level, x, y, format, type, canvas] = args;
      const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      args = [target, level, x, y, canvas.width, canvas.height, format, type, data];
    } else if (args.length === 9 && typeof args[8]?.getContext === 'function') {
      const canvas = args[8];
      args[8] = canvas.getContext('2d').getImageData(0, 0, args[4], args[5]).data;
    }
    counts.uploadBytes += args[8].byteLength;
    return upload(...args);
  };
  gl.drawArrays = (...args) => { counts.draws++; return draw(...args); };
  let lost = false;
  gl.isContextLost = () => lost;
  class Canvas {
    constructor(width = 1, height = 1) { this.width = width; this.height = height; this.listeners = new Map(); }
    getContext(type) { return type === 'webgl2' ? gl : null; }
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(fn);
    }
    removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
    dispatch(type) {
      const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
      for (const listener of this.listeners.get(type) ?? []) listener(event);
      return event;
    }
    // EGL cannot emit DOM events. Delete resources as a lost WebGL context
    // would, then exercise the actual production event handlers and recovery.
    lose() {
      for (const [kind, ids] of Object.entries(live)) {
        for (const id of ids) remove[kind](id);
        ids.clear();
      }
      lost = true;
      return this.dispatch('webglcontextlost');
    }
    restore() { lost = false; this.dispatch('webglcontextrestored'); }
  }
  return {
    ...native, gl, Canvas,
    counts() { return { ...counts, liveTextures: live.Texture.size, livePrograms: live.Program.size, liveShaders: live.Shader.size,
      liveVertexArrays: live.VertexArray.size, liveSyncs: live.Sync.size }; },
    read(width, height) {
      gl.finish();
      const bottomUp = native.read(width, height), topDown = new Uint8Array(bottomUp.length);
      for (let y = 0; y < height; y++) topDown.set(bottomUp.subarray((height - y - 1) * width * 4, (height - y) * width * 4), y * width * 4);
      const error = gl.getError();
      if (error) throw new Error(`Liquid readback GLES error 0x${error.toString(16)}`);
      return topDown;
    },
  };
}

export function liquidFixture(width, height, options = {}) {
  const {
    screenToWorld = [1, 0, 0, 1, 0, 0],
    maskX = 0, maskY = 0, maskWidth = width, maskHeight = height,
    maskAt = () => 255,
    colorAt = (x, y) => [30 + (Math.floor(x) * 23 + Math.floor(y) * 3) % 150, 45 + (Math.floor(y) * 29) % 150, 180, 255],
  } = options;
  const [a, b, c, d, e, f] = screenToWorld;
  const data = new Uint8Array(width * height * 4), mask = new Uint8Array(maskWidth * maskHeight);
  for (let y = 0; y < maskHeight; y++) for (let x = 0; x < maskWidth; x++) mask[y * maskWidth + x] = maskAt(x + maskX, y + maskY);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const wx = a * (x + 0.5) + c * (y + 0.5) + e, wy = b * (x + 0.5) + d * (y + 0.5) + f;
    data.set(colorAt(wx, wy), (y * width + x) * 4);
  }
  return { color: { data, width, height }, width, height, mask, maskWidth, maskHeight, maskX, maskY, screenToWorld };
}

// Independent scalar oracle for the Noita phase, affine inverse and guarded
// interpolation, used on small fixtures only, never as a rendering fallback.
export function referenceLiquid(source, time, strength = 1) {
  const { width, height, color: { data }, mask, maskX, maskY, maskWidth, maskHeight, screenToWorld: [a, b, c, d, e, f] } = source;
  const determinant = a * d - b * c;
  const output = new Uint8Array(data.length);
  const world = (x, y) => [a * x + c * y + e, b * x + d * y + f];
  const inColor = (x, y) => x >= 0 && y >= 0 && x < width && y < height;
  const liquid = (x, y) => {
    const mx = Math.floor(x - maskX), my = Math.floor(y - maskY);
    return mx >= 0 && my >= 0 && mx < maskWidth && my < maskHeight && mask[my * maskWidth + mx] > 0;
  };
  const read = (x, y) => {
    const i = (y * width + x) * 4, alpha = data[i + 3] / 255;
    return [data[i] * alpha, data[i + 1] * alpha, data[i + 2] * alpha, data[i + 3]];
  };
  const smooth = value => { const t = Math.max(0, Math.min(1, (value - 0.2) / 0.6)); return t * t * (3 - 2 * t); };
  const phase = (time % (Math.PI / 5)) * 10, amount = Math.max(0, Math.min(1, strength));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const [wx, wy] = world(x + 0.5, y + 0.5);
    if (!liquid(wx, wy)) continue;
    let rgba = read(x, y);
    const dx = 0.854 * Math.sin(phase + wx * 50 / 427) * amount;
    const dy = -0.484 * Math.cos(phase + 50 - wy * 50 / 242) * amount;
    const sx = x + 0.5 + (d * dx - c * dy) / determinant, sy = y + 0.5 + (-b * dx + a * dy) / determinant;
    if (amount && inColor(sx, sy) && liquid(wx + dx, wy + dy)) {
      const bx = Math.floor(sx - 0.5), by = Math.floor(sy - 0.5);
      const fx = smooth(sx - 0.5 - bx), fy = smooth(sy - 0.5 - by);
      const total = [0, 0, 0, 0]; let weights = 0;
      for (const [ox, oy, weight] of [[0, 0, (1 - fx) * (1 - fy)], [1, 0, fx * (1 - fy)], [0, 1, (1 - fx) * fy], [1, 1, fx * fy]]) {
        const tx = bx + ox, ty = by + oy;
        if (!weight || !inColor(tx + 0.5, ty + 0.5) || !liquid(...world(tx + 0.5, ty + 0.5))) continue;
        const sample = read(tx, ty);
        for (let channel = 0; channel < 4; channel++) total[channel] += sample[channel] * weight;
        weights += weight;
      }
      if (weights) rgba = total.map(value => value / weights);
    }
    output.set(rgba.map(Math.round), (y * width + x) * 4);
  }
  return output;
}
