import { expect, it } from 'vitest';
import { advanceRandomState } from '../src/native-map/random-step.js';
import { NollaPrng as NativePrng } from '../src/native-map/rules/nolla_prng.js';
import { NollaPrng as GeometryPrng } from '../src/native-map/random.js';
import { NollaPrng as ReferencePrng } from '../lib/noita-telescope-vm/js/nolla_prng.js';

function referenceStep(seed: number): number {
  const integer = BigInt(Math.floor(seed));
  let next = 16807n * integer - 2147483647n * (integer / 127773n);
  if (next <= 0n) next += 2147483647n;
  return Number(next);
}

it('preserves exact integer state around every Schrage quotient boundary in the uint32 domain', () => {
  for (let q = -33616; q <= 33616; q++) for (const delta of [-1, 0, 1]) {
    const state = q * 127773 + delta;
    if (advanceRandomState(state) !== referenceStep(state)) throw Error(`Random boundary mismatch ${state}`);
  }
  for (const value of [-Number.MAX_SAFE_INTEGER, -4294967296, -4294967295, -0.5, -0, 0.5,
    2147483647, 2147483648, 4294967295, 4294967296, Number.MAX_SAFE_INTEGER]) {
    expect(advanceRandomState(value), String(value)).toBe(referenceStep(value));
  }
  for (const value of [NaN, Infinity, -Infinity]) expect(() => advanceRandomState(value)).toThrow(RangeError);
});

it('preserves long draw streams and reseeding at signed, fractional and threshold coordinates', () => {
  const coordinates = [-16777216, -102400.00000001, -102400, -102399.99999999, -4096, -1, -Number.MIN_VALUE,
    -0, 0, Number.MIN_VALUE, 0.5, 1, 4096, 102399.99999999, 102400, 102400.00000001, 16777216];
  for (const Type of [NativePrng, GeometryPrng]) {
    const actual = new Type(0), reference = new ReferencePrng(0);
    for (const seed of [0, 1, 2, 3, 1103, 786433191, 2147483647, 2147483648, 4294967294, 4294967295]) {
      for (const x of coordinates) for (const y of coordinates) {
        actual.SetRandomSeed(seed, x, y); reference.SetRandomSeed(seed, x, y);
        if (actual.Seed !== reference.Seed) throw Error(`Seed mismatch ${seed}/${x}/${y}`);
        for (let i = 0; i < 32; i++) if (actual.Next() !== reference.Next()) throw Error(`Draw mismatch ${seed}/${x}/${y}/${i}`);
      }
      for (let i = 0; i < 100000; i++) if (actual.Next() !== reference.Next()) throw Error(`Stream mismatch ${seed}/${i}`);
    }
  }
});
