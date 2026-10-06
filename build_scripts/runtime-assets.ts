import { buildRuntimeAssets as prepare, archiveFiles } from './runtime-assets.mjs';

export interface RuntimeAsset {
  file: string;
  revision: string;
  bytes: number;
}
export interface RuntimeAssetIndex {
  version: 1;
  pages: RuntimeAsset[];
  entries: Record<string, [page: number, offset: number, length: number]>;
}
interface PreparedAssets {
  assets: Map<string, Buffer>;
  manifests: Record<string, RuntimeAsset>;
  archiveRevisions: Record<string, string>;
}

export { archiveFiles };
export const buildRuntimeAssets = prepare as (root: string) => Promise<PreparedAssets>;
