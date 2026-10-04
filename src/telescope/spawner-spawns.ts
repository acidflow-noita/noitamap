type SpawnOutcome = readonly [entity: string, count: number, numerator?: number, denominator?: number];

interface SpawnerSpawns {
  outcomes: readonly SpawnOutcome[];
  maxSpawns?: number;
  illusions?: boolean;
  note?: readonly [key: string, fallback: string];
}

// Popup descriptions from data/scripts/buildings/*.lua. Chances describe the
// creature selected after a spawn succeeds, not the chance of spawning per tick.
// These do not add creatures to the map, generation data, or seed inventory.
export const SPAWNER_SPAWNS: Readonly<Partial<Record<string, SpawnerSpawns>>> = {
  ghost_crystal: { outcomes: [['ghost', 1]] },
  flynest: { outcomes: [['fly', 1]], maxSpawns: 15 },
  spidernest: { outcomes: [['longleg', 1]], maxSpawns: 15 },
  firebugnest: {
    outcomes: [['firebug', 1, 4, 5], ['bigfirebug', 1, 1, 5]],
    maxSpawns: 10,
    note: ['poi.spawnChancePerCreature', 'Chances apply to each successful spawn.'],
  },
  physics_cocoon: {
    outcomes: [['worm', 1]],
    note: ['poi.cocoonSpawns', 'Releases one worm when destroyed; damage can release it early.'],
  },
  snowcrystal: {
    outcomes: [
      ['acidshooter', 1, 1, 8], ['worm_big', 1, 1, 8],
      ['scavenger_grenade', 1, 1, 8], ['scavenger_mine', 1, 1, 8],
      ['enlightened_alchemist', 1, 1, 8], ['shaman', 1, 1, 8],
      ['tank', 1, 1, 8], ['wizard_swapper', 1, 1, 8],
    ],
    illusions: true,
    note: ['poi.snowCrystalSpawns', 'Creates one illusion at a time while the player is nearby. Chances apply to each successful spawn.'],
  },
};
