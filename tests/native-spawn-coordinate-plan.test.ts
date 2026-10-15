import { it } from 'vitest';
import { preparedSpawnCoordinates, spawnScanPointAxis } from '../src/native-map/rules/spawn-coordinate-plan.js';

// Unchanged coordinate arithmetic from the previously shipped poi_scanner.
function axisGate(world: number, off: number): boolean {
  const tileIndex = Math.round((world + 5 + off) / 10), out: number[] = [];
  const lo = tileIndex * 10 - off - 1, hi = tileIndex * 10 - off + 11;
  for (let s = Math.ceil(lo); s <= hi; s++) {
    if (Math.floor((s + off + 0.5) / 10) !== tileIndex) continue;
    const cb = Math.floor(s / 512) * 512;
    if ((((s - cb) % 10) + 10) % 10 !== 0) continue;
    if (!out.includes(cb)) out.push(cb);
  }
  return out.some(base => base <= world && world < base + 511);
}
function scanAxis(world: number): number {
  const phase = ((((Math.floor(world / 512) * 512) % 10) + 10) % 10);
  const base = (((phase - world) % 10) + 10) % 10;
  return world + (base >= 5 ? base : base + 10);
}

it('prepares exact seam gates across complete main/vertical/PW ranges and distant fallback coordinates', () => {
  for (const [ngp, mode, center] of [[false, 'normal', 35], [true, 'normal', 32], [false, 'nightmare', 32]] as const) {
    const plan = preparedSpawnCoordinates(ngp, mode);
    for (let x = -200000; x <= 200000; x++) {
      const y = -x + (x % 17);
      const expected = axisGate(x, center * 512) && axisGate(y, 14 * 512);
      if (plan.accepts(x, y) !== expected) throw Error(`Coordinate gate mismatch ${mode}/${ngp}/${x}/${y}`);
      if (spawnScanPointAxis(x) !== scanAxis(x)) throw Error(`Scan point mismatch ${x}`);
    }
    for (const x of [-2147483648, -1073741824, -1073741823, -16777216, -512.125, -0.125,
      0.125, 512.125, 16777216, 1073741823, 1073741824, 2147483648]) for (const y of [-31744, -512.5, 0, 33791]) {
      if (plan.accepts(x, y) !== (axisGate(x, center * 512) && axisGate(y, 14 * 512)))
        throw Error(`Coordinate fallback mismatch ${x}/${y}`);
      if (spawnScanPointAxis(x) !== scanAxis(x)) throw Error(`Scan point fallback mismatch ${x}`);
    }
  }
});
