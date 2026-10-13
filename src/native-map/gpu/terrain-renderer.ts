import { vertex, topology0, topology2, color } from './terrain-programs';
import type { LiquidProbeBounds } from './liquid-bounds';

type Program = { name: string; handle: any; uniforms: Record<string, any>; samplers: string[] };
type Target = { framebuffer: any; texture: any; width: number; height: number };
const textureInputs: Record<string, string> = {
  u_chunkTex: 'chunk', u_fgTex: 'fg', u_noiseTex: 'noise', u_indirTex: 'indirection',
  u_regionTex: 'regionMeta', u_atlasTex: 'atlas', u_paletteTex: 'palette',
  u_matAtlasTex: 'matAtlas', u_matMetaTex: 'matMeta', u_palMatTex: 'palMat', u_fgMatTex: 'fgMat',
  u_covTex: 'cov', u_latMatTex: 'latMat', u_engChunkTex: 'engChunk',
  u_engTableTex: 'engTable', u_sinHashTex: 'sinHash',
};
const unresolved = new Uint32Array(4);

/** Owned multi-pass renderer. Material decisions stay on the GPU and are reused
 * by color/liquid composition. Programs and immutable input uploads survive
 * reseeds. This draws the host's requested rectangles; it is not a full-map cook. */
export class NativeTerrainRenderer {
  canvas: any;
  gl: any;
  program: any = null;
  uniforms: Record<string, any> = {};
  textures: Record<string, any> | null = null;
  resources: any;
  contextLost = false;
  failed: string | null = null;
  shaderWarmupMs = 0;
  mapWidth = 70;
  centerPx = 35 * 512;
  worldSizeX = 70 * 512;
  surfacePhase = 0;
  liquidProbeBounds?: LiquidProbeBounds[];
  engineChunkModes?: Uint16Array;
  private programs: Program[] = [];
  private pending?: Promise<void>;
  private epoch = 0;
  private plane = 0;
  private liquidRow = 0;
  private raw?: Target;
  private probes?: Target;

  constructor(context?: { canvas: any; gl: any }) {
    if (context) { this.canvas = context.canvas; this.gl = context.gl; this.watchContext(); }
  }

  private watchContext() {
    this.canvas.addEventListener('webglcontextlost', (event: Event) => {
      event.preventDefault();
      this.epoch++;
      this.contextLost = true;
      this.program = null;
      this.programs = [];
      this.textures = null;
      this.raw = this.probes = undefined;
      this.pending = undefined;
    });
    this.canvas.addEventListener('webglcontextrestored', () => { this.contextLost = false; });
    this.gl.disable(this.gl.BLEND);
    this.gl.disable(this.gl.DEPTH_TEST);
  }

  initContext(): boolean {
    if (this.gl) return !this.contextLost;
    this.canvas = typeof document === 'undefined' ? new OffscreenCanvas(1, 1) : document.createElement('canvas');
    const attributes = { alpha: true, antialias: false, depth: false, stencil: false,
      premultipliedAlpha: true, preserveDrawingBuffer: false, powerPreference: 'high-performance' };
    this.gl = this.canvas.getContext('webgl2', attributes)
      ?? this.canvas.getContext('webgl2', { ...attributes, powerPreference: 'default' });
    if (!this.gl) { this.failed = 'WebGL2 unavailable'; return false; }
    this.watchContext();
    return true;
  }

  get ready(): boolean { return !!(this.program && this.textures && this.resources && !this.contextLost); }
  get engineReady(): boolean {
    return !!(this.ready && this.textures!.cov && this.textures!.latMat && this.textures!.engChunk
      && this.textures!.engTable && this.textures!.sinHash && this.textures!.matMeta && this.textures!.matAtlas);
  }

  prewarm(): Promise<void> {
    if (this.program) return Promise.resolve();
    if (this.pending) return this.pending;
    const work = this.compile();
    this.pending = work;
    void work.then(() => { if (this.pending === work) this.pending = undefined; },
      () => { if (this.pending === work) this.pending = undefined; });
    return work;
  }

  private async compile(): Promise<void> {
    if (!this.initContext()) throw Error(this.failed ?? 'Native terrain context lost');
    const gl = this.gl, epoch = this.epoch, started = performance.now();
    const parallel = gl.getExtension?.('KHR_parallel_shader_compile');
    const linked: Array<{ program: Program; shaders: any[]; source: string }> = [];
    try {
      for (const [name, source] of [['topology0', topology0], ['topology2', topology2], ['color', color]]) {
        const program: Program = { name, handle: gl.createProgram(), uniforms: {}, samplers: [] };
        if (!program.handle) throw Error(`Cannot allocate ${name} program`);
        const shaders: any[] = [];
        linked.push({ program, shaders, source });
        for (const [type, code] of [[gl.VERTEX_SHADER, vertex], [gl.FRAGMENT_SHADER, source]]) {
          const shader = gl.createShader(type);
          if (!shader) throw Error('Cannot allocate native terrain shader');
          shaders.push(shader);
          gl.shaderSource(shader, code); gl.compileShader(shader); gl.attachShader(program.handle, shader);
        }
        gl.linkProgram(program.handle);
      }
      while (parallel && linked.some(p => !gl.getProgramParameter(p.program.handle, parallel.COMPLETION_STATUS_KHR))) {
        if (epoch !== this.epoch || gl.isContextLost?.() || performance.now() - started > 30000)
          throw Error('Native terrain compilation interrupted');
        await new Promise(resolve => setTimeout(resolve, 4));
      }
      for (const { program, shaders, source } of linked) {
        if (!gl.getProgramParameter(program.handle, gl.LINK_STATUS))
          throw Error(`${program.name} link: ${gl.getProgramInfoLog(program.handle)}`);
        for (const shader of shaders)
          if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw Error(gl.getShaderInfoLog(shader));
        for (const match of source.matchAll(/uniform\s+(?:(?:highp|mediump|lowp)\s+)?(\w+)\s+(\w+)\s*;/g)) {
          const location = gl.getUniformLocation(program.handle, match[2]);
          if (location === null || location === -1) continue;
          program.uniforms[match[2]] = location;
          if (match[1].includes('sampler')) program.samplers.push(match[2]);
        }
        if (program.samplers.length > gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS))
          throw Error(`${program.name} exceeds the device's texture-unit limit`);
      }
      if (epoch !== this.epoch || this.contextLost || gl.getError()) throw Error('Native terrain program unavailable');
      this.programs = linked.map(p => p.program);
      this.program = this.programs[2].handle;
      this.uniforms = this.programs[2].uniforms;
      this.shaderWarmupMs = performance.now() - started;
      console.info('[Native terrain] Programs ready', {
        totalMs: this.shaderWarmupMs, programs: this.programs.map(p => ({ name: p.name, samplers: p.samplers.length })),
      });
    } catch (error) {
      for (const { program } of linked) gl.deleteProgram(program.handle);
      throw error;
    } finally {
      for (const { shaders } of linked) for (const shader of shaders) gl.deleteShader(shader);
    }
  }

  setPlane(plane: number): void {
    if (plane !== -1 && plane !== 0 && plane !== 1) throw Error('Invalid native terrain plane');
    this.plane = plane;
  }
  setLiquidRow(row: number): void { this.liquidRow = row; }

  private probeScissor(view: any): number[] | undefined {
    if (!this.liquidProbeBounds) return [0, 0, view.width, view.height];
    const scale = 1 / view.camZ, pitch = this.mapWidth * 512;
    const x = view.camX - (view.sampleWidth ?? view.width) / 2 * scale - this.centerPx
      + view.pw * pitch + (view.sampleOffsetX ?? 0) * scale;
    const y = view.camY - (view.sampleHeight ?? view.height) / 2 * scale - 7168
      + view.pwVertical * 24576 + (view.sampleOffsetY ?? 0) * scale;
    const first = Math.floor((x + this.centerPx) / pitch) - 1, last = Math.floor((x + view.width * scale + this.centerPx) / pitch) + 1;
    if (last - first > 6) return [0, 0, view.width, view.height];
    let left = view.width, right = 0, top = view.height, bottom = 0;
    for (const bounds of this.liquidProbeBounds) {
      if (!(bounds.planes & (1 << (this.plane + 1)))) continue;
      const padding = 2 + Math.ceil(1 / scale);
      const t = Math.floor((bounds.top + this.plane * 24576 - y) / scale) - padding;
      const b = Math.ceil((bounds.bottom + this.plane * 24576 - y) / scale) + padding;
      if (t >= view.height || b <= 0) continue;
      for (let pw = first; pw <= last; pw++) {
        const l = Math.floor((bounds.left + pw * pitch - x) / scale) - padding;
        const r = Math.ceil((bounds.right + pw * pitch - x) / scale) + padding;
        if (l >= view.width || r <= 0) continue;
        left = Math.min(left, l); right = Math.max(right, r);
        top = Math.min(top, t); bottom = Math.max(bottom, b);
      }
    }
    left = Math.max(left, 0); top = Math.max(top, 0);
    right = Math.min(right, view.width); bottom = Math.min(bottom, view.height);
    return left < right && top < bottom ? [left, view.height - bottom, right - left, bottom - top] : undefined;
  }

  private materialScissor(view: any, topology: number): number[] | undefined {
    if (!this.engineChunkModes) return [0, 0, view.width, view.height];
    const scale = 1 / view.camZ;
    const x = view.camX - (view.sampleWidth ?? view.width) / 2 * scale - this.centerPx
      + view.pw * this.mapWidth * 512 + (view.sampleOffsetX ?? 0) * scale;
    const y = view.camY - (view.sampleHeight ?? view.height) / 2 * scale - 7168
      + view.pwVertical * 24576 + (view.sampleOffsetY ?? 0) * scale;
    // Keep a whole neighbouring chunk as a guard for edge wobble, then let
    // the shader make the exact decision. This never substitutes a biome.
    const firstX = Math.floor((x + this.centerPx) / 512) - 1;
    const lastX = Math.floor((x + view.width * scale + this.centerPx) / 512) + 1;
    const firstY = Math.floor((y + 7168) / 512) - 1;
    const lastY = Math.floor((y + view.height * scale + 7168) / 512) + 1;
    if ((lastX - firstX) * (lastY - firstY) > 2048) return [0, 0, view.width, view.height];
    let left = view.width, right = 0, top = view.height, bottom = 0;
    for (let row = firstY; row <= lastY; row++) for (let col = firstX; col <= lastX; col++) {
      const cx = ((col % this.mapWidth) + this.mapWidth) % this.mapWidth;
      const cy = Math.max(0, Math.min(47, row - this.plane * 48));
      const info = this.engineChunkModes[cy * this.mapWidth + cx];
      if ((info & 2048) ? topology !== 0 : ((info >> 8) & 3) !== topology) continue;
      left = Math.min(left, Math.floor(((col - 1) * 512 - this.centerPx - x) / scale) - 2);
      right = Math.max(right, Math.ceil(((col + 2) * 512 - this.centerPx - x) / scale) + 2);
      top = Math.min(top, Math.floor(((row - 1) * 512 - 7168 - y) / scale) - 2);
      bottom = Math.max(bottom, Math.ceil(((row + 2) * 512 - 7168 - y) / scale) + 2);
    }
    left = Math.max(0, left); right = Math.min(view.width, right);
    top = Math.max(0, top); bottom = Math.min(view.height, bottom);
    return left < right && top < bottom ? [left, view.height - bottom, right - left, bottom - top] : undefined;
  }

  private target(target: Target | undefined, width: number, height: number): Target {
    const gl = this.gl;
    if (!target) {
      const framebuffer = gl.createFramebuffer(), texture = gl.createTexture();
      if (!framebuffer || !texture) {
        if (framebuffer) gl.deleteFramebuffer(framebuffer);
        if (texture) gl.deleteTexture(texture);
        throw Error('Cannot allocate native terrain target');
      }
      target = { framebuffer, texture, width: 0, height: 0 };
    }
    gl.bindTexture(gl.TEXTURE_2D, target.texture);
    if (target.width !== width || target.height !== height) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16UI, width, height, 0, gl.RED_INTEGER, gl.UNSIGNED_SHORT, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      target.width = width; target.height = height;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target.texture, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw Error('Native terrain framebuffer incomplete');
    gl.clearBufferuiv(gl.COLOR, 0, unresolved);
    return target;
  }

  private bind(program: Program, view: any, probe: boolean, engine: boolean) {
    const gl = this.gl, u = program.uniforms, textures = this.textures!;
    gl.useProgram(program.handle);
    for (let unit = 0; unit < program.samplers.length; unit++) {
      const name = program.samplers[unit];
      const texture = name === 'u_nativeRaw' ? (probe || program.name === 'color' ? this.raw!.texture : textures.chunk)
        : name === 'u_nativeProbeIds' ? this.probes!.texture : textures[textureInputs[name]];
      if (!texture) throw Error(`Missing native terrain input ${name}`);
      gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, texture); gl.uniform1i(u[name], unit);
    }
    const x = view.camX - (view.sampleWidth ?? view.width) / 2 / view.camZ - this.centerPx + view.pw * 512 * this.mapWidth;
    const y = view.camY - (view.sampleHeight ?? view.height) / 2 / view.camZ - 7168 + view.pwVertical * 24576;
    const i = (name: string, value: number) => { if (u[name] !== undefined) gl.uniform1i(u[name], value); };
    const f = (name: string, value: number) => { if (u[name] !== undefined) gl.uniform1f(u[name], value); };
    const pair = (name: string, a: number, b: number, integer = false) => {
      if (u[name] !== undefined) gl[integer ? 'uniform2i' : 'uniform2f'](u[name], a, b);
    };
    pair('u_originInt', Math.floor(x), Math.floor(y), true);
    pair('u_originFrac', x - Math.floor(x), y - Math.floor(y));
    pair('u_screenSize', view.width, view.height);
    pair('u_vpOrigin', -(view.sampleOffsetX ?? 0), view.sampleOffsetY ?? 0, true);
    f('u_invZoom', 1 / view.camZ); f('u_surfacePhase', this.surfacePhase);
    i('u_mapWidth', this.mapWidth); i('u_worldWidth', this.mapWidth * 512);
    i('u_worldSizeX', this.worldSizeX); i('u_centerPx', this.centerPx); i('u_baseY', 7168); i('u_maxRow', 47);
    i('u_verticalPlane', this.plane); i('u_liquidRow', this.liquidRow);
    i('u_edgeNoise', +!!view.edgeNoise); i('u_matDetail', +!!view.materialTextures);
    i('u_engineTerrain', +engine); i('u_materialIdOut', +(!!view.materialIdOut && !probe));
    i('u_nativeProbe', +probe);
  }

  render(view: any): any {
    if (!this.ready || view.width <= 0 || view.height <= 0) return null;
    const gl = this.gl, { width, height } = view;
    if (width > gl.getParameter(gl.MAX_TEXTURE_SIZE) || height > gl.getParameter(gl.MAX_TEXTURE_SIZE))
      throw Error('Native terrain rectangle exceeds texture capacity');
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
    const engine = !!view.engineTerrain && this.engineReady;
    try {
      gl.disable(gl.SCISSOR_TEST);
      gl.viewport(0, 0, width, height);
      this.raw = this.target(this.raw, width, height);
      if (engine) for (const program of this.programs.slice(0, 2)) {
        const bounds = this.materialScissor(view, program.name === 'topology0' ? 0 : 1);
        if (!bounds) continue;
        gl.enable(gl.SCISSOR_TEST); gl.scissor(...bounds);
        this.bind(program, view, false, engine); gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
      gl.disable(gl.SCISSOR_TEST);
      this.probes = this.target(this.probes, width, height);
      const probe = engine && this.liquidRow > 0 && !view.materialIdOut ? this.probeScissor(view) : undefined;
      if (probe) {
        gl.enable(gl.SCISSOR_TEST); gl.scissor(...probe);
        for (const program of this.programs.slice(0, 2)) {
          this.bind(program, view, true, engine); gl.drawArrays(gl.TRIANGLES, 0, 3);
        }
        gl.disable(gl.SCISSOR_TEST);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      this.bind(this.programs[2], view, false, engine);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      return this.canvas;
    } finally { gl.disable(gl.SCISSOR_TEST); gl.bindFramebuffer(gl.FRAMEBUFFER, null); }
  }

  invalidate(): void {
    for (const target of [this.raw, this.probes]) if (target) {
      this.gl.deleteFramebuffer(target.framebuffer); this.gl.deleteTexture(target.texture);
    }
    this.raw = this.probes = undefined;
    this.resources = undefined;
    this.textures = null;
    this.liquidProbeBounds = undefined;
    this.engineChunkModes = undefined;
  }

  dispose(): void {
    this.epoch++;
    this.invalidate();
    for (const program of this.programs) this.gl.deleteProgram(program.handle);
    this.programs = []; this.program = null;
  }
}
