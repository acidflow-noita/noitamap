// Adapted into the owned Noitamap rules runtime. See NOTICE.txt for provenance.
// js/nolla_prng.js
import { advanceRandomState } from '../random-step.js';

const _buf = new ArrayBuffer(8);
const _dv = new DataView(_buf);

export class NollaPrng {
    constructor(seed) {
        this.Seed = seed;
        this.Next();
    }

    static f2i(val) {
        _dv.setFloat64(0, val, true);
        return _dv.getBigUint64(0, true);
    }

    static i2f(val) {
        _dv.setBigUint64(0, val, true);
        return _dv.getFloat64(0, true);
    }

    static Helper1(r) {
        let e = NollaPrng.f2i(r);
        const upper = Number((e >> 32n) & 0x7fffffffn);

        if (upper < 0x7ff00000 && r >= -9.223372036854776e+18 && r < 9.223372036854776e+18) {
            e &= 0x7FFFFFFFFFFFFFFFn;
            let s = NollaPrng.i2f(e);
            let i = 0n;
            if (s !== 0.0) {
                let f = (e & 0xfffffffffffffffn) | 0x0010000000000000n;
                let h = f >> (0x433n - (e >> 52n));
                let exp = (e >> 32n) >> 20n;
                let j = exp > 0x433n ? -1n : 0n;
                
                i = (j << 32n) | (j & 0xFFFFFFFFn);
                
                let s_int = BigInt(Math.floor(s));
                let shift = (s_int >> 52n) - 0x433n;
                if (shift < 0n) shift = 0n;
                
                i = (~i & h) | ((f << shift) & i);
                let eq = (r === s) ? -1n : 0n;
                i = (~eq & -i) | (i & eq);
            }
            return Number(i & 0xFFFFFFFFn);
        }
        return 0; // Error fallback
    }

    static Helper2(a, b, ws) {
        a >>>= 0; b >>>= 0; ws >>>= 0;
        let u2 = ((a - b) - ws) ^ (ws >>> 13); u2 >>>= 0;
        let u1 = ((b - u2) - ws) ^ (u2 << 8); u1 >>>= 0;
        let u3 = ((ws - u2) - u1) ^ (u1 >>> 13); u3 >>>= 0;
        u2 = ((u2 - u1) - u3) ^ (u3 >>> 12); u2 >>>= 0;
        u1 = ((u1 - u2) - u3) ^ (u2 << 16); u1 >>>= 0;
        u3 = ((u3 - u2) - u1) ^ (u1 >>> 5); u3 >>>= 0;
        u2 = ((u2 - u1) - u3) ^ (u3 >>> 3); u2 >>>= 0;
        u1 = ((u1 - u2) - u3) ^ (u2 << 10); u1 >>>= 0;
        return (((u3 - u2) - u1) ^ (u1 >>> 15)) >>> 0;
    }

    // --- Public Methods ---

    SetRandomFromWorldSeed(s) {
        this.Seed = s;
        if (this.Seed >= 2147483647.0) {
            this.Seed = s * 0.5;
        }
    }

    SetRandomSeed(ws, x, y) {
        let a = (ws ^ 0x93262e6f) >>> 0;
        let b = a & 0xfff;
        let c = (a >>> 12) & 0xfff;
        let x_ = x + b;
        let y_ = y + c;
        let r = x_ * 134217727.0;
        //let e = NollaPrng.Helper1(r); 
        // Turns out this is a much simpler way to get the same result, with some edge cases fixed
        let e = (r & 0xffffffff) >>> 0;

        // Clearing the binary64 sign bit is abs, including signed zero and
        // infinities. NaN remains false in both ordered comparisons.
        if (Math.abs(y_) >= 102400.0 || Math.abs(x_) <= 1.0) {
            r = y_ * 134217727.0;
        } else {
            let y__ = y_ * 3483.328;
            y__ += e;
            y_ *= y__;
            r = y_;
        }

        //let f = NollaPrng.Helper1(r);
        // Again fix edge case
        let f = r ? (r & 0xffffffff) >>> 0 : 2; 
        let g = NollaPrng.Helper2(e, f, ws);
        let s = g;
        s /= 4294967295.0;
        s *= 2147483639.0;
        s += 1.0;
        this.Seed = s >>> 0;

        this.Next();

        let h = ws & 3;
        while (h > 0) {
            this.Next();
            h--;
        }
    }

    InvertFinalSeed(targetSeed, ws) {
        this.Seed = targetSeed;
        console.log("Starting GetPosition with targetSeed: ", targetSeed, " ws: ", ws);
        
        // 1. Revert the "Next" calls based on ws % 4
        let h = ws & 3;
        while (h >= 0) { // h >= 0 because there's always one initial Next() in constructor
            this.Prev();
            h--;
        }
        let t = this.Seed; // This is the 't' from SetRandomSeed
        console.log("After reverting Next calls, T: ", t);
        return t;
    }
    
    FindPotentialGs(t) {
        // 2. Invert the 't' calculation to find potential 'g' values
        // Since t = ~g / 2, we check values around 2t and 2t+1
        let potentialGs = [];
        for (let g_cand = (t << 1) >>> 0; g_cand <= ((t << 1) + 100) >>> 0; g_cand++) {
            if (this.TestG(g_cand) === t) {
                potentialGs.push(g_cand);
                console.log("Potential G: ", g_cand);
            }
        }
        return potentialGs;
    }

    // Helper to check if a candidate G produces the target T
    TestG(g) {
        const diddle = [0, 4, 6, 25, 12, 39, 52, 9, 21, 64, 78, 92, 104, 118, 18, 32, 44];
        const magic = 252645135;
        let t = g;
        t = (t + (g < 2147483648 ? 1 : 0) + (g === 0 ? 1 : 0)) >>> 0;
        t = (t - Math.floor(g / magic)) >>> 0;
        let idx = Math.floor(g / magic);
        if (idx >= 0 && idx < diddle.length) {
            if ((g % magic < diddle[idx]) && (g < 0xc3c3c3c3 + 4 || g >= 0xc3c3c3c3 + 62)) {
                t = (t + 1) >>> 0;
            }
        }
        t = (t + (g > 0x80000000 ? 1 : 0)) >>> 1;
        t = (t + (g === 0xffffffff ? 1 : 0)) >>> 0;
        return t;
    }

    FirstPart(ws, x, y) {
        let a = (ws ^ 0x93262e6f) >>> 0;
        let b = a & 0xfff;
        let c = (a >>> 12) & 0xfff;
        let x_ = x + b;
        let y_ = y + c;

        let r = x_ * 134217727.0;
        //let e = NollaPrng.Helper1(r); 
        // Turns out this is a much simpler way to get the same result, with some edge cases fixed
        let e = r ? (r & 0xffffffff) >>> 0 : 2;

        let _x = NollaPrng.f2i(x_) & 0x7fffffffffffffffn;
        let _y = NollaPrng.f2i(y_) & 0x7fffffffffffffffn;

        if (NollaPrng.i2f(_y) >= 102400.0 || NollaPrng.i2f(_x) <= 1.0) {
            r = y_ * 134217727.0;
        } else {
            let y__ = y_ * 3483.328;
            y__ += e;
            y_ *= y__;
            r = y_;
        }

        //let f = NollaPrng.Helper1(r);
        // Again fix edge case
        let f = r ? (r & 0xffffffff) >>> 0 : 2; 
        return {e, f};
    }

    FindCoordinates(targetSeed, ws, xRange) {
        // 1. Get the 't' value from the target seed (the state before Next calls)
        let t = this.InvertFinalSeed(targetSeed, ws); 
        
        // 2. Get potential 'g' values (usually 1 or 2)
        let potentialGs = this.FindPotentialGs(t);

        // 3. For each potential 'g', try to find (x, y) pairs that produce it
        let coords = [];
        for (let x = -xRange; x <= xRange; x++) {
            if (x % 1000 == 0) {
                console.log(`Checking x: ${x} / ${xRange}`);
            }
            for (let y = -xRange; y <= xRange; y++) {
                let {e, f} = this.FirstPart(ws, x, y);
                let g = NollaPrng.Helper2(e, f, ws);
                if (potentialGs.includes(g)) {
                    coords.push({x, y});
                    console.log(`Found potential coordinates: (${x}, ${y}) for G: ${g}`);
                }
            }
        }
        return coords;
    }

    SearchForCoordinates(targetSeeds, ws, xRange, yRange) {
        if (targetSeeds.length === 0) return [];
        // Convert single target to array if needed
        if (targetSeeds.length === undefined) {
            targetSeeds = [targetSeeds];
        }
        // Convert to lookup set for faster checks
        const targetSet = new Set(targetSeeds);
        let foundCoords = [];
        for (let x = -xRange; x <= xRange; x++) {
            if (x % 1000 == 0) {
                console.log(`Checking x: ${x} / ${xRange}`);
            }
            for (let y = -yRange; y <= yRange; y++) {
                this.SetRandomSeed(ws, x, y);
                let s = this.Seed;
                if (targetSet.has(s)) {
                    foundCoords.push({x, y, s});
                    console.log(`Found potential coordinates: (${x}, ${y}) for Seed: ${s}`);
                }
            }
        }
        return foundCoords;
    }


    Next() {
        this.Seed = advanceRandomState(this.Seed);
        return this.Seed / 2147483647.0;
    }

    Prev() {
        let s = BigInt(Math.floor(this.Seed));
        let v4 = (1407677000n * s) % 2147483647n;
        if (v4 <= 0n) v4 += 2147483647n;
        this.Seed = Number(v4);
        return this.Seed / 2147483647.0;
    }

    NextU() {
        this.Next();
        let r = this.Seed * 4.656612875e-10 * 2147483645.0;
        //console.log(r);
        //return Math.floor(Math.fround(r)); // This breaks it spectacularly but is kind of funny
        return r >>> 0;
    }

    Random(a, b) {
        return a + Math.floor((b + 1 - a) * this.Next());
    }

    ProceduralRandomStupid(ws, x, y) {
        this.SetRandomSeed(ws, x, y);
        return this.Seed / 2147483647.0;
    }

    ProceduralRandom(ws, x, y) {
        this.SetRandomSeed(ws, x, y);
        return this.Next();
    }

    ProceduralRandomi(ws, x, y, a, b) {
        this.SetRandomSeed(ws, x, y);
        return this.Random(a, b);
    }

    getDistribution(mean, sharpness, baseline) {
        let i = 0;
        let pi = 3.1415; // Yeah I think this was the problem... Or not...
        while (i < 100) {
            let r1 = this.Next();
            let r2 = this.Next();
            let div = Math.abs(r1 - mean);
            if (r2 < (1.0 - div) * baseline) {
                return r1;
            }
            if (div < 0.5) {
                let v11 = Math.sin(((0.5 - mean) + r1) * pi);
                let v12 = Math.pow(v11, sharpness);
                if (v12 > r2) {
                    return r1;
                }
            }
            i++;
        }
        console.log("getDistribution failed to find a value after 100 iterations, returning last value. (", mean, sharpness, baseline, ")");
        return this.Next();
    }

    RandomDistribution(min, max, mean, sharpness) {
        if (sharpness == 0) return this.Random(min, max);
        let adjMean = (mean - min)/(max - min);
        let v7 = this.getDistribution(adjMean, sharpness, 0.005);
        let d = Math.round(v7 * (max - min));
        // Somehow this is working as intended if I don't round here???
        //console.log("RandomDistribution: ", adjMean, v7, res, " (", min, max, mean, sharpness, ")");
        return min + d;
    }

    RandomDistributionF(min, max, mean, sharpness) {
        if (sharpness == 0) return min + (max - min) * this.Next();
        let adjMean = (mean - min)/(max - min);
        let v7 = this.getDistribution(adjMean, sharpness, 0.005);
        return min + v7 * (max - min);
    }
}


// Test
/*
// There are very few of these, about 21k, and only 128 with the orb.
let sampo_seeds = [];
let orb_seeds = [];
for (let i = 2147462173; i <= 2147483647; i++) {
    let prng = new NollaPrng(i);
    prng.Seed = i;
    prng.Prev()
    let orig_seed = prng.Seed;
    //samporb_seeds.push(orig_seed);
    prng.Seed = i;
    if (prng.Random(0, 1000) === 999) {
        orb_seeds.push(orig_seed);
    }
    else {
        sampo_seeds.push(orig_seed);
    }
}
//console.log(samporb_seeds);
console.log(sampo_seeds)
console.log(orb_seeds);
*/

/*
// There are kind of too many of these, about 800k...
let healthium_seeds = [];
for (let i = 1; i <= 1095205; i++) {
    let prng = new NollaPrng(i);
    prng.Seed = i;
    if (Math.floor(101 * prng.Prev()) <= 75) {
        prng.Prev();
        healthium_seeds.push(prng.Seed);
        // Validate?
        if (Math.floor(101 * prng.Next()) <= 75 && Math.floor(100001 * prng.Next()) <= 50) {
            console.log("valid");
        }
        else {
            console.log("invalid");
        }
    }
}
console.log(healthium_seeds);
*/
