/** The map supplies navigation without making shared creature cards depend on OSD. */
export type CreatureSpawnMode = 'normal' | 'ng-plus';

export interface CreatureSpawnAvailability {
  canNavigate: boolean;
  /** Original metadata labels that have no available region in the current main world. */
  missing: string[];
}

export interface CreatureSpawnNavigation {
  resolve(rawSpawn: string, mode: CreatureSpawnMode): CreatureSpawnAvailability;
  /** The host closes the source card through its lifecycle before moving the map. */
  navigate(rawSpawn: string, source: HTMLElement, mode: CreatureSpawnMode, creatureId: string): boolean;
}

let navigation: CreatureSpawnNavigation | null = null;
const listeners = new Set<() => void>();

export function setCreatureSpawnNavigation(handler: CreatureSpawnNavigation | null): void {
  navigation = handler;
  listeners.forEach(listener => listener());
}

export function onCreatureSpawnNavigationChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function resolveCreatureSpawns(rawSpawn: string, mode: CreatureSpawnMode = 'normal'): CreatureSpawnAvailability {
  return navigation?.resolve(rawSpawn, mode) ?? { canNavigate: false, missing: [] };
}

export function navigateCreatureSpawns(rawSpawn: string, source: HTMLElement, mode: CreatureSpawnMode = 'normal', creatureId = ''): boolean {
  return navigation?.navigate(rawSpawn, source, mode, creatureId) ?? false;
}
