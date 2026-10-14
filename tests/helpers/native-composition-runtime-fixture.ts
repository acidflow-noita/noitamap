import { setFullPixelTerrainForBake } from "../../src/renderer_settings";
import { generateDynamicMap } from "../../src/telescope/telescope-adapter";
import { prepareTerrainPlane } from "../../src/telescope/terrain-planes";
// @ts-expect-error Test-only query selects the independent JS stamper.
import { createCpuTerrain as createReference } from "../../src/telescope/cpu-terrain-core?edge-reference";
import { sceneMaterialGrid } from "../../src/telescope/scene-material-grid";
import {
  createPageComposer,
  createNativeScenePreparer,
  createSceneSourceLoader,
  createWorldCompositionResources,
  type PreparedScene,
} from "../../src/native-map/composition";
import edgeModuleUrl from "../../src/native-map/edges/core.wasm?url";
import { createCompleteMaterialResolver } from "../../src/native-map/complete-materials";
import {
  loadMaterialAtlas,
  materialRGBA,
} from "../../src/native-map/cook-inputs/atlas";
import { prepareWorldMaterialInputs } from "../../src/native-map/cook-inputs/materials";
import {
  BIOME_ENGINE as NATIVE_BIOMES,
  MATERIAL_NAMES_BY_ID,
  WANG_COLOR_TO_ID,
} from "../../src/native-map/complete-materials/engine-data.mjs";
import {
  GENERATOR_CONFIG,
  FILL_BIOME_MATERIALS,
  FILL_LAYER_MATERIALS,
} from "../../src/native-map/rules/generator_config.js";
import {
  BIOME_BACKGROUND_COLORS,
  TILE_OVERLAY_COLORS,
} from "../../lib/noita-telescope-vm/js/image_processing.js";
import materialModuleUrl from "../../src/native-map/complete-materials/complete-materials.wasm?url";
import materialAtlasJsonUrl from "../../lib/noita-telescope-vm/data/material_atlas.json?url";
import materialAtlasUrl from "../../lib/noita-telescope-vm/data/material_atlas.bin?url";
import materialDataUrl from "../../lib/noita-telescope-vm/data/material_data.json?url";
import type { NativeAssets } from "../../src/native-map/asset-host";

export async function verifyNativeComposition(sourceAssets: NativeAssets) {
  setFullPixelTerrainForBake(true);
  const module = await (await fetch(edgeModuleUrl)).arrayBuffer();
  const seed = 1337;
  const generation = await generateDynamicMap({
    seed,
    ngPlus: 0,
    parallelWorlds: [-1, 0, 1],
    unlocks: null,
  });
  (globalThis as any).OpenSeadragon = (await import("openseadragon")).default;
  const { prepareTerrainSceneData } =
    await import("../../src/telescope/telescope-osd-bridge");
  const sceneData = await prepareTerrainSceneData(generation);
  const lowerPlane = await prepareTerrainPlane(generation, 1);
  const world = {
    ...generation,
    gameMode: "normal" as const,
    elevatorShafts: lowerPlane.elevatorShafts ?? [],
  };
  const materials = prepareWorldMaterialInputs(world, {
    generatorConfig: GENERATOR_CONFIG,
    emptyTopology0: "legacy-fill",
  });
  const worldResources = await createWorldCompositionResources(
    world,
    materials,
    sourceAssets,
    { edgeModule: module, scenes: sceneData.scenes },
  );
  const edgeStamper = worldResources.edgeStamper;
  for (const [actual, expected, label] of [
    [
      worldResources.biomeBackgroundColors,
      BIOME_BACKGROUND_COLORS,
      "background",
    ],
    [worldResources.biomeForegroundColors, TILE_OVERLAY_COLORS, "foreground"],
  ] as const) {
    const a = actual as Record<string, number>,
      b = expected as Record<string, number>;
    const differences = [
      ...new Set([...Object.keys(a), ...Object.keys(b)]),
    ].filter((key) => a[key] !== b[key]);
    if (differences.length)
      throw new Error(
        `Owned named scene ${label} colors differ: ${JSON.stringify(differences.slice(0, 8).map((key) => [key, a[key], b[key]]))}`,
      );
  }
  const sourceLoader = await createSceneSourceLoader(sourceAssets);
  const materialAssets: Record<string, string> = {
    "data/material_atlas.json": materialAtlasJsonUrl,
    "data/material_atlas.bin": materialAtlasUrl,
    "data/material_data.json": materialDataUrl,
  };
  const materialAtlas = await loadMaterialAtlas({
    revision: "scene-parity",
    async read(path) {
      if (!materialAssets[path])
        throw new Error(`Unspecified scene test asset ${path}`);
      return new Uint8Array(
        await (await fetch(materialAssets[path])).arrayBuffer(),
      );
    },
  });
  const bands = await createCompleteMaterialResolver(
    {
      seed,
      mapWidth: 70,
      plane: { offsetY: 0 },
      lattice: {
        GW: 1,
        GH: 1,
        cov: new Float32Array([1]),
        mat: new Uint16Array([1]),
        chunkCovered: new Uint8Array(70 * 48),
      },
      biomePixels: new Uint32Array(70 * 48),
      hostChunks: new Uint32Array(70 * 48),
      parameters: [],
    },
    await WebAssembly.compile(
      await (await fetch(materialModuleUrl)).arrayBuffer(),
    ),
    { maxWidth: 1, maxHeight: 1 },
  );
  const prepareScene = createNativeScenePreparer({
    atlas: materialAtlas,
    generatorConfig: GENERATOR_CONFIG,
    engineBiomes: NATIVE_BIOMES,
    materialNames: MATERIAL_NAMES_BY_ID,
    wangMaterialIds: WANG_COLOR_TO_ID as [number, number][],
    fillBiomeMaterials: FILL_BIOME_MATERIALS as Record<number, string>,
    fillLayerMaterials: FILL_LAYER_MATERIALS as Record<number, string>,
    biomeBackgroundColors: worldResources.biomeBackgroundColors,
    biomeForegroundColors: worldResources.biomeForegroundColors,
    bands,
  });
  const sourceKeys = new Set<string>();
  const sceneStats = {
    instances: 0,
    comparedColorBytes: 0,
    comparedMaterialBytes: 0,
    comparedMaskBytes: 0,
    sourceBytes: 0,
    positionVariants: { key: "", instances: 0, distinct: 0 },
  };
  const checkBytes = (
    actual: Uint8Array | Uint8ClampedArray | Int16Array | null,
    expected: Uint8Array | Uint8ClampedArray | Int16Array | null,
    label: string,
  ) => {
    if (!actual || !expected) {
      if (actual !== expected) throw new Error(`${label}: null/array mismatch`);
      return 0;
    }
    if (actual.byteLength !== expected.byteLength)
      throw new Error(`${label}: byte length differs`);
    const a = new Uint8Array(
      actual.buffer,
      actual.byteOffset,
      actual.byteLength,
    );
    const b = new Uint8Array(
      expected.buffer,
      expected.byteOffset,
      expected.byteLength,
    );
    for (let p = 0; p < a.length; p++)
      if (a[p] !== b[p])
        throw new Error(`${label}: byte ${p}: ${a[p]} != ${b[p]}`);
    return a.length;
  };
  const samples = [];
  for (const plane of [0, -1, 1] as const) {
    const input = {
      ...(await prepareTerrainPlane(generation, plane)),
      sceneData,
    };
    const reference = await createReference(input, { nativeMaterials: false });
    const { composition, readMaterials } = reference.__compositionFixture;
    const fixture = composition.__compositionFixture;
    const owned = worldResources.forPlane(plane);
    checkBytes(
      owned.ownership.owners,
      composition.ownership.owners,
      `plane ${plane} ownership`,
    );
    if (
      JSON.stringify(owned.ownership.names) !==
      JSON.stringify(composition.ownership.names)
    )
      throw new Error("Owned terrain names differ");
    if (
      JSON.stringify(owned.liquidSurfaces) !== JSON.stringify(fixture.surfaces)
    )
      throw new Error(`Owned liquid runs differ in plane ${plane}`);
    const prepareAndCheck = async (id: number) => {
      const scene = sceneData.scenes[id],
        source = sceneData.sources[scene.key];
      const loaded = await sourceLoader.load(scene);
      if (!sourceKeys.has(scene.key)) {
        sceneStats.sourceBytes += checkBytes(
          loaded.data,
          source.data,
          `${scene.key} source instructions`,
        );
        sceneStats.sourceBytes += checkBytes(
          loaded.visualArt?.data ?? null,
          source.visualArt?.data ?? null,
          `${scene.key} source visual art`,
        );
        sceneStats.sourceBytes += checkBytes(
          loaded.backgroundArt?.data ?? null,
          source.backgroundArt?.data ?? null,
          `${scene.key} source background art`,
        );
        if (
          loaded.width !== source.width ||
          loaded.height !== source.height ||
          loaded.skipEdgeTextures !== !!source.skipEdgeTextures
        )
          throw new Error(`${scene.key} source geometry/edge policy differs`);
        sourceKeys.add(scene.key);
      }
      const expected = fixture.scenes.__preparedScene(id),
        grid = sceneMaterialGrid(scene, source);
      const native = prepareScene(scene, loaded),
        label = `${scene.key} at ${scene.x},${scene.y}`;
      sceneStats.comparedColorBytes += checkBytes(
        native.pixels,
        expected.pixels,
        `${label} RGBA`,
      );
      sceneStats.comparedMaskBytes += checkBytes(
        native.eraseMask,
        expected.airMask,
        `${label} erase`,
      );
      sceneStats.comparedMaterialBytes += checkBytes(
        native.edge.grid,
        grid.grid,
        `${label} materials`,
      );
      sceneStats.comparedMaskBytes += checkBytes(
        native.edge.artMask ?? null,
        grid.artMask,
        `${label} art`,
      );
      if (native.edge.skipEdges !== grid.skipEdges)
        throw new Error(`${label} skipEdges differs`);
      for (let p = 0; p < source.width * source.height; p++)
        if (native.sourceAlpha[p] !== source.data[p * 4 + 3])
          throw new Error(`${label} original alpha differs`);
      sceneStats.instances++;
      return native;
    };
    if (plane === 0) {
      const groups = new Map<string, number[]>();
      sceneData.scenes.forEach((scene, id) => {
        const key = `${scene.key}|${scene.variantKey ?? ""}`,
          ids = groups.get(key) ?? [];
        ids.push(id);
        groups.set(key, ids);
      });
      const group = [...groups]
        .filter(
          ([key, ids]) => key.includes("vault/catwalk_01") && ids.length > 1,
        )
        .sort((a, b) => b[1].length - a[1].length)[0];
      if (!group)
        throw new Error("Fixture lost repeated placed catwalk variants");
      const hashes = new Set<number>();
      for (const id of group[1].slice(0, 20)) {
        const scene = await prepareAndCheck(id);
        let hash = 2166136261;
        for (const byte of scene.pixels)
          hash = Math.imul(hash ^ byte, 16777619) >>> 0;
        hashes.add(hash);
      }
      sceneStats.positionVariants = {
        key: group[0],
        instances: Math.min(20, group[1].length),
        distinct: hashes.size,
      };
    }
    const offsetY = plane * 24576,
      worldWidth = reference.mapWidth * 512;
    const ownsTerrain = owned.ownsTerrain;
    const areas: {
      name: string;
      x: number;
      y: number;
      pw: number;
      width: number;
      height: number;
    }[] = [-1, 0, 1].map((pw) => ({
      name: "region",
      pw,
      x: (plane === 0 ? -32 : -4032) + pw * worldWidth,
      y: offsetY + (plane === 0 ? 480 : 64),
      width: 512,
      height: 512,
    }));
    if (plane === 0) {
      areas.push({
        name: "vault",
        x: 0,
        y: 8704,
        pw: 0,
        width: 512,
        height: 512,
      });
      areas.push({
        name: "liquid-cave",
        x: -2560,
        y: 512,
        pw: 0,
        width: 512,
        height: 512,
      });
      const pool = fixture.surfaces.find(
        (s: any) =>
          s.right - s.left > 80 &&
          s.y > 0 &&
          s.y < 15000 &&
          Math.abs(s.left) < 16000 &&
          ownsTerrain((s.left + s.right) / 2, s.y),
      );
      if (!pool) throw new Error("Fixture lost its authored liquid pool");
      areas.push({
        name: "pool",
        x: Math.floor((pool.left + pool.right) / 2 / 512) * 512,
        y: Math.floor(pool.y / 512) * 512,
        pw: 0,
        width: 512,
        height: 512,
      });
      const scene = sceneData.scenes
        .filter(
          (s) =>
            s.x >= -8000 &&
            s.x < 8000 &&
            s.y > 0 &&
            s.y < 16000 &&
            ownsTerrain(s.x, s.y),
        )
        .sort(
          (a, b) =>
            +!!sceneData.sources[b.key].backgroundArt -
              +!!sceneData.sources[a.key].backgroundArt ||
            b.width * b.height - a.width * a.height,
        )[0];
      if (!scene) throw new Error("Fixture lost its scene-rich page");
      areas.push({
        name: "scene",
        x: Math.floor(scene.x / 512) * 512,
        y: Math.floor(scene.y / 512) * 512,
        pw: 0,
        width: 512,
        height: 512,
      });
      areas.push({
        name: "partial-scene",
        x: scene.x - 32,
        y: scene.y - 32,
        pw: 0,
        width: 131,
        height: 129,
      });
      const mask = sceneData.staticMasks?.find(
        (m) =>
          m.x >= -17000 &&
          m.x < 17000 &&
          m.y > 0 &&
          m.y < 16000 &&
          [m.x, m.x + m.width - 1].some((x) =>
            [m.y, m.y + m.height - 1].some((y) => ownsTerrain(x, y)),
          ),
      );
      if (!mask) throw new Error("Fixture lost its static-mask overlap");
      areas.push({
        name: "static-mask",
        x: Math.floor(mask.x / 512) * 512,
        y: Math.floor(mask.y / 512) * 512,
        pw: 0,
        width: 512,
        height: 512,
      });
    }
    if (plane === 1) {
      const shaft = input.elevatorShafts?.[0];
      if (!shaft) throw new Error("Fixture lost its continued elevator shaft");
      areas.push({
        name: "shaft",
        x: shaft.minX * 512 - reference.centerPx,
        y: offsetY + 1024,
        pw: 0,
        width: 512,
        height: 512,
      });
    }
    for (const area of areas) {
      if (!reference.contains(area.x, area.y, area.width, area.height))
        throw new Error(`Empty fixture ${area.name}`);
      const foreground = new Uint8ClampedArray(area.width * area.height * 4);
      reference.renderRows(
        area.x,
        area.y,
        area.width,
        0,
        area.height,
        foreground,
      );
      const expected = foreground.slice();
      reference.finish(expected, area.x, area.y, area.width, area.height);
      const scenes: PreparedScene[] = [];
      for (const [id, scene] of sceneData.scenes.entries()) {
        const source = sceneData.sources[scene.key];
        const right =
          scene.x + Math.max(scene.width, source.backgroundArt?.width ?? 0);
        const bottom =
          scene.y + Math.max(scene.height, source.backgroundArt?.height ?? 0);
        if (
          right < area.x - 32 ||
          bottom < area.y - 32 ||
          scene.x > area.x + area.width + 32 ||
          scene.y > area.y + area.height + 32
        )
          continue;
        const native = await prepareAndCheck(id);
        scenes.push(native);
      }
      const compose = createPageComposer({
        seed,
        worldWidth,
        scenes,
        staticMasks: sceneData.staticMasks ?? [],
        liquidSurfaces: owned.liquidSurfaces,
        materialAt: reference.materialAt,
        readMaterials,
        ownsTerrain,
        backgroundAt: owned.backgroundAt,
        liquidColor: (id, x, y) => materialRGBA(materialAtlas, id, x, y),
        sceneAirBackground: owned.sceneAirBackground,
        edgeStamper,
        chunkShiftX: owned.chunkShiftX,
        chunkShiftY: owned.chunkShiftY,
        skipSeamAt: owned.skipSeamAt,
      });
      const actual = compose({ ...area, foreground });
      let mismatchedBytes = 0,
        firstMismatch = -1;
      for (let i = 0; i < actual.length; i++)
        if (actual[i] !== expected[i]) {
          mismatchedBytes++;
          if (firstMismatch < 0) firstMismatch = i;
        }
      samples.push({
        ...area,
        plane,
        seed,
        scenes: scenes.length,
        comparedBytes: actual.byteLength,
        mismatchedBytes,
        firstMismatch,
      });
    }
  }
  return {
    samples,
    sceneStats: {
      ...sceneStats,
      sourceCount: sourceKeys.size,
      sourceCacheBytes: sourceLoader.cacheBytes,
    },
    edge: { stats: edgeStamper.stats, memoryBytes: edgeStamper.memoryBytes },
  };
}
