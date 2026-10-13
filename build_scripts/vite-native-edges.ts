import type { Plugin } from "vite";
import { verifyNativeEdgeBuild } from "./native-edge-identity.mjs";

/** Direct Vite builds and dev startup must reject a stale numerical port. */
export function nativeEdgesPlugin(root: string): Plugin {
  return {
    name: "native-edge-source-identity",
    async buildStart() {
      await verifyNativeEdgeBuild(root);
    },
  };
}
