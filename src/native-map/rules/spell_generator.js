// Adapted into the owned Noitamap rules runtime. See NOTICE.txt for provenance.
import { NollaPrng } from './nolla_prng.js';
import { ALL_SPELLS } from './spells.js';
import { unlockedSpells } from './unlocks.js';

// Returns just the string
export function GetRandomActionWithType(x, y, level, type, worldSeed, offset = 0) {
    if (level > 10) level = 10;
    const prng = new NollaPrng(0);
    // I thought I forgot to add it, but it's actually *incorrect* to add the NG+ count here! The game does not include the plus count here!
    prng.SetRandomSeed(worldSeed + offset, x, y);
    
    let sum = 0.0;
    
    // 1. Calculate total weight for valid spells
    for (let i = 0; i < ALL_SPELLS.length; i++) {
        if (!unlockedSpells[i]) continue;
        
        const spell = ALL_SPELLS[i];
        if (spell.type === type) {
            sum += spell.spawn_probabilities[level];
        }
    }

    // 2. Random Selection
    const multiplier = prng.Next();
    let accumulated = sum * multiplier;

    for (let i = 0; i < ALL_SPELLS.length; i++) {
        if (!unlockedSpells[i]) continue;
        
        const spell = ALL_SPELLS[i];
        if (spell.type !== type) continue;
        
        const probability = spell.spawn_probabilities[level];
        
        // Python: if probability > 0.0 and probability >= accumulated:
        if (probability > 0.0 && probability >= accumulated) {
            return spell;
        }
        accumulated -= probability;
    }
    //console.log("Warning: could not find spell for ", x, y, level, type, worldSeed, offset);
    return '';

    /*
    // 3. Fallback (if weights fail)
    const rand = Math.floor(prng.Next() * ALL_SPELLS.length); // int(prng.Next() * count)
    
    for (let j = 0; j < ALL_SPELLS.length; j++) {
        const index = (j + rand) % ALL_SPELLS.length;
        const spell = ALL_SPELLS[index];
        
        if (spell.type === type && spell.spawn_probabilities[level] > 0.0) {
            if (!unlockedSpells[index]) continue;
            return spell;
        }
    }

    return null;
    */
}

// Returns just the string
export function GetRandomAction(ws, ng, x, y, level, offset = 0) {
    if (!level) {
        // Level for default is based on depth
        const depthScale = Math.floor(y/512);
        if (depthScale <= 3) level = 0;
        else if (depthScale <= 6) level = 1;
        else if (depthScale <= 12) level = 2;
        else if (depthScale <= 16) level = 3;
        else if (depthScale <= 20) level = 4;
        else if (depthScale <= 24) level = 5;
        else if (depthScale <= 33) level = 6;
        // Weird missing range?
        else if (depthScale > 35) level = 7;
        else level = 0;
    }
    if (level > 10) level = 10; // Probably not necessary?

    const prng = new NollaPrng(0);
    // I thought I forgot to add it, but it's actually *incorrect* to add the NG+ count here! The game does not include the plus count here!
    prng.SetRandomSeed(ws + offset, x, y);
    
    let sum = 0.0;
    
    // 1. Calculate total weight for valid spells
    for (let i = 0; i < ALL_SPELLS.length; i++) {
        if (!unlockedSpells[i]) continue;
        
        const spell = ALL_SPELLS[i];
        sum += spell.spawn_probabilities[level];
    }

    // 2. Random Selection
    const multiplier = prng.Next();
    let accumulated = sum * multiplier;

    for (let i = 0; i < ALL_SPELLS.length; i++) {
        if (!unlockedSpells[i]) continue;
        
        const spell = ALL_SPELLS[i];
        
        const probability = spell.spawn_probabilities[level];
        
        // Python: if probability > 0.0 and probability >= accumulated:
        if (probability == 0.0) continue; // Skip spells that can't spawn at this level
        if (probability >= accumulated) {
            return spell.name;
        }
        accumulated -= probability;
    }
    // Turns out this is actually expected sometimes, and causes wands to generate with no spells
    //console.log("Warning: could not find spell for ", ws, x, y, level, offset);
    return '';
}

export function MakeRandomSpell(prng) {
    let spell = '';
    let valid = false;
    //let attempts = 0;
    while (!valid) {
        //attempts += 1;
        let itemno = prng.Random(1, ALL_SPELLS.length);
        //console.log(`MakeRandomSpell roll #${attempts}: ${itemno} (${ALL_SPELLS[itemno-1].name})`);
        if (!unlockedSpells[itemno-1]) continue;
        if (!(ALL_SPELLS[itemno-1].can_spawn)) continue;
        spell = ALL_SPELLS[itemno-1].name;
        valid = true;
    }
    //console.log(`MakeRandomSpell attempts: ${attempts}`);
    return spell; // Just the string, used for adding to wands
}

export function MakeRandomUtilitySpell(prng) {
	let spell = '';
	let valid = false;
	while (!valid) {
		let itemno = prng.Random(1, ALL_SPELLS.length);
		if (!unlockedSpells[itemno-1]) continue;
		if (!(ALL_SPELLS[itemno-1].can_spawn_in_boxes)) continue;
		spell = ALL_SPELLS[itemno-1].name;
		valid = true;
	}
	return {type: 'item', item: 'spell', spell: spell}; // Doesn't include x or y, but it's always inside a utility box and added there
}

export function generateShopItem(ws, ng, x, y, tier, offset=0) {
    return {type: 'item', item: 'spell', spell: GetRandomAction(ws, ng, x, y, tier, offset), x: x, y: y};
}


/*
// Debug spell generation to see if there is some offset nearby that works for getting the right spell here
// All unlocks: Actual spell ANTIHEAL, predicted spell SPIRAL_SHOT
// No unlocks: Actual spell HEAL_BULLET, predicted spell MAGIC_SHIELD
import { setUnlocks, UNLOCKABLES } from './unlocks.js';
setUnlocks([]); // No unlocks for testing
//setUnlocks(Object.keys(UNLOCKABLES)); // Unlock everything for testing
const basePos = {x: -2760, y: 9811}; // Vault shop second spell
const ws = 786433191;
const ng = 0;
const tier = 4;
for (let dx = 0; dx <= 0; dx++) {
    for (let dy = 0; dy <= 0; dy++) {
        const pos = {x: basePos.x + dx, y: basePos.y + dy};
        const spell = generateShopItem(ws, ng, pos.x, pos.y, tier);
        console.log(`Spell at (${pos.x}, ${pos.y}): ${spell.spell}`);
    }
}
*/