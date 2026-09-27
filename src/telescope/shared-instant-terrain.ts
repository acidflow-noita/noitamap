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
  createCoverageLatticeTexture,
  createEngineChunkTexture,
  createFillMaterialTexture,
  createFloatTableTexture,
  createForegroundTexture,
  createIndirectionTexture,
  createMaterialAtlasTexture,
  createMaterialLatticeTexture,
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

/** One context/program and one immutable source upload for all nine regions.
 * Only five map-sized textures vary by vertical plane. The shader still uses
 * absolute noise coordinates and the host's translated lattice address. */
export class SharedInstantTerrainResources {
  private textures = new Set<any>();
  private planes = new Map<VerticalPlane, PlaneResources>();
  private common: Record<string, any> | undefined;
  private plane: VerticalPlane = 0;
  private layers?: any[];
  private biomes?: any;
  private key?: string;
  private generatorConfig?: object;
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
      const atlas = getMaterialAtlas();
      if (!atlas) throw new Error("Shared terrain material atlas unavailable");
      const own = (texture: any) => {
        if (!texture)
          throw new Error("Shared terrain texture allocation failed");
        this.textures.add(texture);
        return texture;
      };
      this.common = {
        atlas: own(createRegionAtlasTexture(gl, resources.atlas)),
        regionMeta: own(createRegionMetaTexture(gl, resources.regions)),
        palette: own(createPaletteTexture(gl, resources.paletteLUT)),
        noise: own(createNoiseTexture(gl, buildNoiseTable512())),
        matAtlas: own(createMaterialAtlasTexture(gl, atlas)),
        matMeta: own(
          createMaterialMetaTexture(gl, atlas, buildMatColorTable(atlas)),
        ),
        palMat: own(
          createPaletteMaterialTexture(
            gl,
            buildPaletteMaterialTable(atlas, resources.palette),
          ),
        ),
        cov: own(createCoverageLatticeTexture(gl, engine.lattice)),
        latMat: own(createMaterialLatticeTexture(gl, engine.lattice)),
        engTable: own(
          createFloatTableTexture(gl, buildEngineTable(opts.seed ?? 0)),
        ),
        sinHash: own(
          createR32FTexture(gl, buildSinHashAndGrids(opts.seed ?? 0)),
        ),
      };
      this.commonUploads += Object.keys(this.common).length;
      this.latticeBytes =
        engine.lattice.cov.byteLength + engine.lattice.mat.byteLength;
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
        const chunks =
          plane === 0
            ? engine.chunk
            : buildPlaneEngineChunks(map.pixels, engine.lattice.chunkCovered);
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
            createEngineChunkTexture(gl, {
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
      if (epoch === this.epoch) this.invalidate();
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

  invalidate(): void {
    this.epoch++;
    for (const texture of this.textures)
      this.renderer.gl?.deleteTexture(texture);
    this.textures.clear();
    this.common = undefined;
    this.planes.clear();
    this.latticeBytes = 0;
    this.generatorConfig = undefined;
    this.layers = this.biomes = this.key = this.pending = undefined;
    // Upstream owns its framebuffer and remaining state, but must not delete
    // the selected plane/common texture handles a second time.
    this.renderer.textures = null;
    this.renderer.invalidate();
  }
}
