/** The pinned lattice builder's snapshot-based four-neighbour vote. Compare
 * the four values directly: no per-cell arrays, Maps or wrap callbacks.
 * A tie belongs to whichever value reached the winning count first in
 * left/right/up/down order, not necessarily the leftmost value. */
export function applyTerrainLatticeMajority(cov: Float32Array, mat: Uint16Array, w: number, h: number): void {
  const out = mat.slice();
  for (let y = 0; y < h; y++) {
    const row = y * w, above = (y === 0 ? h - 1 : y - 1) * w, below = (y === h - 1 ? 0 : y + 1) * w;
    for (let x = 0; x < w; x++) {
      const i = row + x;
      if (mat[i] !== 0 || cov[i] !== 0) continue;
      const a = mat[row + (x === 0 ? w - 1 : x - 1)];
      const b = mat[row + (x === w - 1 ? 0 : x + 1)];
      const c = mat[above + x], d = mat[below + x];
      let best = a, count = a ? 1 : 0;
      if (b) {
        const n = 1 + +(a === b);
        if (n > count) { best = b; count = n; }
      }
      if (c) {
        const n = 1 + +(a === c) + +(b === c);
        if (n > count) { best = c; count = n; }
      }
      if (d) {
        const n = 1 + +(a === d) + +(b === d) + +(c === d);
        if (n > count) best = d;
      }
      if (best) out[i] = best;
    }
  }
  mat.set(out);
}
