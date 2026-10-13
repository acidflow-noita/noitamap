import { provenance } from "virtual:noitamap-telescope-asset-identity";
import { readTelescopeAsset } from "../telescope/telescope-assets";
import { fullPixelDataUrl } from "../telescope/full-pixel-data";
import { immutableTelescopeAssets, revisionedAssetUrl } from "../telescope/immutable-assets";
import type { NativeAssets } from "./asset-host";
import { nativeRuleAssets } from "./input-assets";

/** Reuse Noitamap's immutable asset delivery, never its fetch/DOM interception. */
export const browserNativeAssets: NativeAssets = {
  revision: `native-world-v1/${provenance}`,
  async read(path) {
    const packaged = nativeRuleAssets[path] ?? fullPixelDataUrl(path);
    if (packaged) {
      const response = await immutableTelescopeAssets.fetch(`native/${path}`, provenance,
        () => fetch(revisionedAssetUrl(packaged, provenance), {
          cache: "force-cache", signal: AbortSignal.timeout(30_000),
        }));
      if (!response.ok) throw new Error(`Missing native input ${path}: ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    }
    const blob = await readTelescopeAsset(path);
    if (!blob) throw new Error(`Missing native input ${path}`);
    return new Uint8Array(await blob.arrayBuffer());
  },
};
