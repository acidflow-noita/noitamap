import {
  CookedMapBuilder,
  SharedPixelStore,
  type CookedMapManifest,
  type PixelStoreBaseline,
} from "../cooked-pixels";
import type {
  CompletePageAddress,
  CompleteWorldSource,
} from "../complete-world";
import { cookCheckpoints } from "./scheduling";

export interface CookTerrainOptions {
  readonly baseline?: PixelStoreBaseline;
  readonly preparedRevision?: string;
  /** Selected final pixels must belong to this exact cave-state digest too. */
  readonly preparedGenerationStateDigest?: string | null;
  /** Already-selected final page roots belonging to the frozen baseline. This
   * API accepts data, not a callback that could hide scalar rasterization.
   * Selection must account for every input to the completed-page recipe. */
  readonly preparedPages?: readonly {
    address: CompletePageAddress;
    root: number;
  }[];
  /** Explicit reference work budget, never an implicit procedural fallback.
   * Zero is the admission test for a fully prepared new-seed path. */
  readonly maxReferencePixels: number;
  readonly signal?: AbortSignal;
  readonly yieldControl?: () => Promise<void>;
  readonly onProgress?: (progress: Readonly<TerrainCookProgress>) => void;
}
export interface TerrainCookProgress {
  readonly phase: "selection" | "composition" | "mips" | "complete";
  readonly totalPages: number;
  readonly selectedPages: number;
  readonly committedPages: number;
  readonly preparedPages: number;
  readonly referencePages: number;
}
export class UnpreparedWorldError extends Error {
  constructor(
    readonly missingPages: number,
    readonly requiredPixels: number,
    readonly budgetPixels: number,
  ) {
    super(
      `Prepared world is incomplete: ${missingPages} pages need ${requiredPixels} reference pixels (budget ${budgetPixels})`,
    );
    this.name = "UnpreparedWorldError";
  }
}

/** All-page owner for the independent native terrain/scenes layer. Static
 * captures and POI presentation are separate site layers, explicitly outside
 * this return type. Nothing from a partial cook can become a tile source.
 * A reference bake proves correctness; it is not the prepared fast path. */
export async function cookTerrainSceneLayer(
  source: CompleteWorldSource,
  options: CookTerrainOptions,
) {
  if (source.scope !== "terrain-scenes-layer")
    throw new Error("Unrecognized native world pixel contract");
  if (
    !Number.isSafeInteger(options.maxReferencePixels) ||
    options.maxReferencePixels < 0
  )
    throw new RangeError(
      "An explicit nonnegative reference pixel budget is required",
    );
  if (
    (options.baseline || options.preparedPages) &&
    options.preparedRevision !== source.revision
  )
    throw new Error("Prepared pixels and native source revisions differ");
  if (options.preparedPages && !options.baseline)
    throw new Error("Prepared pages require their frozen pixel library");
  if (options.preparedPages && (options.preparedGenerationStateDigest ?? null) !== source.generationStateDigest)
    throw new Error("Prepared pixels and native cave-state identities differ");
  const check = () => options.signal?.throwIfAborted();
  const checkpoints = cookCheckpoints(options.signal, options.yieldControl);
  check();
  if (
    source.regions.length !== 9 ||
    source.regions.some(
      (r) =>
        ![-1, 0, 1].includes(r.horizontal) || ![-1, 0, 1].includes(r.vertical),
    ) ||
    new Set(source.regions.map((r) => `${r.horizontal}/${r.vertical}`)).size !==
      9
  )
    throw new Error("Native map admission requires all nine regions");
  const first = source.regions[0];
  if (
    !first ||
    source.regions.some(
      (r) =>
        r.width !== first.width ||
        r.height !== first.height ||
        r.columns !== first.columns ||
        r.rows !== first.rows ||
        r.width !== r.columns * source.pageSize ||
        r.height !== r.rows * source.pageSize,
    )
  )
    throw new Error(
      "Cooked page storage requires complete aligned physical regions",
    );
  const manifest: CookedMapManifest = {
    pageSize: source.pageSize,
    regionColumns: first.columns,
    regionRows: first.rows,
    regions: source.regions.map((r) => ({
      horizontal: r.horizontal,
      vertical: r.vertical,
    })),
    origin: {
      x: Math.min(...source.regions.map((r) => r.x)),
      y: Math.min(...source.regions.map((r) => r.y)),
    },
  };
  const minX = Math.min(...manifest.regions.map((r) => r.horizontal)),
    minY = Math.min(...manifest.regions.map((r) => r.vertical));
  for (const r of source.regions)
    if (
      r.x !== manifest.origin.x + (r.horizontal - minX) * r.width ||
      r.y !== manifest.origin.y + (r.vertical - minY) * r.height
    )
      throw new Error("Physical world regions have a gap or overlap");
  const baseline =
    options.baseline ??
    new SharedPixelStore({ pageSize: source.pageSize }).freezePreparation();
  const store = baseline.fork();
  const builder = new CookedMapBuilder(store, manifest);
  const addressKey = (a: CompletePageAddress) =>
    `${a.horizontal}/${a.vertical}/${a.column}/${a.row}`;
  const preparedPages = new Map<string, number>();
  for (const selected of options.preparedPages ?? []) {
    const key = addressKey(selected.address);
    if (preparedPages.has(key))
      throw new Error("Duplicate prepared page selection");
    baseline.inspectNode(selected.root, source.pageSize);
    preparedPages.set(key, selected.root);
  }
  const addresses: CompletePageAddress[] = [],
    roots: number[] = [],
    seen = new Set<string>();
  let referencePages = 0,
    committedPages = 0;
  const report = (phase: TerrainCookProgress["phase"]) =>
    options.onProgress?.(
      Object.freeze({
        phase,
        totalPages: builder.expectedPages,
        selectedPages: addresses.length,
        committedPages,
        preparedPages: addresses.length - referencePages,
        referencePages,
      }),
    );
  // Inspect every address and the residual budget before spending time on any
  // scalar page. A library with poor coverage must not silently turn into a bake.
  for (const address of source.pageAddresses()) {
    check();
    const id = addressKey(address);
    const region = source.regions.find(
      (r) =>
        r.horizontal === address.horizontal && r.vertical === address.vertical,
    );
    if (
      !region ||
      !Number.isInteger(address.column) ||
      !Number.isInteger(address.row) ||
      address.column < 0 ||
      address.row < 0 ||
      address.column >= region.columns ||
      address.row >= region.rows ||
      seen.has(id)
    )
      throw new Error("Duplicate or invalid native page address");
    seen.add(id);
    const root = preparedPages.get(id);
    check();
    if (root === undefined) referencePages++;
    addresses.push({ ...address });
    roots.push(root ?? 0);
    if (checkpoints.due()) {
      report("selection");
      await checkpoints.pause();
    }
  }
  if (addresses.length !== builder.expectedPages)
    throw new Error("Native source omitted required world pages");
  if ([...preparedPages.keys()].some((id) => !seen.has(id)))
    throw new Error("Prepared selection lies outside this native world");
  const referencePixels = referencePages * source.pageSize ** 2;
  if (referencePixels > options.maxReferencePixels)
    throw new UnpreparedWorldError(
      referencePages,
      referencePixels,
      options.maxReferencePixels,
    );
  report("composition");
  for (let i = 0; i < addresses.length; i++) {
    check();
    const a = addresses[i];
    let root = roots[i];
    if (!root) {
      const page = await source.renderPage(a, options.signal);
      check();
      const r = source.regions.find(
        (r) => r.horizontal === a.horizontal && r.vertical === a.vertical,
      )!;
      if (
        page.horizontal !== a.horizontal ||
        page.vertical !== a.vertical ||
        page.width !== source.pageSize ||
        page.height !== source.pageSize ||
        page.x !== r.x + a.column * source.pageSize ||
        page.y !== r.y + a.row * source.pageSize
      )
        throw new Error("Native source returned a different page");
      root = store.addBlock(page.pixels, source.pageSize);
    }
    builder.put(a, a.column, a.row, store.commitPage(root));
    committedPages++;
    if (checkpoints.due()) {
      report("composition");
      await checkpoints.pause();
    }
  }
  check();
  report("mips");
  const map = builder.seal();
  check();
  report("complete");
  return Object.freeze({
    kind: "cooked-terrain-scenes-layer" as const,
    seed: source.seed,
    revision: source.revision,
    generationStateDigest: source.generationStateDigest,
    map,
    preparedPages: addresses.length - referencePages,
    referencePages,
    referencePixels,
  });
}
