import { SharedPixelStore, type PixelStoreSnapshot } from "../cooked-pixels";
import {
  PreparedWorldCompiler,
  type ImageProgram,
  type PreparedWorldRecipe,
} from "./compiler";

/** Structured-clone representation. Source revision identifies rule/assets;
 * saving only a completed seed is deliberately a different format/API. */
export interface PreparedWorldArtifact {
  readonly format: "noitamap-prepared-world";
  readonly version: 1;
  readonly recipe: PreparedWorldRecipe;
  readonly pixels: PixelStoreSnapshot;
}

function dependencies(p: ImageProgram): readonly number[] {
  if (p.kind === "select") return p.choices;
  if (p.kind === "quad") return p.children;
  if (p.kind === "combine" || p.kind === "place")
    return [p.back, p.front, ...(p.mask === undefined ? [] : [p.mask])];
  return [];
}

export function exportPreparedWorld(
  compiler: PreparedWorldCompiler,
): PreparedWorldArtifact {
  const recipe = compiler.exportRecipe(),
    reachable = new Set<number>(),
    pending = recipe.pages.map((p) => p.program);
  while (pending.length) {
    const id = pending.pop()!;
    if (reachable.has(id)) continue;
    reachable.add(id);
    pending.push(...dependencies(recipe.programs[id - 1]));
  }
  const ordered = [...reachable].sort((a, b) => a - b),
    remap = new Map(ordered.map((old, i) => [old, i + 1]));
  const all = ordered.map((id) => recipe.programs[id - 1]);
  const constants = all.filter(
    (p): p is Extract<ImageProgram, { kind: "prepared" }> =>
      p.kind === "prepared",
  );
  // All prepared page mips belong in the durable library. A restored session can
  // select a page without recomputing any of those reductions.
  const store = compiler.baseline.fork();
  const pages = constants
    .filter((p) => p.side === store.pageSize)
    .map((p) => store.commitPage(p.pixels));
  const selection = store.exportBlocks(
    constants.map((p) => ({ root: p.pixels, side: p.side })),
    pages,
  );
  let constant = 0;
  const ref = (id: number) => remap.get(id)!;
  const programs = all.map((p) => {
    if (p.kind === "prepared") {
      const image = selection.store.images[selection.imageRefs[constant++] - 1];
      return { ...p, pixels: image.root };
    }
    if (p.kind === "select") return { ...p, choices: p.choices.map(ref) };
    if (p.kind === "quad")
      return {
        ...p,
        children: p.children.map(ref) as [number, number, number, number],
      };
    if (p.kind === "combine" || p.kind === "place")
      return {
        ...p,
        back: ref(p.back),
        front: ref(p.front),
        ...(p.mask === undefined ? {} : { mask: ref(p.mask) }),
      };
    return p;
  });
  return {
    format: "noitamap-prepared-world",
    version: 1,
    pixels: selection.store,
    recipe: {
      ...recipe,
      programs,
      pages: recipe.pages.map((p) => ({ ...p, program: ref(p.program) })),
    },
  };
}

export function restorePreparedWorld(
  artifact: PreparedWorldArtifact,
  revision: string,
): PreparedWorldCompiler {
  if (
    artifact?.format !== "noitamap-prepared-world" ||
    artifact.version !== 1 ||
    artifact.recipe?.revision !== revision
  )
    throw new Error("Prepared world format or source revision changed");
  return new PreparedWorldCompiler(
    SharedPixelStore.fromSnapshot(artifact.pixels).freezePreparation(),
    artifact.recipe,
  );
}
