import { lookingAtLegacyFinalCrystals } from "./telescope/temple-crystals";
import type { AppOSD } from './app_osd';
import type { MapName } from './data_sources/tile_data';
import type { URLState } from './data_sources/url';
import { fetchDailySeed } from './data_sources/daily_seed';
import { isLightMode } from './light-mode';
import { shouldUseBakedTerrain } from './renderer_settings';
import { addBakedDZIsToOSD, probeBakedDZIs, type BakedDziProbeOk, type BakedDziProbeResult } from './telescope/baked-dzi-loader';

// Opening tiles and the full generation pipeline share ownership of the viewer.
export let generationToken = 0;
export function beginDynamicRequest(): number {
  return ++generationToken;
}

export function addBakedWorlds(osd: AppOSD, bake: BakedDziProbeOk, token: number): void {
  const visible = isLightMode() ? bake.placements.filter(p => p.pw === 0) : bake.placements;
  addBakedDZIsToOSD(osd, visible, item => {
    // DZI discovery can finish after a seed switch has cleared the old world.
    if (token !== generationToken) osd.world.removeItem(item);
  });
}

export interface InitialDaily {
  token: number;
  today: Promise<number>;
  tiles: Promise<BakedDziProbeResult | null>;
}

export function startInitialDaily(route: URLState, opening: Promise<{ osd: AppOSD; map: MapName }>): InitialDaily | undefined {
  if ((route.map && route.map !== 'dynamic-main-branch') || (route.seed !== undefined && !route.dailySeed)
    || !shouldUseBakedTerrain(window.location.search)) return;

  const token = beginDynamicRequest();
  const today = fetchDailySeed();
  // An unpinned URL needs today's three manifests regardless of the seed value.
  // A pinned Daily URL may refer to yesterday. Check its identity first.
  const probe = (route.seed === undefined
    ? probeBakedDZIs('daily', today)
    : today.then(seed => seed === route.seed ? probeBakedDZIs('daily', seed) : null)
  ).catch(() => null);
  const tiles = opening.then(async ({ osd, map }) => {
    if (map !== 'dynamic-main-branch' || token !== generationToken) return null;
    osd.addOnceHandler('map-change-start', () => {
      if (token === generationToken) beginDynamicRequest();
    });
    const result = await probe;
    if (token !== generationToken) return null;
    if (result?.baked) {
      if (route.pos && result.decorationsBaked && !result.sceneBasedTempleCrystals &&
        lookingAtLegacyFinalCrystals(osd, "normal", isLightMode()))
        return { baked: false, reason: "This view contains obsolete Holy Mountain crystals" } as const;
      addBakedWorlds(osd, result, token);
    }
    return result;
  }).catch(() => null);
  return { token, today, tiles };
}
