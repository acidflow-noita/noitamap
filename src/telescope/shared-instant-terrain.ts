import { buildTerrainResources } from "noita-telescope-full-pixels/gl/terrain_resources.js";
import {
  buildChunkIndirection,
  BIOME_MAP_HEIGHT,
} from "noita-telescope-full-pixels/gl/indirection.js";
import {
  buildChunkTextures,
  buildNoiseTable512,
} from "noita-telescope-full-pixels/gl/chunk_textures.js";
import {
  buildEngineResources,
  buildEngineTable,
  buildMatColorTable,
  buildSinHashAndGrids,
  surfaceNoisePhase,
  ENGINE_MODE_FALLBACK,
  ENGINE_MODE_TOPO0,
  ENGINE_MODE_TOPO2,
} from "noita-telescope-full-pixels/gl/engine_resources.js";
import { BIOME_ENGINE } from "noita-telescope-full-pixels/engine_resolve/engine_data.js";
import { FILL_LAYER_COLORS } from "noita-telescope-full-pixels/generator_config.js";
import {
  buildFillMaterialTable,
  buildPaletteMaterialTable,
  getMaterialAtlas,
  initMaterialAtlas,
} from "noita-telescope-full-pixels/gl/material_atlas.js";
import {
  createChunkTexture,
  createEngineChunkTexture,
  createFillMaterialTexture,
  createFloatTableTexture,
  createForegroundTexture,
  createIndirectionTexture,
  createMaterialAtlasTexture,
  createMaterialMetaTexture,
  createNoiseTexture,
  createPaletteMaterialTexture,
  createPaletteTexture,
  createR32FTexture,
  createRegionAtlasTexture,
  createRegionMetaTexture,
  maxTextureSize,
} from "noita-telescope-full-pixels/gl/textures.js";
import {
  getWorldCenter,
  getWorldSize,
} from "noita-telescope-full-pixels/utils.js";
import { prewarmTerrainShader } from "./terrain-shader-prewarm";
import { setTerrainPlane } from "./instant-terrain-plane";
import type { VerticalPlane } from "./terrain-policy";
import {
  packElevatorLattices,
  createElevatorChunkTexture,
  createPackedLatticeTextures,
} from "./instant-elevator-lattice";

const slotsByColor = new Map<number, number>(
  BIOME_ENGINE.map((biome: any, i: number) => [biome.color, i]),
);

/** The small half of upstream buildEngineResources. Coverage belongs to the
 * shared Wang lattice; biome selection belongs to the selected vertical map.
 * Keep flags identical to engine_resources.js, including empty/fill fallback. */
export function buildPlaneEngineChunks(
  pixels: Uint32Array,
  covered: Uint8Array,
): Uint16Array {
  const chunks = new Uint16Array(pixels.length);
  for (let i = 0; i < chunks.length; i++) {
    const color = pixels[i] & 0xffffff;
    const slot = slotsByColor.get(color);
    const biome = slot !== undefined ? BIOME_ENGINE[slot] : null;
    const empty =
      !!biome &&
      (biome.paintsNothing || (biome.topo === 0 && biome.bands.length === 0));
    const fill = empty && !biome.paintsNothing && FILL_LAYER_COLORS.has(color);
    let mode = ENGINE_MODE_FALLBACK;
    if (biome && biome.supported && !fill)
      mode =
        biome.topo === 2
          ? covered[i]
            ? ENGINE_MODE_TOPO2
            : ENGINE_MODE_FALLBACK
          : ENGINE_MODE_TOPO0;
    chunks[i] =
      (slot ?? 0) |
      (mode << 8) |
      (biome && biome.noiseBiomeEdges ? 1 << 10 : 0) |
      (empty && !fill ? 1 << 11 : 0);
  }
  return chunks;
}

type PlaneResources = { textures: Record<string, any>; chunks: Uint16Array };
type ImmutableResources = {
  gl: any;
  atlas: any;
  textures: Record<string, any>;
};

/** One context/program and one source upload for all nine regions. Fixed
 * material/noise textures also survive seed changes. Only five map-sized
 * textures vary by vertical plane; shader noise still uses absolute coords. */
export class SharedInstantTerrainResources {
  private textures = new Set<any>();
  private textureGL: any;
  private immutable?: ImmutableResources;
  private contextCanvas?: EventTarget;
  private disposed = false;
  private readonly contextLost = () => {
    this.invalidate();
    this.releaseImmutableTextures();
  };
  private planes = new Map<VerticalPlane, PlaneResources>();
  private common: Record<string, any> | undefined;
  private plane: VerticalPlane = 0;
  private layers?: any[];
  private biomes?: any;
  private key?: string;
  private generatorConfig?: object;
  private shafts?: any[];
  private epoch = 0;
  private pending?: Promise<boolean>;
  private builds = 0;
  private commonUploads = 0;
  private planeUploads = 0;
  private latticeBytes = 0;
  constructor(readonly renderer: any) {
    // Taking over an already initialized renderer must release its previous
    // source textures too; shader-only prewarming normally leaves this empty.
    for (const texture of Object.values(renderer.textures ?? {}))
      if (texture) this.textures.add(texture);
    this.textureGL = renderer.gl;
  }

  get stats() {
    return {
      resourceBuilds: this.builds,
      commonTextureUploads: this.commonUploads,
      planeTextureUploads: this.planeUploads,
      planeCount: this.planes.size,
      latticeBytes: this.latticeBytes,
    };
  }

  ensureResources(
    layers: any[],
    biomeData: any,
    opts: any = {},
  ): Promise<boolean> {
    if (this.disposed)
      return Promise.reject(
        new DOMException("Terrain resources disposed", "AbortError"),
      );
    const key = JSON.stringify([
      opts.isNGP ?? false,
      opts.gameMode ?? "normal",
      opts.seed ?? 0,
      opts.lut,
    ]);
    if (
      this.layers === layers &&
      this.biomes === biomeData &&
      this.key === key &&
      this.generatorConfig === opts.generatorConfig &&
      this.shafts === opts.elevatorShafts &&
      this.pending &&
      !this.renderer.contextLost &&
      (this.planes.size === 0 || this.renderer.engineReady)
    )
      return this.pending;
    this.invalidate();
    this.layers = layers;
    this.biomes = biomeData;
    this.key = key;
    this.generatorConfig = opts.generatorConfig;
    this.shafts = opts.elevatorShafts;
    const epoch = this.epoch;
    const current = () => {
      opts.checkCurrent?.();
      if (epoch !== this.epoch)
        throw new DOMException("Obsolete terrain resources", "AbortError");
      if (this.renderer.contextLost || this.renderer.gl?.isContextLost?.())
        throw new Error("Shared terrain context lost");
    };
    const ready = (async () => {
      current();
      await Promise.all([
        initMaterialAtlas(),
        prewarmTerrainShader(this.renderer),
      ]);
      current();
      const started = performance.now();
      const renderer = this.renderer,
        gl = renderer.gl;
      this.watchContext();
      this.textureGL = gl;
      const isNGP = opts.isNGP ?? false,
        gameMode = opts.gameMode ?? "normal";
      const width = getWorldSize(isNGP, gameMode);
      const resources = buildTerrainResources(layers, biomeData, {
        isNGP,
        gameMode,
        maxTextureSize: maxTextureSize(gl),
        lut: opts.lut,
      });
      const engine = buildEngineResources(
        layers,
        biomeData,
        opts.generatorConfig ?? {},
        width,
      );
      const elevators = packElevatorLattices(
        engine.lattice,
        opts.elevatorShafts ?? [],
        opts.generatorConfig ?? {},
        maxTextureSize(gl),
      );
      const atlas = getMaterialAtlas();
      if (!atlas) throw new Error("Shared terrain material atlas unavailable");
      const immutable = this.prepareImmutableTextures(gl, atlas);
      const own = (texture: any) => {
        if (!texture)
          throw new Error("Shared terrain texture allocation failed");
        this.textures.add(texture);
        return texture;
      };
      const lattices = createPackedLatticeTextures(gl, elevators);
      own(lattices.cov);
      own(lattices.mat);
      this.common = {
        atlas: own(createRegionAtlasTexture(gl, resources.atlas)),
        regionMeta: own(createRegionMetaTexture(gl, resources.regions)),
        palette: own(createPaletteTexture(gl, resources.paletteLUT)),
        ...immutable,
        palMat: own(
          createPaletteMaterialTexture(
            gl,
            buildPaletteMaterialTable(atlas, resources.palette),
          ),
        ),
        cov: lattices.cov,
        latMat: lattices.mat,
        engTable: own(
          createFloatTableTexture(gl, buildEngineTable(opts.seed ?? 0)),
        ),
        sinHash: own(
          createR32FTexture(gl, buildSinHashAndGrids(opts.seed ?? 0)),
        ),
      };
      this.commonUploads +=
        Object.keys(this.common).length - Object.keys(immutable).length;
      this.latticeBytes = elevators.lattice.GW * elevators.lattice.GH * 6;
      for (const plane of [0, -1, 1] as VerticalPlane[]) {
        let map = biomeData;
        if (plane !== 0) {
          const pixels = new Uint32Array(width * BIOME_MAP_HEIGHT);
          const row = plane < 0 ? 0 : BIOME_MAP_HEIGHT - 1;
          for (let y = 0; y < BIOME_MAP_HEIGHT; y++)
            pixels.set(
              biomeData.pixels.subarray(row * width, (row + 1) * width),
              y * width,
            );
          map = { pixels };
        }
        const covered = engine.lattice.chunkCovered.slice();
        if (plane === 1)
          for (const region of elevators.regions)
            for (let y = 0; y < BIOME_MAP_HEIGHT; y++)
              covered[y * width + region.column] = 1;
        const chunks =
          plane === 0
            ? engine.chunk
            : buildPlaneEngineChunks(map.pixels, covered);
        const legacy = buildChunkTextures(map, width);
        const indirection =
          plane === 0
            ? resources.indirection
            : buildChunkIndirection(map, layers, resources.regions, {
                isNGP,
                gameMode,
              });
        const textures = {
          indirection: own(createIndirectionTexture(gl, indirection)),
          chunk: own(createChunkTexture(gl, legacy)),
          fg: own(createForegroundTexture(gl, legacy)),
          fgMat: own(
            createFillMaterialTexture(
              gl,
              buildFillMaterialTable(atlas, map, width),
              width,
            ),
          ),
          engChunk: own(
            plane === 1 && elevators.regions.length
              ? createElevatorChunkTexture(gl, chunks, width, elevators.regions)
              : createEngineChunkTexture(gl, {
                  chunk: chunks,
                  width,
                  height: BIOME_MAP_HEIGHT,
                }),
          ),
        };
        this.planeUploads += Object.keys(textures).length;
        this.planes.set(plane, {
          textures: { ...this.common, ...textures },
          chunks,
        });
      }
      renderer.resources = resources;
      renderer.mapWidth = width;
      renderer.centerPx = 512 * getWorldCenter(isNGP, gameMode);
      renderer.worldSizeX =
        isNGP || gameMode === "nightmare" ? 64 * 512 - 8 : 70 * 512;
      renderer.surfacePhase = surfaceNoisePhase(opts.seed ?? 0);
      renderer.stats = resources.stats;
      renderer.failed = null;
      this.setPlane(0);
      if (!renderer.engineReady || gl.getError())
        throw new Error("Shared terrain resources unavailable");
      renderer.buildMs = performance.now() - started;
      this.builds++;
      return true;
    })().catch((error) => {
      if (epoch === this.epoch) {
        this.invalidate();
        // A failed allocation/upload must never leave a partially initialized
        // immutable texture cached for the next generation.
        this.releaseImmutableTextures();
      }
      throw error;
    });
    this.pending = ready;
    return ready;
  }

  setPlane(plane: VerticalPlane): void {
    const resources = this.planes.get(plane);
    if (!resources || !this.common)
      throw new Error("Shared terrain plane is not prepared");
    if (this.renderer.contextLost || this.renderer.gl?.isContextLost?.())
      throw new Error("Shared terrain context lost");
    this.plane = plane;
    this.renderer.textures = resources.textures;
    this.renderer.engineChunkModes = resources.chunks;
    this.renderer.engineChunkWidth = this.renderer.mapWidth;
    setTerrainPlane(this.renderer, plane);
  }

  render(view: any) {
    // Selection and the actual draw are synchronous; another queued request
    // cannot change this plane between binding and submission.
    this.setPlane(this.plane);
    return this.renderer.render(view);
  }

  private watchContext(): void {
    const canvas = this.renderer.canvas;
    if (canvas === this.contextCanvas) return;
    this.contextCanvas?.removeEventListener("webglcontextlost", this.contextLost);
    this.contextCanvas = canvas;
    this.contextCanvas?.addEventListener("webglcontextlost", this.contextLost);
  }

  private prepareImmutableTextures(gl: any, atlas: any): Record<string, any> {
    if (
      this.immutable &&
      this.immutable.gl === gl &&
      this.immutable.atlas === atlas
    )
      return this.immutable.textures;
    this.releaseImmutableTextures();
    const textures: Record<string, any> = {};
    // The material art/metadata and fixed edge-noise permutations are shared
    // across seeds. Region atlases, palettes, lattices and seed noise are not.
    // Record each handle immediately so a later failed upload can release it.
    this.immutable = { gl, atlas, textures };
    const own = (name: string, texture: any) => {
      if (!texture) throw new Error("Shared terrain texture allocation failed");
      textures[name] = texture;
      this.commonUploads++;
    };
    own("noise", createNoiseTexture(gl, buildNoiseTable512()));
    own("matAtlas", createMaterialAtlasTexture(gl, atlas));
    own("matMeta", createMaterialMetaTexture(gl, atlas, buildMatColorTable(atlas)));
    return textures;
  }

  private releaseImmutableTextures(): void {
    if (!this.immutable) return;
    for (const texture of Object.values(this.immutable.textures))
      this.immutable.gl.deleteTexture(texture);
    this.immutable = undefined;
  }

  /** Release generation-specific resources, retaining three fixed textures for
   * the next seed on this context. dispose() releases the complete owner. */
  invalidate(): void {
    this.epoch++;
    for (const texture of this.textures)
      this.textureGL?.deleteTexture(texture);
    this.textures.clear();
    this.textureGL = undefined;
    this.common = undefined;
    this.planes.clear();
    this.latticeBytes = 0;
    this.generatorConfig = undefined;
    this.shafts = undefined;
    this.layers = this.biomes = this.key = this.pending = undefined;
    // Upstream owns its framebuffer and remaining state, but must not delete
    // the selected plane/common texture handles a second time.
    this.renderer.textures = null;
    this.renderer.invalidate();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.invalidate();
    this.releaseImmutableTextures();
    this.contextCanvas?.removeEventListener("webglcontextlost", this.contextLost);
    this.contextCanvas = undefined;
  }
}
