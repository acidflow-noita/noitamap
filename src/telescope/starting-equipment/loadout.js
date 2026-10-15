// Derived from Lymm37/noita-telescope (MIT). See NOTICE.txt and LICENSE.txt.
// Pure loadout computation for legacy daily metadata repair.
import { NollaPrng } from "./rng.js";
import { selectNormalPotionMaterial } from "./potion.js";

export function getStartingLoadout(ws, isDaily=false, gameMode='normal', calendar) {
    if (!calendar) {
        const now = new Date();
        calendar = {month: now.getMonth() + 1, day: now.getDate()};
    }
    const x = 227;
    const y = -81;
    const prng = new NollaPrng(0);
    if (!isDaily) {
        prng.SetRandomSeed(ws, 0, -11);
    }
    else {
        prng.SetRandomSeed(ws, 0, 0);
    }
    const wand = {
        type: 'wand',
        item: 'wand',
        mana_max: prng.Random(80, 130),
        deck_capacity: prng.Random(2, 3),
        name: ["Bolt staff"][prng.Random(0, 0)],
        reload_time: prng.Random(20, 28),
        fire_rate_wait: prng.Random(9, 15),
        mana_charge_speed: prng.Random(25, 40),
        actions_per_round: 1,
        shuffle_deck_when_empty: 0,
        spread_degrees: 0,
        speed_multiplier: 1.0,
        sprite: "custom/handgun",
        always_casts: [],
        x: x,
        y: y,
        grip: {x: 3, y: 3},
        tip: {x: 12, y: 3},
    }
    let cards = [];
    const spellCount = Math.min(prng.Random(1, 3), wand.deck_capacity);
    let spell = "LIGHT_BULLET";
    if (!isDaily) {
        if (prng.Random(1, 100) < 50) {
            spell = ["SPITTER", "RUBBER_BALL", "BOUNCY_ORB"][prng.Random(0, 2)];
        }
    }
    else {
        spell = ["LIGHT_BULLET", "SPITTER", "RUBBER_BALL", "BOUNCY_ORB"][prng.Random(0, 3)];
    }
    for (let i = 0; i < spellCount; i++) {
        cards.push(spell);
    }
    wand['cards'] = cards;

    if (!isDaily) {
        prng.SetRandomSeed(ws, -1, 0);
    }
    else {
        prng.SetRandomSeed(ws, 0, 0);
    }
    const bomb_wand = {
        type: 'wand',
        item: 'wand',
        mana_max: prng.Random(80, 110),
        deck_capacity: prng.Random(1, 1),
        name: "Bomb wand",
        reload_time: prng.Random(1, 10),
        fire_rate_wait: prng.Random(3, 8),
        mana_charge_speed: prng.Random(5, 20),
        actions_per_round: 1,
        shuffle_deck_when_empty: 1,
        spread_degrees: 0,
        speed_multiplier: 1.0,
        sprite: "custom/bomb_wand",
        always_casts: [],
        x: x,
        y: y,
        grip: {x: 3, y: 3},
        tip: {x: 13, y: 3},
    }

    let bombSpell = "BOMB";
    if (!isDaily) {
        let r = prng.Random(1, 100);
        if (r < 50) {
            bombSpell = ["BOMB", "DYNAMITE", "MINE", "ROCKET", "GRENADE"][prng.Random(0, 4)];
        }
    }
    else {
        bombSpell = ["BOMB", "DYNAMITE", "MINE", "ROCKET", "GRENADE"][prng.Random(0, 4)];
    }
    bomb_wand['cards'] = [bombSpell];

    let potion = null;
    if (!isDaily) {
        prng.SetRandomSeed(ws, -4.5, -4);
        let r = prng.Random(1, 100);
        let material = "unknown";
        if (r <= 65) {
            r = prng.Random(1, 100);
            if (r <= 10) material = "mud";
            else if (r <= 20) material = "water_swamp";
            else if (r <= 30) material = "water_salt";
            else if (r <= 40) material = "swamp";
            else if (r <= 50) material = "snow";
            else material = "water";
        }
        else if (r <= 70) material = "blood";
        else if (r <= 99) {
            // Useless roll?
            r = prng.Random(0, 100);
            material = ["acid", "magic_liquid_polymorph", "magic_liquid_random_polymorph", "magic_liquid_berserk", "magic_liquid_charm", "magic_liquid_movement_faster"][prng.Random(0, 5)];
        }
        else {
            r = prng.Random(0, 100000);
            if (r === 666) material = "urine";
            else if (r === 79) material = "gold";
            else material = ["slime", "gunpowder_unstable"][prng.Random(0, 1)];
        }
        const datetime = calendar;
        if ((datetime.month === 5 && datetime.day === 1) || (datetime.month === 4 && datetime.day === 30)) {
            if (prng.Random(0, 100) <= 20) material = "sima";
        }
        potion = {
            type: 'item',
            item: 'potion',
            material: material,
            x: x,
            y: y,
        }
    }
    else {
        potion = {type: "item", item: "potion", material: selectNormalPotionMaterial(ws, 0, 0, 0, gameMode, calendar), x: 0, y: 0};
    }

    return {type: 'starting_loadout', items: [wand, bomb_wand, potion], x: x, y: y, biome: null};
}
