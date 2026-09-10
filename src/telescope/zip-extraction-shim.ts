/** Browser/native-facade replacement for telescope's CDN zip loader. All three
 * asset entrypoints share the same aliases, packaged PNGs and extraction cache. */
import { readTelescopeAsset } from "./telescope-assets";

export async function getFromZipFirst(url: string): Promise<Blob> {
  const blob = await readTelescopeAsset(url);
  if (!blob) {
    // Required generator input must never silently become a transparent 1x1
    // image. Optional-art callers can catch this; real failures remain visible.
    throw new Error(
      `Missing telescope PNG: ${url}. Not present in the shipped archives or packaged assets.`,
    );
  }
  return blob;
}
