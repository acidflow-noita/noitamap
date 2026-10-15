/** Exact Schrage update for the normal signed/unsigned 32-bit seed domain.
 * Both products have magnitude <2^47, hence binary64 stores each integer and
 * their difference exactly. The quotient's fractional distance from an integer
 * is >=1/127773, far larger than binary64 error at this bound. Math.trunc matches
 * BigInt division for negative inputs. Preserve the old arbitrary-state path.
 */
export function advanceRandomState(seed) {
  const s = Math.floor(seed);
  if (s >= -0xffffffff && s <= 0xffffffff) {
    let next = 16807 * s - 2147483647 * Math.trunc(s / 127773);
    if (next <= 0) next += 2147483647;
    return next;
  }
  const integer = BigInt(s);
  let next = 16807n * integer - 2147483647n * (integer / 127773n);
  if (next <= 0n) next += 2147483647n;
  return Number(next);
}
