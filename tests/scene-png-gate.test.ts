import { expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import ts from "typescript";

// Run the bridge's actual gate/cleanup closures without manufacturing an OSD
// viewer, map generation, GPU context or the unrelated POI/asset pipeline.
function gates() {
  const source = readFileSync("src/telescope/telescope-osd-bridge.ts", "utf8");
  const ast = ts.createSourceFile(
    "bridge.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const fn = ast.statements.find(
    (node) =>
      ts.isFunctionDeclaration(node) &&
      node.name?.text === "renderGenerationResult",
  ) as ts.FunctionDeclaration;
  const statements = [...fn.body!.statements];
  const start = statements.findIndex((node) =>
    node.getText(ast).startsWith("const generationId ="),
  );
  const end = statements.findIndex(
    (node) => node.getText(ast) === "clearPortalAnimations();",
  );
  const painted = statements.find(
    (node) =>
      ts.isVariableStatement(node) &&
      node.declarationList.declarations.some(
        (d) => d.name.getText(ast) === "wrappedOnFirstPaint",
      ),
  )!;
  const finalizer = statements.find(
    (node) => ts.isTryStatement(node) && node.finallyBlock,
  ) as ts.TryStatement;
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const batches: Array<{
    afterPaint: ReturnType<typeof vi.fn>;
    cancel: ReturnType<typeof vi.fn>;
  }> = [];
  const handlers = new Set<() => void>();
  const viewer = {
    addHandler: vi.fn((_name, callback) => handlers.add(callback)),
    removeHandler: vi.fn((_name, callback) => handlers.delete(callback)),
  };
  const queue = {
    batch: () => {
      const batch = { afterPaint: vi.fn(), cancel: vi.fn() };
      batches.push(batch);
      return batch;
    },
  };
  const code = `let currentGenerationId=0; let cancelLiveSceneEncoding;
    const beginMarkerRequest=()=>({}), cleanupOldItems=()=>{}, discardPreparedScenes=()=>{};
    return { begin(onFirstPaint=()=>{}) { const viewer=providedViewer;
      ${statements
        .slice(start, end)
        .map((node) => node.getText(ast))
        .join("\n")}
      ${painted.getText(ast)}
      return { artwork:completeArtwork, paint:wrappedOnFirstPaint,
        finalize() ${finalizer.finallyBlock!.getText(ast)} };
    }, cancelCurrent(){cancelLiveSceneEncoding?.();} };`;
  const compiled = ts.transpile(code, { target: ts.ScriptTarget.ES2022 });
  const controller = new Function(
    "scenePngEncodings",
    "providedViewer",
    "console",
    compiled,
  )(queue, viewer, { warn: vi.fn() });
  return {
    controller,
    batches,
    viewer,
    destroy: () => [...handlers].forEach((handler) => handler()),
  };
}

it("opens optional encoding only after both artwork and first paint, in either arrival order", () => {
  for (const order of [
    ["artwork", "paint"],
    ["paint", "artwork"],
  ] as const) {
    const { controller, batches } = gates();
    const generation = controller.begin();
    generation[order[0]]();
    expect(batches[0].afterPaint).not.toHaveBeenCalled();
    generation[order[1]]();
    expect(batches[0].afterPaint).toHaveBeenCalledOnce();
    generation.finalize();
    expect(batches[0].cancel).not.toHaveBeenCalled();
  }
});

it("cancels an unopened gate when artwork fails or a view never paints", () => {
  for (const reached of [undefined, "artwork", "paint"]) {
    const { controller, batches, viewer } = gates();
    const generation = controller.begin();
    if (reached) generation[reached]();
    generation.finalize();
    expect(batches[0].cancel).toHaveBeenCalledOnce();
    expect(viewer.removeHandler).toHaveBeenCalledWith(
      "before-destroy",
      expect.any(Function),
    );
    expect(batches[0].afterPaint).not.toHaveBeenCalled();
  }
});

it("superseding and stale finalization cannot open or unregister the replacement batch", () => {
  const { controller, batches } = gates();
  const old = controller.begin(),
    current = controller.begin();
  expect(batches[0].cancel).toHaveBeenCalledOnce();
  old.artwork();
  old.paint();
  old.finalize();
  expect(batches[0].afterPaint).not.toHaveBeenCalled();
  expect(batches[1].cancel).not.toHaveBeenCalled();
  current.artwork();
  current.paint();
  expect(batches[1].afterPaint).toHaveBeenCalledOnce();
  controller.cancelCurrent();
  expect(batches[1].cancel).toHaveBeenCalledOnce();
});

it("viewer destruction cancels encoding even after successful first paint", () => {
  const { controller, batches, destroy } = gates();
  const generation = controller.begin();
  generation.artwork();
  generation.paint();
  destroy();
  expect(batches[0].cancel).toHaveBeenCalledOnce();
});

it("an external first-paint callback error does not strand a complete view behind the gate", () => {
  const { controller, batches } = gates();
  const generation = controller.begin(() => {
    throw new Error("consumer failed");
  });
  generation.artwork();
  expect(() => generation.paint()).not.toThrow();
  expect(batches[0].afterPaint).toHaveBeenCalledOnce();
});
