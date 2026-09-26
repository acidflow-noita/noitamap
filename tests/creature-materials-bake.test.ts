import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { readFileSync } from 'node:fs';
import { createCreatureMaterialResolver } from '../build_scripts/creature-materials.cjs';
import { CREATURE_DATA } from '../src/data/creature-data';

async function resolver(files: Record<string, string>) {
  const zip = new JSZip();
  Object.entries(files).forEach(([name, xml]) => zip.file(`data/entities/${name}.xml`, xml));
  return createCreatureMaterialResolver(await zip.generateAsync({ type: 'nodebuffer' }), new Set([
    'blood', 'blood_fading', 'oil', 'acid', 'meat', 'steel', 'meat_slime_green', 'rock_static_glow',
  ]));
}

describe('baked creature material references', () => {
  it('resolves inherited overrides and real engine defaults without using display-name guesses', async () => {
    const lookup = await resolver({
      base: '<Entity><DamageModelComponent ragdoll_material="steel"/></Entity>',
      'animals/defaults': '<Entity><DamageModelComponent/><Entity><DamageModelComponent blood_material="acid"/></Entity></Entity>',
      'animals/derived': '<Entity><Base file="data/entities/base.xml"><DamageModelComponent blood_material="oil"/></Base></Entity>',
      'animals/replaced': '<Entity><DamageModelComponent blood_material="acid" ragdoll_material="meat"/><Base file="data/entities/base.xml"><DamageModelComponent _remove_from_base="1"/></Base></Entity>',
    });
    expect(lookup(['defaults'])).toMatchObject({ bloodMaterialId: 'blood_fading', corpseMaterialId: 'meat' });
    expect(lookup(['derived'])).toMatchObject({ bloodMaterialId: 'oil', corpseMaterialId: 'steel' });
    expect(lookup(['replaced'])).toMatchObject({ bloodMaterialId: 'acid', corpseMaterialId: 'meat' });
  });

  it('uses retained physical body material and respects disabled ragdolls', async () => {
    const lookup = await resolver({
      'animals/physics': '<Entity><DamageModelComponent create_ragdoll="0"/><PhysicsBodyComponent on_death_leave_physics_body="1"/><PhysicsImageShapeComponent material="steel"/></Entity>',
      'animals/vanishes': '<Entity><DamageModelComponent create_ragdoll="0"/><PhysicsBodyComponent on_death_leave_physics_body="0"/><PhysicsImageShapeComponent material="steel"/></Entity>',
    });
    expect(lookup(['physics']).corpseMaterialId).toBe('steel');
    expect(lookup(['vanishes']).corpseMaterialId).toBeNull();
  });

  it('uses actual entity names for canonical IDs and excludes similarly named child/projectile data', async () => {
    const lookup = await resolver({
      'animals/basebot_sentry': '<Entity name="$animal_sentry"><DamageModelComponent blood_material="oil" ragdoll_material="steel"/><Entity><DamageModelComponent blood_material="acid"/></Entity></Entity>',
      'projectiles/sentry': '<Entity><DamageModelComponent blood_material="acid"/></Entity>',
      'animals/actual': '<Entity><DamageModelComponent blood_material="blood"/></Entity>',
      'projectiles/actual': '<Entity><DamageModelComponent blood_material="acid"/></Entity>',
    });
    expect(lookup(['sentry'])).toMatchObject({ bloodMaterialId: 'oil', corpseMaterialId: 'steel' });
    expect(lookup(['actual']).bloodMaterialId).toBe('blood');
  });

  it('retains duplicate material alternatives as ambiguous instead of inventing precedence', async () => {
    const lookup = await resolver({
      'animals/boss': '<Entity name="boss" name="boss"><DamageModelComponent ragdoll_material="meat_slime_green" ragdoll_material="rock_static_glow"/></Entity>',
    });
    expect(lookup(['boss']).corpseMaterialId).toBeNull();
    expect(lookup(['boss']).corpseMaterialCandidates).toEqual(['meat_slime_green', 'rock_static_glow']);
  });

  it('ships references for every actual material row in the current creature catalog', () => {
    const creatures = JSON.parse(readFileSync('public/assets/full_creatures.json', 'utf8')) as Array<Record<string, any>>;
    const missing: string[] = [];
    for (const creature of creatures) {
      const baked = creature.id ? CREATURE_DATA[creature.id] : Object.values(CREATURE_DATA)
        .find(entry => entry.wikipage === creature.wikipage && entry.alias === creature.alias);
      expect(baked, creature.id ?? creature.alias).toBeDefined();
      if (!baked) throw new Error(`Missing baked creature: ${creature.id ?? creature.alias}`);
      for (const field of ['blood', 'corpse'] as const) {
        if (!creature[field] || /^none$/i.test(creature[field].trim())) continue;
        if (!baked[`${field}MaterialId`] && !baked[`${field}MaterialIds`]?.length) missing.push(`${creature.id ?? creature.alias}.${field}`);
        if (creature[`${field}_material_id`]) expect(baked[`${field}MaterialId`]).toBe(creature[`${field}_material_id`]);
      }
    }
    expect(missing).toEqual([]);
    expect(CREATURE_DATA.fly).toMatchObject({ bloodMaterialId: 'blood_fading', corpseMaterialId: 'meat' });
    expect(CREATURE_DATA.duck).toMatchObject({ bloodMaterialId: 'blood_fading', corpseMaterialId: 'meat_helpless' });
    expect(CREATURE_DATA.tank).toMatchObject({ bloodMaterialId: 'oil', corpseMaterialId: 'steel' });
    for (const id of ['boss_pit', 'parallel_tentacles']) {
      expect(CREATURE_DATA[id].corpseMaterialId).toBeNull();
      expect(CREATURE_DATA[id].corpseMaterialIds).toEqual(['meat_slime_green', 'rock_static_glow']);
    }
  });
});
