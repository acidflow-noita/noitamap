import { asMapName, type MapName } from './data_sources/tile_data';
import { parseURL, reorderParams, type URLState } from './data_sources/url';
import type { ZoomPos } from './app_osd';

const GAME_PARAMS = ['m', 'se', 'ds', 'u', 'p'] as const;
const OWNED_PARAMS = [...GAME_PARAMS, 'x', 'y', 'z'] as const;

export function parseModNavigation(href: string, origin: string): { url: URL; state: URLState & { map: MapName } } | null {
  try {
    const url = new URL(href);
    if (url.origin !== origin || !['/', '/index.html'].includes(url.pathname) || url.searchParams.get('src') !== 'mod') return null;
    const state = parseURL(url.href);
    if (!state.map || !asMapName(state.map)) return null;
    if (state.map === 'dynamic-main-branch' && (!/^\d{1,10}$/.test(url.searchParams.get('se') ?? '')
      || state.seed === undefined || state.seed < 0 || state.seed > 0xffffffff)) return null;
    const camera = [url.searchParams.get('x'), url.searchParams.get('y'), url.searchParams.get('z') ?? url.searchParams.get('zoom')];
    if (camera.some(v => v !== null) && (!state.pos || camera.some(v => !/^-?\d+$/.test(v ?? ''))
      || !Object.values(state.pos).every(Number.isFinite) || state.pos.zoom <= 0)) return null;
    url.searchParams.set('m', state.map);
    if (state.pos) url.searchParams.set('z', url.searchParams.get('z') ?? url.searchParams.get('zoom')!);
    return { url, state: state as URLState & { map: MapName } };
  } catch { return null; }
}

/** A mod owns game/position parameters, not language, renderer or sidebar
 * preferences. Keep the existing document and its warmed renderer alive. */
export function mergeModNavigation(current: URL, target: URL): URL {
  const result = new URL(current);
  for (const key of OWNED_PARAMS) {
    const value = target.searchParams.get(key);
    if (value === null) result.searchParams.delete(key);
    else result.searchParams.set(key, value);
  }
  // Daily identity is auto-detected by the app; a position update for the same
  // seed must not discard that resolved identity just because Lua omits ds.
  if (!target.searchParams.has('ds') && target.searchParams.get('se') === current.searchParams.get('se')
    && target.searchParams.get('m') === 'dynamic-main-branch' && current.searchParams.has('ds'))
    result.searchParams.set('ds', current.searchParams.get('ds')!);
  for (const key of ['src', 'map', 'zoom', 'poi', 'pid', 'targetPoiId', 'spawn']) result.searchParams.delete(key);
  reorderParams(result);
  return result;
}

interface ModNavigationOptions {
  href(): string;
  getMap(): MapName;
  replaceURL(url: URL): void;
  setMap(map: MapName): Promise<void>;
  goto(pos: ZoomPos): void;
  updateSeed(seed: number, daily: boolean): void;
  resetUnlocks(): void;
  closeCard(): void;
  renderDynamic(): Promise<unknown>;
  failed(error: unknown): void;
}

export function createModNavigation(options: ModNavigationOptions) {
  let epoch = 0, mapTransition: Promise<void> | null = null;
  return {
    accept(href: string): boolean {
      const current = new URL(options.href()), parsed = parseModNavigation(href, current.origin);
      if (!parsed) return false;
      const { url, state } = parsed, next = mergeModNavigation(current, url), request = ++epoch;
      const previousState = parseURL(current.href);
      const gameChanged = state.map !== options.getMap() || state.seed !== previousState.seed
        || ['u', 'p', 'ds'].some(k => current.searchParams.get(k) !== next.searchParams.get(k));
      const unlocksChanged = ['u', 'p'].some(k => current.searchParams.get(k) !== next.searchParams.get(k));
      options.closeCard();
      options.replaceURL(next);
      if (unlocksChanged) options.resetUnlocks();
      if (state.seed !== undefined) options.updateSeed(state.seed, !!parseURL(next.href).dailySeed);
      const show = () => {
        if (request !== epoch) return;
        // Map changes can update the URL as they settle; restore only this
        // request's game parameters while retaining current UI preferences.
        options.replaceURL(mergeModNavigation(new URL(options.href()), next));
        if (state.pos) options.goto(state.pos);
        if (state.map === 'dynamic-main-branch' && gameChanged)
          void options.renderDynamic().catch(options.failed);
      };
      if (mapTransition || state.map !== options.getMap()) {
        const pending = (mapTransition ?? Promise.resolve()).catch(() => {}).then(async () => {
          if (request !== epoch) return;
          await options.setMap(state.map);
          show();
        });
        mapTransition = pending;
        void pending.catch(options.failed).finally(() => { if (mapTransition === pending) mapTransition = null; });
      } else show();
      return true;
    },
  };
}
