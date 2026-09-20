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
    this.historyPtr = alloc(size);
    this.horizontalPtr = alloc(size);
    this.verticalPtr = alloc(size);
    this.texturePtr = alloc(texture.rgba.byteLength);
    this.verticesPtr = alloc(64);
    this.scenePtr = alloc(width * height * 4);
    this.outputPtr = alloc(width * height * 4);
    this.kernelPtr = alloc(576 * 5 * 8);
    this.edgesPtr = alloc(width * height * 4);
    this.textures = new Map([[texture, this.texturePtr]]);
    for (const image of Object.values(assets))
      if (!this.textures.has(image))
        this.textures.set(image, alloc(image.rgba.byteLength));
    const memory = this.api.memory;
    if (next > memory.buffer.byteLength)
      memory.grow(Math.ceil((next - memory.buffer.byteLength) / 65536));
    this.source = new Float32Array(memory.buffer, this.sourcePtr, size / 4);
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
    this.output = new Uint8Array(
      memory.buffer,
      this.outputPtr,
      width * height * 4,
    );
    this.edges = new Float32Array(memory.buffer, this.edgesPtr, width * height);
    this.kernel = new Float64Array(memory.buffer, this.kernelPtr, 576 * 5);
    for (const [image, pointer] of this.textures)
      new Uint8Array(memory.buffer, pointer, image.rgba.byteLength).set(
        image.rgba,
      );
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
  color(corners, r, g, b, alpha, texture, region, additive) {
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
      this.scenePtr,
      this.width,
      this.height,
      Number(additive),
    );
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
      this.verticalPtr,
      this.edgesPtr,
      this.historyPtr,
      this.width * this.height,
    );
  }
  compose(glow) {
    this.api.composite(
      this.scenePtr,
      this.historyPtr,
      this.outputPtr,
      this.width * this.height,
      Number(glow),
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
