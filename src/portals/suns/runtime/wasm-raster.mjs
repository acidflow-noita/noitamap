// Optional accelerator. JS and WASM run the same full-resolution raster formulas.
// WebAssembly disabled/CSP-blocked? The viewer retains the pure-JS fallback.
export async function loadRasterModule() {
  try {
    if (typeof WebAssembly === "undefined") return null;
    const response = await fetch(
      new URL("./assets/raster.wasm", import.meta.url),
    );
    return response.ok
      ? await WebAssembly.compile(await response.arrayBuffer())
      : null;
  } catch {
    return null;
  }
}
export class WasmRaster {
  constructor(module, width, height, texture, assets = {}) {
    this.api = new WebAssembly.Instance(module).exports;
    this.width = width;
    this.height = height;
    this.tw = texture.width;
    this.th = texture.height;
    let next = Number(this.api.__heap_base.value);
    const alloc = (n) => {
      const p = (next + 15) & ~15;
      next = p + n;
      return p;
    };
    const size = width * height * 3 * 4;
    this.sourcePtr = alloc(size);
    this.cellSourcePtr = alloc(width * height * 4);
    this.historyPtr = alloc(size);
    this.horizontalPtr = alloc(size);
    this.verticalPtr = alloc(size);
    this.texturePtr = alloc(texture.rgba.byteLength);
    this.verticesPtr = alloc(64);
    this.scenePtr = alloc(width * height * 4);
    this.outputPtr = alloc(width * height * 4);
    this.kernelPtr = alloc(576 * 5 * 8);
    this.edgesPtr = alloc(width * height * 4);
    this.lightingPtr = alloc(256 * 3 * 8);
    this.textures = new Map([[texture, this.texturePtr]]);
    for (const image of Object.values(assets))
      if (!this.textures.has(image))
        this.textures.set(image, alloc(image.rgba.byteLength));
    const memory = this.api.memory;
    if (next > memory.buffer.byteLength)
      memory.grow(Math.ceil((next - memory.buffer.byteLength) / 65536));
    this.source = new Float32Array(memory.buffer, this.sourcePtr, size / 4);
    this.cellSource = new Uint8ClampedArray(memory.buffer, this.cellSourcePtr, width * height * 4);
    this.history = new Float32Array(memory.buffer, this.historyPtr, size / 4);
    this.horizontal = new Float32Array(
      memory.buffer,
      this.horizontalPtr,
      size / 4,
    );
    this.vertical = new Float32Array(memory.buffer, this.verticalPtr, size / 4);
    this.vertices = new Float64Array(memory.buffer, this.verticesPtr, 8);
    this.scene = new Uint8ClampedArray(
      memory.buffer,
      this.scenePtr,
      width * height * 4,
    );
    // The JS monochrome compositor also writes here. Match the JS renderer's
    // byte clamping/rounding so bright glow cannot wrap modulo 256 into black.
    this.output = new Uint8ClampedArray(
      memory.buffer,
      this.outputPtr,
      width * height * 4,
    );
    this.edges = new Float32Array(memory.buffer, this.edgesPtr, width * height);
    this.lighting = new Float64Array(memory.buffer, this.lightingPtr, 256 * 3);
    this.kernel = new Float64Array(memory.buffer, this.kernelPtr, 576 * 5);
    for (const [image, pointer] of this.textures)
      new Uint8Array(memory.buffer, pointer, image.rgba.byteLength).set(
        image.rgba,
      );
  }
  setTexture(image, rgba) {
    new Uint8Array(this.api.memory.buffer, this.textures.get(image), rgba.byteLength).set(rgba);
  }
  glow(corners, r, g, b, alpha) {
    this.vertices.set(corners);
    this.api.glow_quad(
      this.verticesPtr,
      r,
      g,
      b,
      alpha,
      this.texturePtr,
      this.tw,
      this.th,
      this.sourcePtr,
      this.width,
      this.height,
    );
  }
  color(corners, r, g, b, alpha, texture, region, additive, afterGlow = false, linear = false) {
    this.vertices.set(corners);
    this.api.color_quad(
      this.verticesPtr,
      r,
      g,
      b,
      alpha,
      this.textures.get(texture) ?? 0,
      texture?.width ?? 0,
      texture?.height ?? 0,
      region?.x ?? 0,
      region?.y ?? 0,
      region?.width ?? 0,
      region?.height ?? 0,
      afterGlow ? this.outputPtr : this.scenePtr,
      this.width,
      this.height,
      Number(additive),
      Number(linear),
      1,
    );
  }
  cell(corners, r, g, b) {
    this.vertices.set(corners);
    this.api.color_quad(this.verticesPtr, r, g, b, 1, 0, 0, 0, 0, 0, 0, 0,
      this.cellSourcePtr, this.width, this.height, 0, 0, 0);
  }
  setKernel(taps) {
    this.kernelCount = taps.length;
    for (let i = 0; i < taps.length; i++) {
      const t = taps[i];
      this.kernel.set([t.x, t.y, t.r, t.g, t.b], i * 5);
    }
  }
  stamp(x, y, repeats = 1) {
    this.api.stamp_kernel(
      this.sourcePtr,
      this.kernelPtr,
      this.kernelCount,
      x,
      y,
      this.width,
      this.height,
      repeats,
    );
  }
  accumulate() {
    this.api.history_step(
      this.sourcePtr,
      this.cellSourcePtr,
      this.verticalPtr,
      this.edgesPtr,
      this.historyPtr,
      this.width * this.height,
    );
  }
  compose(glow, background, profile, table) {
    if (this.lightingTable !== table) { this.lighting.set(table); this.lightingTable = table; }
    this.api.composite(
      this.scenePtr,
      this.historyPtr,
      this.outputPtr,
      this.width * this.height,
      Number(glow),
      background,
      this.lightingPtr,
      ...profile.glowModulation,
    );
    return this.output;
  }
  blur() {
    this.api.blur_axis(
      this.historyPtr,
      this.horizontalPtr,
      this.width,
      this.height,
      0,
      0.1,
      1,
    );
    this.api.blur_axis(
      this.horizontalPtr,
      this.verticalPtr,
      this.width,
      this.height,
      1,
      1 / 12.2,
      0,
    );
  }
}
