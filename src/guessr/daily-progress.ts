import { supportedCamera, type ClueSource } from './clue-camera';
import { newClueProgress, within, type Bounds, type ClueProgress, type Point } from './rules';

type Store = Pick<Storage, 'getItem' | 'setItem'>;
interface DailyView { id: string; round: number; version: string; bounds: Bounds; clue: ClueSource }
const prefix = 'noitamap-guessr-daily-view-v1:';

export function saveDailyView(store: Store, daily: DailyView, progress: ClueProgress, guess: Point | null): void {
  try { store.setItem(prefix + daily.id, JSON.stringify({ round: daily.round, version: daily.version, progress, guess })); } catch { /* The server still retains submitted rounds. */ }
}

export function restoreDailyView(store: Store, daily: DailyView): { progress: ClueProgress; guess: Point | null } {
  const empty = () => ({ progress: newClueProgress(), guess: null });
  try {
    const saved = JSON.parse(store.getItem(prefix + daily.id) || 'null'), c = saved?.progress;
    if (saved?.round !== daily.round || saved?.version !== daily.version || !c || !supportedCamera(daily.clue, c)
        || !Number.isInteger(c.widest) || c.widest < c.level || c.widest > 6 || !Number.isInteger(c.travelSpent)
        || c.travelSpent < 0 || c.travelSpent > 5000 || !Array.isArray(c.visited) || c.visited.length > 512
        || !c.visited.every((s: unknown) => typeof s === 'string' && /^-?\d+,-?\d+$/.test(s))) return empty();
    return { progress: c, guess: saved.guess && within(saved.guess, daily.bounds) ? saved.guess : null };
  } catch { return empty(); }
}
