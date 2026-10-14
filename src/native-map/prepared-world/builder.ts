import {
  SharedPixelStore,
  type CookedMapManifest,
  type PixelNodeId,
  type RegionCoordinate,
} from "../cooked-pixels";
import {
  PreparedWorldCompiler,
  type ImageProgram,
  type PreparedWorldRecipe,
} from "./compiler";
import { FragmentComposer, type FragmentOperation } from "./fragments";

type Quad = readonly [number, number, number, number];

/** One-time partial evaluation. Constant pixels and alternatives controlled by
 * the same selector are composed here. Independent decisions stay separate:
 * enumerating their Cartesian product could make a finite library enormous.
 */
export class PreparedWorldBuilder {
  private readonly programs: ImageProgram[] = [];
  private readonly intern = new Map<string, number>();
  private readonly pages: PreparedWorldRecipe["pages"][number][] = [];
  private readonly fragments: FragmentComposer;
  private sealed = false;
  readonly stats = { folded: 0, lifted: 0, deferred: 0 };

  constructor(
    readonly store: SharedPixelStore,
    readonly revision: string,
    readonly manifest: CookedMapManifest,
  ) {
    if (!revision || manifest.pageSize !== store.pageSize)
      throw new Error("Invalid preparation revision or page size");
    this.fragments = new FragmentComposer(store);
  }

  private add(p: ImageProgram): number {
    if (this.sealed) throw new Error("Preparation is already sealed");
    if (!Number.isInteger(Math.log2(p.side)) || p.side < 1 || p.side > 32768)
      throw new Error("Invalid prepared fragment size");
    const key = JSON.stringify(p),
      previous = this.intern.get(key);
    if (previous !== undefined) return previous;
    const id = this.programs.push(p);
    this.intern.set(key, id);
    return id;
  }
  private get(id: number): ImageProgram {
    if (!Number.isSafeInteger(id) || id < 1 || id > this.programs.length)
      throw new Error("Unknown prepared program");
    return this.programs[id - 1];
  }
  prepared(pixels: PixelNodeId, side: number): number {
    this.store.inspectNode(pixels, side);
    return this.add({ kind: "prepared", side, pixels });
  }
  bound(slot: number, side: number): number {
    if (!Number.isSafeInteger(slot) || slot < 0)
      throw new RangeError("Invalid final pixel binding");
    return this.add({ kind: "bound", side, slot });
  }
  select(selector: number, choices: readonly number[]): number {
    if (!Number.isSafeInteger(selector) || selector < 0 || choices.length === 0)
      throw new RangeError("Invalid selector");
    const side = this.get(choices[0]).side;
    if (choices.some((id) => this.get(id).side !== side))
      throw new Error("Choice dimensions differ");
    // Keep even identical alternatives: selecting out of range must still fail.
    return this.add({ kind: "select", side, selector, choices: [...choices] });
  }
  quad(children: Quad): number {
    if (children.length !== 4) throw new Error("Expected four image quadrants");
    const side = this.get(children[0]).side * 2;
    if (children.some((id) => this.get(id).side !== side / 2))
      throw new Error("Quadrant dimensions differ");
    return this.fold({ kind: "quad", side, children: [...children] });
  }
  combine(
    back: number,
    front: number,
    operation: FragmentOperation,
    mask?: number,
  ): number {
    const side = this.get(back).side;
    if (this.get(front).side !== side)
      throw new Error("Image dimensions differ");
    this.checkOperation(operation, front, mask);
    return this.fold({
      kind: "combine",
      side,
      back,
      front,
      operation,
      ...(mask === undefined ? {} : { mask }),
    });
  }
  place(
    back: number,
    front: number,
    x: number,
    y: number,
    operation: FragmentOperation,
    mask?: number,
  ): number {
    if (![x, y].every(Number.isSafeInteger))
      throw new Error("Image placement is unresolved");
    this.checkOperation(operation, front, mask);
    return this.fold({
      kind: "place",
      side: this.get(back).side,
      back,
      front,
      x,
      y,
      operation,
      ...(mask === undefined ? {} : { mask }),
    });
  }
  private checkOperation(
    operation: FragmentOperation,
    front: number,
    mask?: number,
  ) {
    if (
      !["replace", "over", "masked-replace", "masked-over"].includes(operation)
    )
      throw new Error("Invalid image operation");
    if (operation.startsWith("masked-") !== (mask !== undefined))
      throw new Error("Missing image mask");
    const side = this.get(front).side;
    if (mask !== undefined && this.get(mask).side !== side)
      throw new Error("Image mask dimensions differ");
  }
  private fold(
    p: Extract<ImageProgram, { kind: "quad" | "combine" | "place" }>,
  ): number {
    const refs =
      p.kind === "quad"
        ? p.children
        : [p.back, p.front, ...(p.mask === undefined ? [] : [p.mask])];
    const nodes = refs.map((id) => this.get(id));
    if (nodes.every((n) => n.kind === "prepared")) {
      const pixels = nodes.map(
        (n) => (n as Extract<ImageProgram, { kind: "prepared" }>).pixels,
      );
      let root: number;
      if (p.kind === "quad")
        root = this.store.joinBlocks(
          p.side,
          pixels as [number, number, number, number],
        );
      else if (p.kind === "combine")
        root = this.fragments.combine(
          pixels[0],
          pixels[1],
          p.side,
          p.operation,
          pixels[2],
        );
      else
        root = this.fragments.place(
          pixels[0],
          p.side,
          pixels[1],
          nodes[1].side,
          p.x,
          p.y,
          p.operation,
          pixels[2],
        );
      this.stats.folded++;
      return this.prepared(root, p.side);
    }
    const choice = nodes.find((n) => n.kind === "select");
    if (
      choice?.kind === "select" &&
      nodes.every(
        (n) =>
          n.kind === "prepared" ||
          (n.kind === "select" &&
            n.selector === choice.selector &&
            n.choices.length === choice.choices.length &&
            n.choices.every((id) => this.get(id).kind === "prepared")),
      )
    ) {
      const choices = choice.choices.map((_, index) => {
        const selected = refs.map((id, i) =>
          nodes[i].kind === "select"
            ? (nodes[i] as Extract<ImageProgram, { kind: "select" }>).choices[
                index
              ]
            : id,
        );
        return this.fold(
          p.kind === "quad"
            ? { ...p, children: selected as [number, number, number, number] }
            : {
                ...p,
                back: selected[0],
                front: selected[1],
                ...(p.mask === undefined ? {} : { mask: selected[2] }),
              },
        );
      });
      this.stats.lifted++;
      return this.select(choice.selector, choices);
    }
    this.stats.deferred++;
    return this.add(p);
  }
  page(region: RegionCoordinate, x: number, y: number, program: number): void {
    if (this.sealed) throw new Error("Preparation is already sealed");
    if (this.get(program).side !== this.store.pageSize)
      throw new Error("Invalid page program size");
    this.pages.push({ region: { ...region }, x, y, program });
  }

  finish(): PreparedWorldCompiler {
    if (this.sealed) throw new Error("Preparation is already sealed");
    // Prepare exact mip chains for every constant page alternative once. Seed
    // compilation reuses these too; zoom reduction is not deferred to display.
    for (const program of this.programs)
      if (program.kind === "prepared" && program.side === this.store.pageSize)
        this.store.commitPage(program.pixels);
    this.sealed = true;
    return new PreparedWorldCompiler(this.store.freezePreparation(), {
      revision: this.revision,
      manifest: this.manifest,
      programs: this.programs,
      pages: this.pages,
    });
  }
}
