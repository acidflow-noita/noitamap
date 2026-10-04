import i18next from '../i18n';
import { canonicalEntityId } from './entity-canonical';
import { EGG_SPAWNS } from './egg-spawns';
import { SPAWNER_SPAWNS } from './spawner-spawns';

/** Resolve at card-open time so changing language also changes every note. */
export function getPOISpawnDetails(poi: { type: string; item?: string; entity?: string }, extended = false) {
  const egg = poi.type === 'item' && Object.hasOwn(EGG_SPAWNS, poi.item || '')
    ? EGG_SPAWNS[poi.item!] : undefined;
  const entity = poi.type === 'entity' ? canonicalEntityId(poi.entity || '') : '';
  const spawner = Object.hasOwn(SPAWNER_SPAWNS, entity) ? SPAWNER_SPAWNS[entity] : undefined;
  const outcomes = egg ?? spawner?.outcomes;
  if (!outcomes) return undefined;

  const heading = spawner?.illusions
    ? i18next.t('poi.possibleIllusions', 'Possible illusions')
    : outcomes.length > 1
      ? i18next.t('poi.possibleSpawns', 'Possible spawns')
      : i18next.t('poi.spawns', 'Spawns');
  // Free cards expose counts/species only. Resolve explanatory copy only for
  // the extended section, after the shared subscriber gate has accepted it.
  if (!extended) return { heading, outcomes: outcomes.map(([entity, count]) => [entity, count] as const), notes: [] };
  const notes: string[] = [];
  if (egg) notes.push(egg.length
    ? i18next.t('poi.eggHatch', 'The outcome depends on the seed and where the egg hatches.')
    : i18next.t('poi.noEggSpawns', 'No creatures hatch from this egg.'));
  if (spawner?.spawnCheck) notes.push(i18next.t('poi.nestSpawnLimit', {
    count: spawner.maxSpawns,
    frames: spawner.spawnCheck.frames,
    distance: spawner.spawnCheck.distance,
    chance: spawner.spawnCheck.chance.join('/'),
    interpolation: { escapeValue: false }, // numeric constants, rendered with textContent
    defaultValue: 'Checks every {{frames}} game frames. Each check has a {{chance}} chance to spawn one if the player is less than {{distance}} pixels away, up to {{count}} in total.',
  }));
  if (spawner?.note) notes.push(i18next.t(spawner.note[0], spawner.note[1]));
  return { heading, outcomes, notes };
}
