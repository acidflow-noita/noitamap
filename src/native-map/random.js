// Derived from noita-telescope by Lymm (MIT); see LICENSE.
// Source: Lymm 7fce46be8a5587fa88693d468046e236f862f5c7; algorithms unchanged
// except explicit input/state ownership and removal of discarded raster output.

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

  static Helper2(a, b, ws) {
    a >>>= 0;
    b >>>= 0;
    ws >>>= 0;
    let u2 = (a - b - ws) ^ (ws >>> 13);
    u2 >>>= 0;
    let u1 = (b - u2 - ws) ^ (u2 << 8);
    u1 >>>= 0;
    let u3 = (ws - u2 - u1) ^ (u1 >>> 13);
    u3 >>>= 0;
    u2 = (u2 - u1 - u3) ^ (u3 >>> 12);
    u2 >>>= 0;
    u1 = (u1 - u2 - u3) ^ (u2 << 16);
    u1 >>>= 0;
    u3 = (u3 - u2 - u1) ^ (u1 >>> 5);
    u3 >>>= 0;
    u2 = (u2 - u1 - u3) ^ (u3 >>> 3);
    u2 >>>= 0;
    u1 = (u1 - u2 - u3) ^ (u2 << 10);
    u1 >>>= 0;
    return ((u3 - u2 - u1) ^ (u1 >>> 15)) >>> 0;
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

  Next() {
    let s = BigInt(Math.floor(this.Seed));
    let v4 = 16807n * s - 2147483647n * (s / 127773n);
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
}
