import type { Pack } from "./rules";

export function assetRoot(): URL {
  const value = import.meta.env.VITE_GUESSR_ASSET_URL || "/guessr-assets/";
  return new URL(value.endsWith("/") ? value : value + "/", location.origin);
}
export async function loadCapturedPack(): Promise<Pack> {
  const root = assetRoot(),
    response = await fetch(new URL("pack.json", root), {
      cache: "no-cache",
      signal: AbortSignal.timeout(15000),
    });
  if (!response.ok)
    throw Error("Map images are unavailable. Please try again later.");
  const pack: Pack = await response.json();
  if (!pack.map || !pack.places?.length)
    throw Error("The map images are incomplete.");
  pack.map.tiles = new URL(pack.map.tiles, root).href;
  for (const place of pack.places) {
    place.image = new URL(place.image, root).href;
    for (const view of Object.values(place.views ?? {}))
      view.image = new URL(view.image, root).href;
  }
  return pack;
}
