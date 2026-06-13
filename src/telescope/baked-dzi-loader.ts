/**
 * baked-dzi-loader.ts
 *
 * Probes the daily-bake CF Static Assets workers for a given seed and, when
 * all three worlds (left/middle/right) respond with a matching seed, adds
 * their DZI pyramids to OSD as a drop-in replacement for the live biome
 * composite phase.
 *
 * All-or-nothing: if any world's manifest is missing, the wrong seed, or
 * 404s, this returns { baked: false } and the caller falls back to the live
 * dynamic biome composite for the entire map. Per-world fallback would
 * produce a half-rendered map and is intentionally not supported.
 *
 * Wire-in: src/dynamic-map.ts kicks the probe off in parallel with telescope
 * generation. When the probe wins with a baked hit, renderGenerationResult is
 * called with skipBiomeComposite=true so addBiomeLayersProgressively is
 * short-circuited. POIs, pixel scenes, drawing, etc. still come from
 * telescope as before — only the biome composite is replaced.
 */

const WORLDS = ["left", "middle", "right"] as const;
export type World = (typeof WORLDS)[number];

/**
 * Per-PW DZI placement read out of a world's manifest. Coordinates match the
 * OSD-coord output of build-daily-seed-images.cjs (1:1 with live render).
 */
export interface BakedDziPlacement {
  pw: number;
  /** Legacy (pre-merge bakes had one DZI per heaven/main/hell slot). Merged
   *  per-world DZIs span all three slots and omit it. */
  pvt?: number;
  /** Absolute DZI URL on a CF worker, e.g.
   *  https://daily-middle.acidflow.stream/dynamic-daily-middle.dzi */
  dziUrl: string;
  /** Top-left in OSD coords (seed-anchored world coords). */
  x: number;
  y: number;
  /** Width of the placed image in OSD coords. */
  width: number;
}

export interface BakedDziProbeOk {
  baked: true;
  /** "daily" or "previous-daily" — picked by the caller based on which seed
   *  we matched against. Useful for debugging. */
  prefix: "daily" | "previous-daily";
  placements: BakedDziPlacement[];
  /** True when the bake's pixels already include scenes + POI sprites (the
   *  node compositor alpha-blended decoration cells onto each region full
   *  before stitching). The live render can skip addPixelScenes() and the
   *  marker tile source when this is set — clicks still work via the
   *  spatial index built off generation.json. False on legacy bakes that
   *  only carry biome bgs. */
  decorationsBaked: boolean;
}
export interface BakedDziProbeMiss {
  baked: false;
  /** Reason captured for logs/telemetry — never user-facing. */
  reason: string;
}
export type BakedDziProbeResult = BakedDziProbeOk | BakedDziProbeMiss;

interface PerWorldManifestRegion {
  pw: number;
  /** Absent in merged per-world manifests (one DZI spans all three slots). */
  pvt?: number;
  dzi: string;
  minX: number;
  minY: number;
  fullW: number;
  fullH: number;
}
interface PerWorldManifest {
  seed: number;
  generatedAt?: string;
  world: World;
  /** Set by build-daily-seed-images.cjs when the upscale step blended pixel
   *  scenes + POI sprites into the region fulls before stitch. */
  baked?: boolean;
  regions: PerWorldManifestRegion[];
}

export function originFor(prefix: "daily" | "previous-daily", world: World): string {
  return `https://${prefix}-${world}.acidflow.stream`;
}

async function fetchWorldManifest(
  prefix: "daily" | "previous-daily",
  world: World,
  signal?: AbortSignal,
): Promise<PerWorldManifest | null> {
  try {
    const origin = originFor(prefix, world);
    const resp = await fetch(`${origin}/manifest.json`, { signal });
    if (!resp.ok) return null;
    const m = (await resp.json()) as PerWorldManifest;
    if (!m || typeof m.seed !== "number" || !Array.isArray(m.regions) || m.regions.length === 0) {
      return null;
    }
    return m;
  } catch {
    return null;
  }
}

/**
 * Probe all three worlds for the given seed. Resolves with `baked: true`
 * iff all three manifests load AND every one reports the requested seed.
 *
 * `prefix` is either "daily" (today's bake) or "previous-daily" (yesterday's).
 * The caller picks based on what `fetchDailySeed`/`fetchPreviousDailySeed`
 * returned for the seed being rendered.
 */
export async function probeBakedDZIs(
  prefix: "daily" | "previous-daily",
  seed: number,
  signal?: AbortSignal,
): Promise<BakedDziProbeResult> {
  const manifests = await Promise.all(WORLDS.map((w) => fetchWorldManifest(prefix, w, signal)));

  for (let i = 0; i < WORLDS.length; i++) {
    const m = manifests[i];
    if (!m) return { baked: false, reason: `manifest missing/invalid for ${prefix}-${WORLDS[i]}` };
    if (m.seed !== seed) {
      return {
        baked: false,
        reason: `${prefix}-${WORLDS[i]} manifest seed ${m.seed} != requested ${seed}`,
      };
    }
  }

  const placements: BakedDziPlacement[] = [];
  // Decorations are considered baked only when ALL three world manifests
  // report it. A mixed set means a stale prev-daily worker still serves a
  // legacy bake without baked sprites; falling back to the live decor layer
  // for the whole map keeps rendering consistent.
  let decorationsBaked = true;
  for (let i = 0; i < WORLDS.length; i++) {
    const m = manifests[i]!;
    if (!m.baked) decorationsBaked = false;
    const origin = originFor(prefix, WORLDS[i]);
    for (const r of m.regions) {
      placements.push({
        pw: r.pw,
        pvt: r.pvt,
        dziUrl: `${origin}/${r.dzi}`,
        x: r.minX,
        y: r.minY,
        width: r.fullW,
      });
    }
  }
  return { baked: true, prefix, placements, decorationsBaked };
}

/**
 * Add every baked DZI to the OSD viewer at its recorded (x, y, width). Caller
 * is responsible for first removing any stale dynamic biome composites; this
 * function never touches the viewer state beyond addTiledImage.
 *
 * Returns once every DZI is queued (not loaded) — OSD streams tiles as the
 * user zooms. The optional `onAdded` callback fires per-DZI as OSD reports the
 * tiled-image item ready, so the caller can track items for later cleanup
 * (matching the existing dynamic-composite tracking in telescope-osd-bridge).
 */
export function addBakedDZIsToOSD(
  viewer: any,
  placements: BakedDziPlacement[],
  onAdded?: (item: any, placement: BakedDziPlacement) => void,
): void {
  for (const p of placements) {
    viewer.addTiledImage({
      tileSource: p.dziUrl,
      x: p.x,
      y: p.y,
      width: p.width,
      success: (event: any) => {
        // Tag the source so clearDynamicOverlays / renderGenerationResult can
        // tell baked biome DZIs apart from the static base map's DZIs (both
        // have a string tilesUrl, which is what the base-layer heuristic
        // keys on). Without the tag, baked tiles survive every seed switch.
        try { event.item.source.__bakedDzi = true; } catch {}
        try {
          onAdded?.(event.item, p);
        } catch (e) {
          console.warn("[baked-dzi] onAdded threw:", e);
        }
      },
    });
  }
}
