type SpawnOutcome = readonly [entity: string, count: number, numerator?: number, denominator?: number];

interface SpawnerSpawns {
  outcomes: readonly SpawnOutcome[];
  selection: 'fixed' | 'exclusive';
  repeatable: boolean;
  maxSpawns?: number;
  spawnCheck?: { frames: number; distance: number; chance: readonly [number, number] };
  illusions?: boolean;
  note?: readonly [key: string, fallback: string];
}

// Popup descriptions from data/scripts/buildings/*.lua; check intervals from
// the matching data/entities/buildings/*.xml LuaComponents. Chances describe the
// creature selected after a spawn succeeds, not the chance of spawning per tick.
// These do not add creatures to the map, generation data, or seed inventory.
export const SPAWNER_SPAWNS: Readonly<Partial<Record<string, SpawnerSpawns>>> = {
  ghost_crystal: { outcomes: [['ghost', 1]], selection: 'fixed', repeatable: false },
  flynest: {
    selection: 'fixed', repeatable: true,
    outcomes: [['fly', 1]], maxSpawns: 15,
    spawnCheck: { frames: 121, distance: 200, chance: [75, 101] },
  },
  spidernest: {
    selection: 'fixed', repeatable: true,
    outcomes: [['longleg', 1]], maxSpawns: 15,
    spawnCheck: { frames: 101, distance: 200, chance: [75, 101] },
  },
  firebugnest: {
    selection: 'exclusive', repeatable: true,
    outcomes: [['firebug', 1, 4, 5], ['bigfirebug', 1, 1, 5]],
    maxSpawns: 10,
    spawnCheck: { frames: 121, distance: 200, chance: [75, 101] },
    note: ['poi.spawnChancePerCreature', 'Chances apply to each successful spawn.'],
  },
  physics_cocoon: {
    selection: 'fixed', repeatable: false,
    outcomes: [['worm', 1]],
    note: ['poi.cocoonSpawns', 'Releases one when destroyed; damage can release it early.'],
  },
  lukki_eggs: {
    selection: 'fixed', repeatable: true,
    outcomes: [['lukki_tiny', 1]],
    note: ['poi.lukkiEggSpawns', 'Releases one per triggering hit. Repeated hits can release more before the egg is destroyed.'],
  },
  snowcrystal: {
    selection: 'exclusive', repeatable: true,
    outcomes: [
      ['acidshooter', 1, 1, 8], ['worm_big', 1, 1, 8],
      ['scavenger_grenade', 1, 1, 8], ['scavenger_mine', 1, 1, 8],
      ['enlightened_alchemist', 1, 1, 8], ['shaman', 1, 1, 8],
      ['tank', 1, 1, 8], ['wizard_swapper', 1, 1, 8],
    ],
    illusions: true,
    note: ['poi.snowCrystalSpawns', 'Creates an illusion while the player is nearby. Chances apply to each successful spawn.'],
  },
};
