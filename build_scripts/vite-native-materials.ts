import type { Plugin } from "vite";
import { verifyNativeMaterialBuild } from "./native-material-identity.mjs";

/** Fail closed after C/reference/table changes, even when Vite is invoked directly. */
export function nativeMaterialsPlugin(root: string): Plugin {
  return {
    name: "native-material-source-identity",
    async buildStart() {
      await verifyNativeMaterialBuild(root);
    },
  };
}
