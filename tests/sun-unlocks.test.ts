import { describe, expect, it } from 'vitest';
import { getSunUnlocks } from '../src/sun-unlocks';

describe('Sun replacement flags', () => {
  it.each([
    ['0', []], ['1', ['sun']], ['2', ['dark_sun']], ['3', ['sun', 'dark_sun']],
  ] as const)('matches the mod mask %s', (mask, expected) => {
    expect(getSunUnlocks('mod', mask)).toEqual(expected);
    expect(getSunUnlocks('none', mask)).toEqual([]);
    expect(getSunUnlocks('all', mask)).toEqual(['sun', 'dark_sun']);
  });
  it.each([null, '', '4', '-1', '03', '1.0', '1junk', 'progress_sun', 'progress_darksun', 'all'])
  ('keeps the Moons for missing/invalid mod data: %s', value => {
    expect(getSunUnlocks('mod', value)).toEqual([]);
  });
});
