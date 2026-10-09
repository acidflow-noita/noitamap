import i18next from '../i18n';
import { canonicalEntityId } from './entity-canonical';
import { EGG_HATCH_BEHAVIOR, EGG_SPAWNS } from './egg-spawns';
import { SPAWNER_SPAWNS } from './spawner-spawns';

/** Resolve at card-open time so changing language also changes every note. */
export function getPOISpawnDetails(poi: { type: string; item?: string; entity?: string }, extended = false) {
  const egg = poi.type === 'item' && Object.hasOwn(EGG_SPAWNS, poi.item || '')
    ? EGG_SPAWNS[poi.item!] : undefined;
  const entity = poi.type === 'entity' ? canonicalEntityId(poi.entity || '') : '';
  const spawner = Object.hasOwn(SPAWNER_SPAWNS, entity) ? SPAWNER_SPAWNS[entity] : undefined;
  const outcomes = egg ?? spawner?.outcomes;
  if (!outcomes) return undefined;

  const behavior = egg ? EGG_HATCH_BEHAVIOR : spawner!;
  const exclusive = behavior.selection === 'exclusive';
  const heading = egg
    ? i18next.t('poi.hatchesOneOf', 'Hatches one of these')
    : exclusive
      ? spawner?.illusions
        ? i18next.t('poi.oneIllusionPerSpawn', 'One illusion per spawn')
        : i18next.t('poi.oneOptionPerSpawn', 'One option per spawn')
      : behavior.repeatable
        ? i18next.t('poi.spawnsPerEvent', 'Each spawn')
        : i18next.t('poi.spawns', 'Spawns');
  const presentation = {
    heading,
    selection: behavior.selection,
    repeatable: behavior.repeatable,
    separator: exclusive ? i18next.t('poi.spawnOr', 'OR') : undefined,
    relationship: exclusive && behavior.repeatable
      ? i18next.t('poi.spawnOptionsOverTime', 'Different options can appear over successive spawns.')
      : undefined,
  };
  // Basic cards explain how to read the outcomes. Odds, triggering conditions,
  // timing and lifetime limits remain in the authenticated extended section.
  if (!extended) return { ...presentation, outcomes: outcomes.map(([entity, count]) => [entity, count] as const), notes: [] };
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
  return { ...presentation, outcomes, notes };
}
