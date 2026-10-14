import {
  CookedMapBuilder,
  type SharedPixelStore,
  type PixelStoreBaseline,
  type CookedMapManifest,
  type PixelNodeId,
  type RegionCoordinate,
} from "../cooked-pixels";
import { FragmentComposer, type FragmentOperation } from "./fragments";
import { cookCheckpoints } from "./scheduling";

export type ImageProgram =
  | { kind: "prepared"; side: number; pixels: PixelNodeId }
  | { kind: "bound"; side: number; slot: number }
  | {
      kind: "select";
      side: number;
      selector: number;
      choices: readonly number[];
    }
  | {
      kind: "quad";
      side: number;
      children: readonly [number, number, number, number];
    }
  | {
      kind: "combine";
      side: number;
      back: number;
      front: number;
      operation: FragmentOperation;
      mask?: number;
    }
  | {
      kind: "place";
      side: number;
      back: number;
      front: number;
      x: number;
      y: number;
      operation: FragmentOperation;
      mask?: number;
    };

export interface PreparedWorldRecipe {
  readonly revision: string;
  readonly manifest: CookedMapManifest;
  /** One-based IDs. Dependencies must precede the program that uses them. */
  readonly programs: readonly ImageProgram[];
  readonly pages: readonly {
    region: RegionCoordinate;
    x: number;
    y: number;
    program: number;
  }[];
}
export interface WorldPixelBindings {
  readonly revision: string;
  /** All choices are current-seed decisions, finalized before compilation. */
  readonly selectors: Uint32Array;
  /** Resolved scene/edge/exception fragments. Zero is missing, never air. */
  readonly pixels: Uint32Array;
}
export type BindWorldPixels = (
  store: SharedPixelStore,
  signal?: AbortSignal,
) => WorldPixelBindings | Promise<WorldPixelBindings>;

/** Binds a prepared image program into a complete immutable map. No material,
 * noise, scene, RNG or fallback function can escape into the resulting decoder.
 * New seeds may share image fragments/compositions; this is not a seed cache. */
export class PreparedWorldCompiler {
  private readonly recipe: PreparedWorldRecipe;
  constructor(
    readonly baseline: PixelStoreBaseline,
    recipe: PreparedWorldRecipe,
  ) {
    if (!recipe.revision)
      throw new Error("Prepared world requires an artifact revision");
    this.recipe = structuredClone(recipe);
    const byId = (id: number, before: number) => {
      if (!Number.isSafeInteger(id) || id < 1 || id >= before)
        throw new Error(
          "Prepared world dependency is missing, forward or cyclic",
        );
      return this.recipe.programs[id - 1];
    };
    this.recipe.programs.forEach((p, index) => {
      if (!Number.isInteger(Math.log2(p.side)) || p.side < 1 || p.side > 32768)
        throw new Error("Invalid prepared fragment size");
      const reference = (id: number, side: number) => {
        if (byId(id, index + 1).side !== side)
          throw new Error("Prepared fragment dimensions differ");
      };
      if (p.kind === "prepared") baseline.inspectNode(p.pixels, p.side);
      else if (p.kind === "bound") {
        if (!Number.isSafeInteger(p.slot) || p.slot < 0)
          throw new Error("Invalid pixel binding");
      } else if (p.kind === "select") {
        if (
          !Number.isSafeInteger(p.selector) ||
          p.selector < 0 ||
          !p.choices.length
        )
          throw new Error("Invalid image selector");
        p.choices.forEach((id) => reference(id, p.side));
      } else if (p.kind === "quad") {
        if (p.children.length !== 4 || p.side < 2)
          throw new Error("Invalid image quadrants");
        p.children.forEach((id) => reference(id, p.side / 2));
      } else if (p.kind === "combine" || p.kind === "place") {
        reference(p.back, p.side);
        const front = byId(p.front, index + 1);
        if (p.kind === "combine") reference(p.front, p.side);
        else if (![p.x, p.y].every(Number.isSafeInteger))
          throw new Error("Unresolved image placement");
        if (
          !["replace", "over", "masked-replace", "masked-over"].includes(
            p.operation,
          )
        )
          throw new Error("Invalid fragment operation");
        if (p.operation.startsWith("masked-") !== (p.mask !== undefined))
          throw new Error("Missing fragment mask");
        if (p.mask !== undefined) reference(p.mask, front.side);
      } else throw new Error("Unresolved operation in prepared image program");
    });
    const store = baseline.fork();
    const admission = new CookedMapBuilder(store, this.recipe.manifest),
      seen = new Set<string>();
    const admissionPage = store.solidPage([0, 0, 0, 0]);
    for (const page of this.recipe.pages) {
      const key = `${page.region.horizontal}/${page.region.vertical}/${page.x}/${page.y}`;
      if (seen.has(key)) throw new Error("Duplicate prepared page");
      seen.add(key);
      const p = byId(page.program, this.recipe.programs.length + 1);
      if (p.side !== store.pageSize)
        throw new Error("Page program has wrong dimensions");
      // Validate exact region/page addressing before any seed is processed.
      admission.put(page.region, page.x, page.y, admissionPage);
    }
    if (admission.missingPages)
      throw new Error("Prepared recipe omits world pages");
  }

  async compile(
    input: WorldPixelBindings | BindWorldPixels,
    options: { signal?: AbortSignal; yieldControl?: () => Promise<void> } = {},
  ) {
    options.signal?.throwIfAborted();
    // Each seed owns its exceptions and compositions. Retaining an old map does
    // not make the next seed retain any old seed-specific images or memo tables.
    const store = this.baseline.fork(),
      fragments = new FragmentComposer(store);
    const bindings =
      typeof input === "function" ? await input(store, options.signal) : input;
    options.signal?.throwIfAborted();
    if (bindings.revision !== this.recipe.revision)
      throw new Error("Prepared image revision changed");
    if (
      !(bindings.selectors instanceof Uint32Array) ||
      !(bindings.pixels instanceof Uint32Array)
    )
      throw new TypeError("Image decisions must be finalized Uint32Arrays");
    // Snapshot choices once: concurrent seed requests cannot change a cook.
    const selectors = Uint32Array.from(bindings.selectors),
      pixels = Uint32Array.from(bindings.pixels);
    const resolved = new Uint32Array(this.recipe.programs.length + 1);
    const builder = new CookedMapBuilder(store, this.recipe.manifest);
    const checkpoints = cookCheckpoints(options.signal, options.yieldControl);
    let selectedPrograms = 0;
    const evaluate = async (id: number): Promise<number> => {
      // Ordered scene/edge programs may have thousands of successive writes.
      // Traverse that DAG explicitly instead of growing the JS call stack.
      const stack = [id];
      while (stack.length) {
        const at = stack[stack.length - 1];
        if (resolved[at]) {
          stack.pop();
          continue;
        }
        options.signal?.throwIfAborted();
        if (checkpoints.due()) await checkpoints.pause();
        const p = this.recipe.programs[at - 1];
        let dependencies: readonly number[] = [];
        if (p.kind === "select") {
          const choice = selectors[p.selector];
          if (choice === undefined || choice >= p.choices.length)
            throw new Error(`Unresolved selector ${p.selector}`);
          dependencies = [p.choices[choice]];
        } else if (p.kind === "quad") dependencies = p.children;
        else if (p.kind === "combine" || p.kind === "place")
          dependencies = [
            p.back,
            p.front,
            ...(p.mask === undefined ? [] : [p.mask]),
          ];
        const missing = dependencies.filter((ref) => !resolved[ref]);
        if (missing.length) {
          stack.push(...missing);
          continue;
        }
        let root: number;
        if (p.kind === "prepared") root = p.pixels;
        else if (p.kind === "bound") {
          root = pixels[p.slot];
          if (!root)
            throw new Error(`Unresolved final pixel binding ${p.slot}`);
          store.inspectNode(root, p.side);
        } else if (p.kind === "select") root = resolved[dependencies[0]];
        else if (p.kind === "quad")
          root = store.joinBlocks(
            p.side,
            p.children.map((ref) => resolved[ref]) as [
              number,
              number,
              number,
              number,
            ],
          );
        else if (p.kind === "combine")
          root = fragments.combine(
            resolved[p.back],
            resolved[p.front],
            p.side,
            p.operation,
            p.mask === undefined ? undefined : resolved[p.mask],
          );
        else
          root = fragments.place(
            resolved[p.back],
            p.side,
            resolved[p.front],
            this.recipe.programs[p.front - 1].side,
            p.x,
            p.y,
            p.operation,
            p.mask === undefined ? undefined : resolved[p.mask],
          );
        selectedPrograms++;
        resolved[at] = root;
        stack.pop();
      }
      return resolved[id];
    };
    for (let i = 0; i < this.recipe.pages.length; i++) {
      options.signal?.throwIfAborted();
      const page = this.recipe.pages[i];
      builder.put(
        page.region,
        page.x,
        page.y,
        store.commitPage(await evaluate(page.program)),
      );
      if (checkpoints.due()) await checkpoints.pause();
    }
    options.signal?.throwIfAborted();
    // Global mips must also finish before a map can leave this method.
    const map = builder.seal();
    return {
      map,
      selectedPrograms,
      pages: builder.completedPages,
      composition: { ...fragments.stats },
    };
  }

  /** Detached recipe for versioned storage; never exposes mutable compiler state. */
  exportRecipe(): PreparedWorldRecipe {
    return structuredClone(this.recipe);
  }
}
