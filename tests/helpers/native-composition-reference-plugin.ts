import type { Plugin } from "vite";

/** Test-only input capture. The oracle's finish implementation is unchanged.
 * Anchors fail closed when its preparation boundary changes. */
export function nativeCompositionReferencePlugin(): Plugin {
  const replace = (source: string, from: string, to: string) => {
    if (!source.includes(from))
      throw new Error(`Review composition capture anchor: ${from}`);
    return source.replace(from, to);
  };
  return {
    name: "native-composition-input-capture",
    enforce: "pre",
    transform(source, id) {
      const path = id.split("?")[0];
      if (path.endsWith("/cpu-terrain-core.ts"))
        source = replace(
          source,
          "    mapWidth,\n    centerPx,",
          "    __compositionFixture: { composition, readMaterials: materialCache.readRect },\n    mapWidth,\n    centerPx,",
        );
      if (path.endsWith("/terrain-composition.ts")) {
        source = replace(
          source,
          "  const scenes = gen.sceneData",
          "  let __airBackground: any = null;\n  const scenes = gen.sceneData",
        );
        source = replace(
          source,
          "await createTerrainScenes(gen.sceneData, (scene, x, y) => {",
          "await createTerrainScenes(gen.sceneData, __airBackground = (scene, x, y) => {",
        );
        source = replace(
          source,
          `  const water = createLiquidSurfacePainter(
    findLiquidSurfaces(
      lattice ?? edges.lattice,
      await loadLiquidMaterialIds(),
      width,
      offsetY,
    ),
    width * 512,
  );`,
          `  const __surfaces = findLiquidSurfaces(lattice ?? edges.lattice, await loadLiquidMaterialIds(), width, offsetY);
  const water = createLiquidSurfacePainter(__surfaces, width * 512);`,
        );
        source = replace(
          source,
          "    ownership,\n    backgroundAt,",
          "    __compositionFixture: { scenes, surfaces: __surfaces, airBackground: __airBackground, liquidColor },\n    ownership,\n    backgroundAt,",
        );
      }
      if (path.endsWith("/terrain-scenes.ts"))
        source = replace(
          source,
          "  return {\n    paintsAt",
          "  return {\n    __preparedScene: instance,\n    paintsAt",
        );
      return source;
    },
  };
}
