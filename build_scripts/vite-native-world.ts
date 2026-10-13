import type { Plugin } from "vite";

/** Verify the actual worker graph, including lazy rules, before publishing it. */
export function nativeWorldBoundaryPlugin(): Plugin {
  return {
    name: "native-world-runtime-boundary",
    generateBundle() {
      const roots = [...this.getModuleIds()].filter(id => /\/src\/native-map\/world-worker\.ts(?:\?|$)/.test(id));
      const visited = new Set<string>();
      const visit = (id: string) => {
        if (visited.has(id)) return;
        visited.add(id);
        if (/\/lib\/noita-telescope[^/]*\/js\//.test(id) ||
          /\/telescope-(?:adapter|dom-shim|data-bridge|app-shim)\.[jt]s/.test(id) ||
          /\/(?:load-telescope|terrain-shader-prewarm|full-pixel-telescope-exports)\.[jt]s/.test(id) ||
          /\/gl\/terrain_renderer\.js/.test(id)) {
          this.error(`Independent world worker imports a legacy runtime: ${id}`);
        }
        const info = this.getModuleInfo(id);
        if (info) for (const child of [...info.importedIds, ...info.dynamicallyImportedIds]) visit(child);
      };
      for (const root of roots) visit(root);
    },
  };
}
