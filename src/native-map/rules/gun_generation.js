// Adapted into the owned Noitamap rules runtime. See NOTICE.txt for provenance.
import { readJson } from '../asset-host';
import { NollaPrng } from "./nolla_prng.js";
import { GUN_NAMES, GUN_PROBS, WAND_SHAPES, WAND_TYPES } from "./wand_config.js";
import { GetRandomActionWithType } from "./spell_generator.js";
import { clamp, shuffleTable, roundHalfOfEven } from "./utils.js";
import { PROJECTILE, STATIC_PROJECTILE, MODIFIER, DRAW_MANY } from "./spells.js";
import { generateGreatChestStandalone } from "./chest_generation.js";

export function generateGun(worldSeed, ngPlusCount, wandType, cost, level, force_unshuffle, x, y, noMoreShuffle = false) {
    let gun = {};
    const prng = new NollaPrng(0);
    prng.SetRandomSeed(worldSeed+ngPlusCount, x, y);
    
    gun['x'] = x;
    gun['y'] = y;
    gun['cards'] = [];
    gun['level'] = level;
    gun['cost'] = cost;
    if (level == 1) {
        if (prng.Random(0, 100) < 50) {
            gun['cost'] += 5;
        }
    }
    gun['cost'] += prng.Random(-3, 3);
    gun["deck_capacity"] = 0
    gun["actions_per_round"] = 0
    gun["reload_time"] = 0
    gun["shuffle_deck_when_empty"] = 1
    gun["fire_rate_wait"] = 0
    gun["spread_degrees"] = 0
    gun["speed_multiplier"] = 0
    gun["prob_unshuffle"] = 0.1
    gun["prob_draw_many"] = 0.15
    gun['mana_charge_speed'] = 50*level + prng.Random(-5, 5*level);
    gun['mana_max'] = 50 + 150*level + prng.Random(-5, 5)*10;
    gun['force_unshuffle'] = 0;
    gun['is_rare'] = 0;
    gun['wand_type'] = wandType;

    let p = prng.Random(0, 100);
    if (p < 20) {
        gun['mana_charge_speed'] = ( 50*level + prng.Random(-5, 5*level) ) / 5;
        gun['mana_max'] = ( 50 + 150*level + prng.Random(-5, 5)*10 ) * 3;
        if (wandType == 'better' && gun['mana_charge_speed'] < 10) gun['mana_charge_speed'] = 10;
    }

    p = prng.Random(0, 100);
    if (wandType == 'better') {
        if (p < 15 + level*6) {
            gun['force_unshuffle'] = 1;
        }
    }
    else {
        if (p < 15) {
            gun['mana_charge_speed'] = ( 50*level + prng.Random(-5, 5*level) ) * 5;
            gun['mana_max'] = ( 50 + 150*level + prng.Random(-5, 5)*10 ) / 3;
        }

        if (gun['mana_max'] < 50) gun['mana_max'] = 50;
        if (gun['mana_charge_speed'] < 10) gun['mana_charge_speed'] = 10;
        
        p = prng.Random(0, 100);
        if (p < 15 + level*6) {
            gun['force_unshuffle'] = 1;
        }
    }

    let is_rare = 0;
    p = prng.Random(0, 100);
    if (p < 5) {
        is_rare = 1;
        gun['is_rare'] = 1;
        gun['cost'] += 65;
    }

    let vars1 = ["reload_time", "fire_rate_wait", "spread_degrees", "speed_multiplier"];
    let vars2 = ["deck_capacity"];
    let vars3 = ["shuffle_deck_when_empty", "actions_per_round"];
    //let vars3 = ["actions_per_round", "shuffle_deck_when_empty"];

    shuffleTable(vars1, prng);
    if (gun['force_unshuffle'] != 1) shuffleTable(vars3, prng);

    for (let v of vars1) {
        applyRandomVariable(gun, v, prng);
    }
    for (let v of vars2) {
        applyRandomVariable(gun, v, prng);
    }
    for (let v of vars3) {
        applyRandomVariable(gun, v, prng);
    }

    // What if capacity is not an integer??
    //console.log("Current gun cost:", gun['cost']);
    if (gun['cost'] > 5) {
        let rareNonincreaseRoll = prng.Random(0, 1000);
        //console.log("Rare non-increase roll: ", rareNonincreaseRoll);
        if (rareNonincreaseRoll < 995) {
            if (gun['shuffle_deck_when_empty'] == 1) {
                gun['deck_capacity'] += gun['cost']/5;
                gun['cost'] = 0;
            }
            else {
                gun['deck_capacity'] += gun['cost']/10;
                gun['cost'] = 0;
            }
        }
    }

    if (wandType == 'better') {
        let name = GUN_NAMES[prng.Random(0, GUN_NAMES.length-1)];
        gun['name'] = name + " Wand";
    }
    else {
        gun['name'] = "Wand";
    }

    if (force_unshuffle || noMoreShuffle) gun['shuffle_deck_when_empty'] = 0;
    gun['original_force_unshuffle'] = force_unshuffle ? 1 : 0;

    let rareCapacityRoll = prng.Random(0, 10000);
    //console.log("Rare capacity roll: ", rareCapacityRoll);
    if (rareCapacityRoll <= 9999) {
        gun['deck_capacity'] = clamp(gun['deck_capacity'], 2, 26);
    }
    if (gun['deck_capacity'] <= 1) gun['deck_capacity'] = 2;

    if (gun['reload_time'] >= 60) {
        function random_add_actions_per_round(prng) {
            gun['actions_per_round'] += 1;
            if (prng.Random(0,100) < 70) {
                random_add_actions_per_round(prng);
            }
        }
        random_add_actions_per_round(prng);
        if (prng.Random(0, 100) < 50) {
            let new_actions_per_round = +gun['deck_capacity'];
            for (let i = 1; i <= 6; i++) {
                let temp_actions_per_round = prng.Random(roundHalfOfEven(gun['actions_per_round']), roundHalfOfEven(gun['deck_capacity']));
                if (temp_actions_per_round < new_actions_per_round) {
                    new_actions_per_round = temp_actions_per_round;
                }
            }
            gun['actions_per_round'] = new_actions_per_round;
        }
    }

    gun['actions_per_round'] = clamp(gun['actions_per_round'], 1, gun['deck_capacity']);

    if (wandType == 'better') {
        betterAddRandomCards(worldSeed, ngPlusCount, gun, x, y, level, prng);
        getWandSprite(gun, prng);
    }
    else {
        // Uhhh apparently this breaks it
        getWandSprite(gun, prng);
        addRandomCards(worldSeed, ngPlusCount, gun, x, y, level, prng);
        //getWandSprite(gun, prng);
    }

    // This doesn't really affect anything other than aesthetics, and I don't feel like importing literally thoussands of wand shapes
    //let wandShape = getWand(gun);
    //gun['wand_shape'] = wandShape;

    // Round down capacity...
    //gun['deck_capacity'] = Math.floor(gun['deck_capacity']);

    return gun;
}

function initTotalProb(gunProb) {
    let totalProb = 0;
    for (let i = 0; i < gunProb.probs.length; i++) {
        totalProb += gunProb.probs[i].prob;
    }
    gunProb.totalProb = totalProb;
}

function getGunProbs(wandType, variable, prng) {
    if (!GUN_PROBS[wandType]) {
        console.log("Warning: no gun probs for wand type ", wandType);
        return null;
    }
    if (!GUN_PROBS[wandType][variable]) return null;
    if (GUN_PROBS[wandType][variable].totalProb == 0) initTotalProb(GUN_PROBS[wandType][variable]);
    let r = prng.Next() * GUN_PROBS[wandType][variable].totalProb;
    for (let i = 0; i < GUN_PROBS[wandType][variable].probs.length; i++) {
        if (r < GUN_PROBS[wandType][variable].probs[i].prob) {
            return GUN_PROBS[wandType][variable].probs[i];
        }
        r -= GUN_PROBS[wandType][variable].probs[i].prob;
    }
    // Looks like this is actually possible if seed = 0, let's just return the last one
    return GUN_PROBS[wandType][variable].probs[GUN_PROBS[wandType][variable].probs.length - 1];
}

function applyRandomVariable(gun, variable, prng) {
    let probs = getGunProbs(gun['wand_type'], variable, prng);

    if (variable == 'reload_time') {
        let min = clamp(60 - gun['cost']*5, 1, 240);
        let max = 1024;
        gun[variable] = clamp(prng.RandomDistribution(probs.min, probs.max, probs.mean, probs.sharpness), min, max);
        gun['cost'] -= (60 - gun[variable])/5;
    }
    else if (variable == 'fire_rate_wait') {
        let min = clamp(16 - gun['cost'], -50, 50);
        let max = 50;
        gun[variable] = clamp(prng.RandomDistribution(probs.min, probs.max, probs.mean, probs.sharpness), min, max);
        gun['cost'] -= 16 - gun[variable];
    }
    else if (variable == 'spread_degrees') {
        let min = clamp(gun['cost']/-1.5, -35, 35);
        let max = 35;
        gun[variable] = clamp(prng.RandomDistribution(probs.min, probs.max, probs.mean, probs.sharpness), min, max);
        gun['cost'] -= 16 - gun[variable];
    }
    else if (variable == 'speed_multiplier') {
        gun[variable] = prng.RandomDistributionF(probs.min, probs.max, probs.mean, probs.sharpness);
    }
    else if (variable == 'deck_capacity') {
        let min = 1;
        let max = clamp(gun['cost']/5 + 6, 1, 20);
        if (gun['force_unshuffle'] == 1) {
            min = 1;
            max = (gun['cost'] - 15)/5;
            if (max > 6) {
                max = 6 + (gun['cost'] - (15 + 6*5))/10;
            }
        }
        max = clamp(max, 1, 20);
        gun[variable] = clamp(prng.RandomDistribution(probs.min, probs.max, probs.mean, probs.sharpness), min, max);
        gun['cost'] -= (gun[variable] - 6)*5;
    }
    else if (variable == 'shuffle_deck_when_empty') {
        let r = prng.Random(0, 1);
        if (gun['force_unshuffle'] == 1) {
            r = 1;
            if (gun['cost'] < 15 + gun['deck_capacity']*5) {
                //console.log("Impossible?");
            }
        }
        if (r == 1 && gun['cost'] >= 15 + gun['deck_capacity']*5 && gun['deck_capacity'] <= 9) {
            gun[variable] = 0;
            gun['cost'] -= 15 + gun['deck_capacity']*5;
        }
        //console.log("Shuffle deck when empty: ", gun[variable], " Cost after: ", gun['cost'], 'rnd:', r);
    }
    else if (variable == 'actions_per_round') {
        let action_costs = [0, 5+gun['deck_capacity']*2, 15+gun['deck_capacity']*3.5, 35+gun['deck_capacity']*5, 45+gun['deck_capacity']*gun['deck_capacity']];
        let min = 1;
        let max = 1;
        for (let i = 0; i < 5; i++) {
            if (action_costs[i] <= gun['cost']) {
                max = i + 1;
            }
        }
        max = clamp(max, 1, gun['deck_capacity']);
        gun[variable] = Math.floor(clamp(prng.RandomDistribution(probs.min, probs.max, probs.mean, probs.sharpness), min, max));
        gun['cost'] -= action_costs[clamp(gun[variable], 1, 5)-1];
        //console.log("Actions per round: ", gun[variable], " Cost after: ", gun['cost']);
    }
}

function wandDiff(gun, wand) {
    let score = 0;
    score += Math.abs(gun['fire_rate_wait'] - wand[5]) * 2;
    score += Math.abs(gun['actions_per_round'] - wand[6]) * 20;
    score += Math.abs(gun['shuffle_deck_when_empty'] - wand[7]) * 30;
    score += Math.abs(gun['deck_capacity'] - wand[8]) * 5;
    score += Math.abs(gun['spread_degrees'] - wand[9]);
    score += Math.abs(gun['reload_time'] - wand[10]);
    return score;
}

function getWandSprite(gun, prng) {
    let bestWand = null;
    let bestScore = 1000;
    let gunInWandSpace = {
        'fire_rate_wait': clamp((gun['fire_rate_wait'] + 5)/7 - 1, 0, 4),
        'actions_per_round': clamp(gun['actions_per_round']-1, 0, 2),
        'shuffle_deck_when_empty': clamp(gun['shuffle_deck_when_empty'], 0, 1),
        'deck_capacity': clamp((gun['deck_capacity'] - 3)/3, 0, 7),
        'spread_degrees': clamp((gun['spread_degrees'] + 5)/5 - 1, 0, 2),
        'reload_time': clamp((gun['reload_time'] + 5)/25 - 1, 0, 2),
    };

    for (let i = 0; i < WAND_SHAPES.length; i++) {
        let score = wandDiff(gunInWandSpace, WAND_SHAPES[i]);
        if (score <= bestScore) {
            bestWand = WAND_SHAPES[i];
            bestScore = score;
            if (score == 0) {
                //console.log("Tiebreaking best wand");
                if (prng.Random(0, 100) < 33) break;
            }
        }
    }
    // Pad to 4 digits
    gun['grip'] = {x: bestWand[1], y: bestWand[2]};
    gun['tip'] = {x: bestWand[3], y: bestWand[4]};
    gun['sprite'] = `wand_${bestWand[0].toString().padStart(4, '0')}`;
}

function betterAddRandomCards(worldSeed, ngPlusCount, gun, x, y, level, prng) {
    // Stuff in the gun
    let good_cards = 5
    if (prng.Random(0, 100) < 7) good_cards = prng.Random(20,50);

    let is_rare = gun['is_rare'];
    if (is_rare) good_cards *= 2;

    let orig_level = level;
    level -= 1;
    let deck_capacity = gun['deck_capacity'];
    let actions_per_round = gun['actions_per_round'];
    let card_count = prng.Random(1, 3);
    let bullet_card = GetRandomActionWithType(x, y, level, PROJECTILE, worldSeed, 0);
    let card = "";
    let random_bullets = 0;
    let good_card_count = 0;

    if (prng.Random(0, 100) < 50 && card_count < 3) card_count += 1;
    if (prng.Random(0, 100) < 10 || is_rare == 1) card_count += prng.Random(1,2);

    good_cards = prng.Random(5, 45);
    card_count = prng.Random(roundHalfOfEven(0.51*deck_capacity), roundHalfOfEven(deck_capacity));
    card_count = clamp(card_count, 1, deck_capacity-1);
    gun['card_count'] = card_count;

    if (prng.Random(0,100) < orig_level*10 - 5) random_bullets = 1;

    if (prng.Random(0,100) < 4 || is_rare == 1) {
        let p = prng.Random(0, 100);
        if (p < 77) {
            card = GetRandomActionWithType(x, y, level+1, MODIFIER, worldSeed, 666);
        }
        else if (p < 85) {
            card = GetRandomActionWithType(x, y, level+1, MODIFIER, worldSeed, 666);
            good_card_count += 1;
        }
        else if (p < 93) {
            card = GetRandomActionWithType(x, y, level+1, STATIC_PROJECTILE, worldSeed, 666);
        }
        else {
            card = GetRandomActionWithType(x, y, level+1, PROJECTILE, worldSeed, 666);
        }
        gun['always_casts'] = [card.name];
    }
    else {
        gun['always_casts'] = [];
    }

    if (card_count < 3) {
        if (card_count > 1 && prng.Random(0,100) < 20) {
            card = GetRandomActionWithType(x, y, level, MODIFIER, worldSeed, 2);
            gun['cards'].push(card.name);
            card_count -= 1;
        }
        for (let i = 0; i < Math.floor(card_count); i++) {
            gun['cards'].push(bullet_card.name);
        }
    }
    else {
        if (prng.Random(0, 100) < 40) {
            card = GetRandomActionWithType(x, y, level, DRAW_MANY, worldSeed, 1);
            gun['cards'].push(card.name);
            card_count -= 1;
        }

        if (card_count > 3 && prng.Random(0, 100) < 40) {
            card = GetRandomActionWithType(x, y, level, DRAW_MANY, worldSeed, 1);
            gun['cards'].push(card.name);
            card_count -= 1;
        }

        if (prng.Random(0, 100) < 80) {
            card = GetRandomActionWithType(x, y, level, MODIFIER, worldSeed, 2);
            gun['cards'].push(card.name);
            card_count -= 1;
        }

        for (let i = 0; i < Math.floor(card_count); i++) {
            gun['cards'].push(bullet_card.name);
        }
    }
}

function addRandomCards(worldSeed, ngPlusCount, gun, x, y, level, prng) {
    // Stuff in the gun
    let good_cards = 5
    let firstRandomCall = prng.Random(0, 100);
    //console.log("First random call: ", firstRandomCall);
    if (firstRandomCall < 7) {
        good_cards = prng.Random(20,50);
    }

    let is_rare = gun['is_rare'];
    if (is_rare) good_cards *= 2;

    let orig_level = level;
    level -= 1;
    let deck_capacity = gun['deck_capacity'];
    let actions_per_round = gun['actions_per_round'];
    let card_count = prng.Random(1, 3);
    let bullet_card = GetRandomActionWithType(x, y, level, PROJECTILE, worldSeed, 0);
    let card = "";
    let random_bullets = 0;
    let good_card_count = 0;
    
    if (prng.Random(0, 100) < 50 && card_count < 3) card_count += 1;
    if (prng.Random(0, 100) < 10 || is_rare == 1) card_count += prng.Random(1,2);

    good_cards = prng.Random(5, 45);
    card_count = prng.Random(roundHalfOfEven(0.51*deck_capacity), roundHalfOfEven(deck_capacity));
    card_count = clamp(card_count, 1, deck_capacity-1);
    gun['card_count'] = card_count;

    if (prng.Random(0,100) < orig_level*10 - 5) random_bullets = 1;

    if (prng.Random(0,100) < 4 || is_rare == 1) {
        let p = prng.Random(0, 100);
        if (p < 77) {
            card = GetRandomActionWithType(x, y, level+1, MODIFIER, worldSeed, 666);
        }
        else if (p < 85) {
            card = GetRandomActionWithType(x, y, level+1, MODIFIER, worldSeed, 666);
            good_card_count += 1;
        }
        else if (p < 93) {
            card = GetRandomActionWithType(x, y, level+1, STATIC_PROJECTILE, worldSeed, 666);
        }
        else {
            card = GetRandomActionWithType(x, y, level+1, PROJECTILE, worldSeed, 666);
        }
        gun['always_casts'] = [card.name];
    }
    else {
        gun['always_casts'] = [];
    }

    if (prng.Random(0, 100) < 50) {
        let extra_level = level;
        while (prng.Random(1, 10) == 10) {
            extra_level += 1;
            bullet_card = GetRandomActionWithType(x, y, extra_level, PROJECTILE, worldSeed, 0);
        }
        if (card_count < 3) {
            if (card_count > 1 && prng.Random(0,100) < 20) {
                card = GetRandomActionWithType(x, y, level, MODIFIER, worldSeed, 2);
                gun['cards'].push(card.name);
                card_count -= 1;
            }
            for (let i = 0; i < Math.floor(card_count); i++) {
                gun['cards'].push(bullet_card.name);
            }
        }
        else {
            if (prng.Random(0, 100) < 40) {
                card = GetRandomActionWithType(x, y, level, DRAW_MANY, worldSeed, 1);
                gun['cards'].push(card.name);
                card_count -= 1;
            }
            if (card_count > 3 && prng.Random(0, 100) < 40) {
                card = GetRandomActionWithType(x, y, level, DRAW_MANY, worldSeed, 1);
                gun['cards'].push(card.name);
                card_count -= 1;
            }
            if (prng.Random(0, 100) < 80) {
                card = GetRandomActionWithType(x, y, level, MODIFIER, worldSeed, 2);
                gun['cards'].push(card.name);
                card_count -= 1;
            }
            for (let i = 0; i < Math.floor(card_count); i++) {
                gun['cards'].push(bullet_card.name);
            }
        }
    }
    else {
        for (let i = 0; i < Math.floor(card_count); i++) {
            let r = prng.Random(0, 100);
            //console.log(x, y, good_cards, card_count, r);
            if (r < good_cards && card_count > 2) {
                if (good_card_count == 0 && actions_per_round == 1) {
                    card = GetRandomActionWithType(x, y, level, DRAW_MANY, worldSeed, i + 1);
                    good_card_count += 1;
                }
                else {
                    if (prng.Random(0, 100) < 83) {
                        card = GetRandomActionWithType(x, y, level, MODIFIER, worldSeed, i + 1);
                    }
                    else {
                        card = GetRandomActionWithType(x, y, level, DRAW_MANY, worldSeed, i + 1);
                    }
                }
                gun['cards'].push(card.name);
            }
            else {
                gun['cards'].push(bullet_card.name);
                if (random_bullets == 1) {
                    bullet_card = GetRandomActionWithType(x, y, level, PROJECTILE, worldSeed, i + 1);
                }
            }
        }
    }
}


export function generateGunStandalone(rngState, type) {
    const typeData = WAND_TYPES[type];
    let wandType = typeData['type'];
    let cost = typeData['cost'];
    let level = typeData['level'];
    let force_unshuffle = typeData['force_unshuffle'];
    let gun = {};
    const prng = new NollaPrng(rngState);
    prng.Prev(); // Undo the initial increment...
    
    gun['cards'] = [];
    gun['level'] = level;
    gun['cost'] = cost;
    if (level == 1) {
        if (prng.Random(0, 100) < 50) {
            gun['cost'] += 5;
        }
    }
    const firstCostRoll = prng.Random(-3, 3);
    if (firstCostRoll < 3) {
        //return null;
    }
    gun['cost'] += firstCostRoll;
    gun["deck_capacity"] = 0
    gun["actions_per_round"] = 0
    gun["reload_time"] = 0
    gun["shuffle_deck_when_empty"] = 1
    gun["fire_rate_wait"] = 0
    gun["spread_degrees"] = 0
    gun["speed_multiplier"] = 0
    gun["prob_unshuffle"] = 0.1
    gun["prob_draw_many"] = 0.15
    gun['mana_charge_speed'] = 50*level + prng.Random(-5, 5*level);
    gun['mana_max'] = 50 + 150*level + prng.Random(-5, 5)*10;
    gun['force_unshuffle'] = 0;
    gun['is_rare'] = 0;
    gun['wand_type'] = wandType;

    let p = prng.Random(0, 100);
    if (p < 20) {
        gun['mana_charge_speed'] = ( 50*level + prng.Random(-5, 5*level) ) / 5;
        gun['mana_max'] = ( 50 + 150*level + prng.Random(-5, 5)*10 ) * 3;
        if (wandType == 'better' && gun['mana_charge_speed'] < 10) gun['mana_charge_speed'] = 10;
    }

    p = prng.Random(0, 100);
    if (wandType == 'better') {
        if (p < 15 + level*6) {
            gun['force_unshuffle'] = 1;
        }
    }
    else {
        if (p < 15) {
            gun['mana_charge_speed'] = ( 50*level + prng.Random(-5, 5*level) ) * 5;
            gun['mana_max'] = ( 50 + 150*level + prng.Random(-5, 5)*10 ) / 3;
        }

        if (gun['mana_max'] < 50) gun['mana_max'] = 50;
        if (gun['mana_charge_speed'] < 10) gun['mana_charge_speed'] = 10;
        
        p = prng.Random(0, 100);
        if (p < 15 + level*6) {
            gun['force_unshuffle'] = 1;
        }
    }

    let is_rare = 0;
    p = prng.Random(0, 100);
    if (p < 5) {
        is_rare = 1;
        gun['is_rare'] = 1;
        gun['cost'] += 65;
    }
    else {
        //return null;
    }

    let vars1 = ["reload_time", "fire_rate_wait", "spread_degrees", "speed_multiplier"];
    let vars2 = ["deck_capacity"];
    let vars3 = ["shuffle_deck_when_empty", "actions_per_round"];
    //let vars3 = ["actions_per_round", "shuffle_deck_when_empty"];

    shuffleTable(vars1, prng);
    if (gun['force_unshuffle'] != 1) shuffleTable(vars3, prng);

    for (let v of vars1) {
        applyRandomVariable(gun, v, prng);
    }
    for (let v of vars2) {
        applyRandomVariable(gun, v, prng);
    }
    for (let v of vars3) {
        applyRandomVariable(gun, v, prng);
    }

    // What if capacity is not an integer??
    //console.log("Current gun cost:", gun['cost']);
    if (gun['cost'] > 5) {
        let rareNonincreaseRoll = prng.Random(0, 1000);
        //console.log("Rare non-increase roll: ", rareNonincreaseRoll);
        if (rareNonincreaseRoll < 995) {
            if (gun['shuffle_deck_when_empty'] == 1) {
                gun['deck_capacity'] += gun['cost']/5;
                gun['cost'] = 0;
            }
            else {
                gun['deck_capacity'] += gun['cost']/10;
                gun['cost'] = 0;
            }
        }
        else {
            //return null;
        }
    }

    if (wandType == 'better') {
        let name = GUN_NAMES[prng.Random(0, GUN_NAMES.length-1)];
        gun['name'] = name + " Wand";
    }
    else {
        gun['name'] = "Wand";
    }

    if (force_unshuffle) gun['shuffle_deck_when_empty'] = 0;
    gun['original_force_unshuffle'] = force_unshuffle ? 1 : 0;

    let rareCapacityRoll = prng.Random(0, 10000);
    //console.log("Rare capacity roll: ", rareCapacityRoll);
    if (rareCapacityRoll <= 9999) {
        gun['deck_capacity'] = clamp(gun['deck_capacity'], 2, 26);
    }
    else {
        //return null;
    }
    if (gun['deck_capacity'] <= 1) gun['deck_capacity'] = 2;

    if (gun['reload_time'] >= 60) {
        function random_add_actions_per_round(prng) {
            gun['actions_per_round'] += 1;
            if (prng.Random(0,100) < 70) {
                random_add_actions_per_round(prng);
            }
        }
        random_add_actions_per_round(prng);
        if (prng.Random(0, 100) < 50) {
            let new_actions_per_round = +gun['deck_capacity'];
            for (let i = 1; i <= 6; i++) {
                let temp_actions_per_round = prng.Random(roundHalfOfEven(gun['actions_per_round']), roundHalfOfEven(gun['deck_capacity']));
                if (temp_actions_per_round < new_actions_per_round) {
                    new_actions_per_round = temp_actions_per_round;
                }
            }
            gun['actions_per_round'] = new_actions_per_round;
        }
    }

    gun['actions_per_round'] = clamp(gun['actions_per_round'], 1, gun['deck_capacity']);

    // Note: normal wands, not "better"
    getWandSprite(gun, prng);

    // Ignore cards, only care about capacity right now
    return gun;
}



// Done:
// - wand_level_10 (GTC, sometimes)
// - wand_unshuffle_10 (tiny drops)
// - wand_level_03 (summon taikasauva)
// - next: idk, any of the others

// Search all RNG states
// Obviously this takes a long time
// Start after timer
/*
console.log("Waiting a few seconds before starting search...");
await new Promise(resolve => setTimeout(resolve, 3000));
console.log("Starting search...");
const wandType = 'wand_level_03';
let sprites = {};
for (let i = 0; i <= 1000; i++) {
    sprites[`wand_${i.toString().padStart(4, '0')}`] = 0;
}
// Math.pow(2, 31)
for (let rngState = 1; rngState < Math.pow(2, 31); rngState++) {
    if (rngState % 100000 == 0) {
        console.log("Current RNG state: ", rngState);
    }
    let gun = generateGunStandalone(rngState, wandType);
    const sprite = gun['sprite'];
    sprites[sprite] += 1;
}
console.log("Sprite distribution: ");
console.log(sprites);
*/

/*
// Testing searching for high capacity tiny drops
import { generateGreatChest } from "./chest_generation.js";
await new Promise(resolve => setTimeout(resolve, 1000));
const ws = 1;
const xRange = 5000;
const yRange = 5000;
const prng = new NollaPrng(0);
const targets = [3406723, 87644592, 98987024, 116746801, 127167206, 176438691, 223686187, 331691464, 382586391, 406446516, 407256995, 428926629, 457873179, 474882453, 530608656, 542453834, 625533663, 626488460, 672205875, 684186837, 699260358, 747329723, 749704380, 784424248, 787358829, 800603364, 829051950, 851354919, 935288693, 1023404628, 1061158147, 1117826769, 1127611365, 1139632766, 1164098726, 1175763940, 1240330683, 1276343978, 1280302705, 1305504029, 1419160939, 1426802862, 1442487036, 1461934982, 1467111195, 1490667949, 1559102803, 1571121943, 1603558497, 1605161222, 1605494952, 1611121562, 1621482946, 1629465177, 1662990383, 1666382961, 1698608822, 1711194057, 1743884798, 1807437035, 1862663193, 1938685279, 1946573235, 1957767919, 1969033642, 2014173601, 2045548722, 2068686793, 2081797850];
// I think I entered these wrong because I didn't take into account the initial Next() call in the constructor
for (let i = 0; i < targets.length; i++) {
    prng.Seed = targets[i];
    prng.Next();
    //console.log(targets[i], '->', prng.Seed);
    //prng.Prev();
    targets[i] = prng.Seed;
}
//prng.FindCoordinates(1240330683, 3, 5000);
const results = prng.SearchForCoordinates(targets, ws, xRange, yRange)
console.log(results);
for (let i = 0; i < results.length; i++) {
    const { x, y, s } = results[i];
    const gun = generateGun(ws, 0, 'normal', 200, 11, false, x, y, false);
    // Compare GTC?
    const chest = generateGreatChest(ws, 0, x, y, {});
    console.log(chest);
    prng.Seed = s;
    prng.Prev();
    let gun2 = generateGunStandalone(prng.Seed);
    if (gun['deck_capacity'] >= 66) console.log('!!!');
    console.log(gun);
    console.log(gun2);
}
console.log("Done finding coordinates.");
*/

/*
const T4 = new Set(await readJson('./data/rng/t4_high_capacity_seeds.json'));
const T4NS = new Set(await readJson('./data/rng/t4ns_high_capacity_seeds.json'));
const T5 = new Set(await readJson('./data/rng/t5_high_capacity_seeds.json'));
const T5NS = new Set(await readJson('./data/rng/t5ns_high_capacity_seeds.json'));
const T6 = new Set(await readJson('./data/rng/t6_high_capacity_seeds.json'));
const T6NS = new Set(await readJson('./data/rng/t6ns_high_capacity_seeds.json'));
const T10 = new Set(await readJson('./data/rng/t10_high_capacity_seeds.json'));
const T10NS = new Set(await readJson('./data/rng/t10ns_high_capacity_seeds.json'));

let capacity_counts = {};
for (let i = 2; i <= 66; i++) {
    capacity_counts[i] = 0;
}

const valid_eoe_seeds = new Set();
for (let seed of T4) {
	const chest = generateGreatChestStandalone(seed);
	for (let item of chest.items) {
		if (item.type === 'wand') {
			const tier = item.wandType;
			// Check if tier is valid
            if (tier === 'wand_level_04') {
                valid_eoe_seeds.add(seed);
                const wand = generateGunStandalone(seed, tier);
                if (wand['is_rare']) continue;
                capacity_counts[Math.floor(wand['deck_capacity'])] += 1;
            }
		}
	}
}
for (let seed of T4NS) {
	const chest = generateGreatChestStandalone(seed);
	for (let item of chest.items) {
		if (item.type === 'wand') {
			const tier = item.wandType;
			// Check if tier is valid
            if (tier === 'wand_unshuffle_04') {
                valid_eoe_seeds.add(seed);
                const wand = generateGunStandalone(seed, tier);
                if (wand['is_rare']) continue;
                capacity_counts[Math.floor(wand['deck_capacity'])] += 1;
            }
		}
	}
}
for (let seed of T5) {
	const chest = generateGreatChestStandalone(seed);
	for (let item of chest.items) {
		if (item.type === 'wand') {
			const tier = item.wandType;
			// Check if tier is valid
            if (tier === 'wand_level_05') {
                valid_eoe_seeds.add(seed);
                const wand = generateGunStandalone(seed, tier);
                if (wand['is_rare']) continue;
                capacity_counts[Math.floor(wand['deck_capacity'])] += 1;
            }
		}
	}
}
for (let seed of T5NS) {
	const chest = generateGreatChestStandalone(seed);
	for (let item of chest.items) {
		if (item.type === 'wand') {
			const tier = item.wandType;
			// Check if tier is valid
            if (tier === 'wand_unshuffle_05') {
                valid_eoe_seeds.add(seed);
                const wand = generateGunStandalone(seed, tier);
                if (wand['is_rare']) continue;
                capacity_counts[Math.floor(wand['deck_capacity'])] += 1;
            }
		}
	}
}
for (let seed of T6) {
	const chest = generateGreatChestStandalone(seed);
	for (let item of chest.items) {
		if (item.type === 'wand') {
			const tier = item.wandType;
			// Check if tier is valid
            if (tier === 'wand_level_06') {
                valid_eoe_seeds.add(seed);
                const wand = generateGunStandalone(seed, tier);
                if (wand['is_rare']) continue;
                capacity_counts[Math.floor(wand['deck_capacity'])] += 1;
            }
		}
	}
}
for (let seed of T6NS) {
	const chest = generateGreatChestStandalone(seed);
	for (let item of chest.items) {
		if (item.type === 'wand') {
			const tier = item.wandType;
			// Check if tier is valid
            if (tier === 'wand_unshuffle_06') {
                valid_eoe_seeds.add(seed);
                const wand = generateGunStandalone(seed, tier);
                if (wand['is_rare']) continue;
                capacity_counts[Math.floor(wand['deck_capacity'])] += 1;
            }
		}
	}
}
for (let seed of T10) {
	const chest = generateGreatChestStandalone(seed);
	for (let item of chest.items) {
		if (item.type === 'wand') {
			const tier = item.wandType;
			// Check if tier is valid
            if (tier === 'wand_level_10') {
                valid_eoe_seeds.add(seed);
                const wand = generateGunStandalone(seed, tier);
                if (wand['is_rare']) continue;
                capacity_counts[Math.floor(wand['deck_capacity'])] += 1;
            }
		}
	}
}
console.log("Valid EoE seeds: ")
console.log(Array.from(valid_eoe_seeds).sort((a, b) => a - b));
console.log("Capacity counts: ")
console.log(capacity_counts);

capacity_counts = {};
for (let i = 2; i <= 66; i++) {
    capacity_counts[i] = 0;
}

for (let seed of T6NS) {
    const wand = generateGunStandalone(seed, 'wand_unshuffle_06');
    if (wand['is_rare']) continue;
    capacity_counts[Math.floor(wand['deck_capacity'])] += 1;
}

console.log('T6NS capacity counts: ');
console.log(capacity_counts);

capacity_counts = {};
for (let i = 2; i <= 66; i++) {
    capacity_counts[i] = 0;
}

for (let seed of T10NS) {
    const wand = generateGunStandalone(seed, 'wand_unshuffle_10');
    if (wand['is_rare']) continue;
    capacity_counts[Math.floor(wand['deck_capacity'])] += 1;
}

console.log('T10NS capacity counts: ');
console.log(capacity_counts);
*/

/*
const orb_seeds = [];
const high_y_seeds = [];
const y_values = {};
const prng = new NollaPrng(0);
// Ensure x = 400
for (let seed = 2144802644; seed <= 2147483647; seed++) {
    prng.Seed = seed;
    prng.Prev();

    if (prng.Random(0, 100000) === 100000) {
        if (prng.Random(0, 1000) === 999) {
            // Orb
            orb_seeds.push(seed);
            prng.Seed = seed;
            prng.Prev();
            const x = prng.Random(-400, 400);
            if (x !== 400) console.log("Error: x is not 400 for seed ", seed);
            const y = prng.Random(-400, 400);
            if (y_values[y] === undefined) {
                y_values[y] = 0;
            }
            y_values[y] += 1;
        }
    }

    prng.Seed = seed;
    if (prng.Random(-400, 400) === 399) {
        high_y_seeds.push(seed);
    }
}
console.log(y_values);
console.log("Orb seeds: ", orb_seeds);
console.log("High Y seeds: ", high_y_seeds);
*/