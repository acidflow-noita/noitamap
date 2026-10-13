// Adapted into the owned Noitamap rules runtime. See NOTICE.txt for provenance.
import { NollaPrng } from "./nolla_prng.js";
import { generateShopItem } from "./spell_generator.js";
import { createWand } from "./wand_generation.js";
import { WAND_TYPES } from "./wand_config.js";
import { generateChest } from "./chest_generation.js";
import { getWorldSize } from "./utils.js";

const templeX = [-32, -32, -32, -32, -32, -32, 2560];
const templeY = [1410, 2946, 4994, 6530, 8578, 10626, 13181];
const templeTiers = [0, 1, 2, 2, 3, 4, 6];

const templeXNGPlus = [-32, -32, -32, -32, 2560];
const templeYNGPlus = [1410, 2946, 6530, 10626, 13181];
const templeTiersNGPlus = [0, 1, 2, 4, 6];

const templeXNightmare = [-32, -32, -32, -32, 2560];
const templeYNightmare = [1410, 3970, 6530, 10626, 13181];
const templeTiersNightmare = [0, 2, 2, 4, 6];

// TODO: NG+ temples have different locations

export function generateHolyMountainShops(ws, ng, pwIndex, perks = {}, gameMode = 'normal') {
    const isNGPlus = ng > 0;
    const worldSize = getWorldSize(isNGPlus, gameMode);
    const extraShopItems = perks['extraShopItems'] ? perks['extraShopItems'] : 0;
    //const greedCurse = perks['greedCurse'] ? perks['greedCurse'] : false;
    const noMoreShuffle = perks['noMoreShuffle'] ? perks['noMoreShuffle'] : false;
    // Pacifist chest
    let templeLoot = [];
    // Note: No pacifist chest in last holy mountain!
    for (let hmIndex = 0; hmIndex < 6 - (isNGPlus || gameMode === 'nightmare' ? 2 : 0); hmIndex++) {
        // TODO: Change to 64 for NG+
        let x = (isNGPlus ? templeXNGPlus : gameMode === 'nightmare' ? templeXNightmare : templeX)[hmIndex] - 46 + pwIndex * 512 * worldSize;
        let y = (isNGPlus ? templeYNGPlus : gameMode === 'nightmare' ? templeYNightmare : templeY)[hmIndex] - 39;
        let chest = generateChest(ws, ng, x, y, perks, gameMode);
        chest['type'] = 'pacifist_chest';
        chest['biome'] = 'temple_altar';
        templeLoot.push(chest);
    }

    // Shop
    let prng = new NollaPrng(0);
    let width = 132;
    let itemCount = extraShopItems + 5; // Note: 5 + extraShopItems would give 5 + "0" = 50... Wtf JavsScript. It shouldn't be a string anyway
    let stepSize = width / itemCount;
    for (let hmIndex = 0; hmIndex < (pwIndex == 0 ? 7 : 6) - (isNGPlus || gameMode === 'nightmare' ? 2 : 0); hmIndex++) {
        let x = (isNGPlus ? templeXNGPlus : gameMode === 'nightmare' ? templeXNightmare : templeX)[hmIndex] - 299 + pwIndex * 512 * worldSize;
        let y = (isNGPlus ? templeYNGPlus : gameMode === 'nightmare' ? templeYNightmare : templeY)[hmIndex] - 15;
        let tier = (isNGPlus ? templeTiersNGPlus : gameMode === 'nightmare' ? templeTiersNightmare : templeTiers)[hmIndex];
        prng.SetRandomSeed(ws+ng, x, y);
        let saleItem = prng.Random(0, itemCount - 1);
        let sellWands = prng.Random(0, 100) > 50;
        if (sellWands) {
            let wandList = [];
            for (let i = 0; i < itemCount; i++) {
                let shopWand = getShopWand(ws, ng, x + i*stepSize, y, Math.max(1, tier), noMoreShuffle);
				if (i === saleItem) shopWand['is_sale'] = true; // Really just adding this to avoid the warning for unused variable lol
                wandList.push(shopWand);
            }
            templeLoot.push({type: 'holy_mountain_shop', items: wandList, x: x, y: y, biome: 'temple_altar'});
        }
        else {
            let spellList = [];
            for (let i = 0; i < itemCount; i++) {
                //console.log(hmIndex, i, x + i*stepSize, y, tier);
                spellList.push(generateShopItem(ws, ng, Math.fround(x + i*stepSize), y - 30, tier, 0));
                spellList.push(generateShopItem(ws, ng, Math.fround(x + i*stepSize), y, tier, 0));
            }
            templeLoot.push({type: 'holy_mountain_shop', items: spellList, x: x, y: y, biome: 'temple_altar'});
        }
    }
    //console.log(`Generated holy mountain shops with ${templeLoot.map(shop => shop.items.length)} items.`);
    return templeLoot;
}



function getShopWand(ws, ng, x, y, tier, noMoreShuffle = false) {
    let prng = new NollaPrng(0);
    prng.SetRandomSeed(ws+ng, x, y);
    let shuffle = prng.Random(0, 100) <= 50;
    let wand_type_name = 'wand_' + (shuffle ? 'level_' : 'unshuffle_') + ('0' + tier);
    return createWand(ws, ng, Math.round(x), Math.round(y), WAND_TYPES[wand_type_name], false, noMoreShuffle);
}