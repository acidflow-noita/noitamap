type EggSpawn = readonly [entity: string, count: number, numerator: number, denominator: number];

const chillySpawns: readonly EggSpawn[] = [
  ['longleg', 3, 343, 512],
  ['longleg', 4, 147, 512],
  ['longleg', 5, 11, 256],
];

// data/scripts/items/egg_hatch.lua advances on 8 in N rolls of Random(1, 8),
// capped at outcome N. Pickup/projectile XML selects the table. These are
// popup possibilities only, never generated creatures or inventory contents.
export const EGG_SPAWNS: Readonly<Partial<Record<string, readonly EggSpawn[]>>> = {
  egg_monster: [['zombie', 1, 49, 64], ['zombie', 2, 15, 64]],
  egg_slime: [['slimeshooter_nontoxic', 1, 49, 64], ['slimeshooter_nontoxic', 2, 15, 64]],
  egg_fire: [['firebug', 3, 49, 64], ['bigfirebug', 1, 15, 64]],
  egg_red: [['bat', 3, 343, 512], ['tentacler_small', 1, 147, 512], ['tentacler', 1, 11, 256]],
  egg_purple: chillySpawns,
  egg_spiders: chillySpawns,
  egg_worm: [['worm_tiny', 1, 343, 512], ['worm', 1, 147, 512], ['worm_big', 1, 11, 256]],
  egg_hollow: [],
};
