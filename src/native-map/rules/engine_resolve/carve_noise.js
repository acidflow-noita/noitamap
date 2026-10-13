// Adapted into the owned Noitamap rules runtime. See NOTICE.txt for provenance.
// Carve-regime ("sin-capped") cave noise - exact float32 port of the
// density > 0.85 branch of CellNoise_EvaluateCaveAndMaterial @0x0087e110.
// Runtime noise_type (chunk+0x220) is 0 for every procedural surface biome
// (the XML value SIN_CAPPED_SIMPLEX maps to enum 0 = the switch's default
// branch); the other cases (1/2/3) are different warp variants no surface
// biome uses.
//
// Branch (all float32, wx/wy are the world-pixel doubles):
//   vn   = ValueNoiseSinHalf(f32(wx)*0.025, f32(wy)*0.025)   @0x00871850
//   a    = vn*0.05 + 0.05                                    amplitude 0.05..0.1
//   s    = Simplex40(a * (f32(wx)*0.5*0.02), a * (f32(wy)*0.5*0.02))  @0x00872d40
//   t    = (density - 0.85) / 0.1                            UNCLAMPED
//   d'   = density + (s*density - density) * t
// The caller then uses d' in place of density for the G*density term (the
// material-noise term keeps the PRE-carve density), plus mInsideAddValue
// (chunk+0x260, 0 for the surface biomes) which is only added in this regime.
//
// The swirl look: `a` re-rolls per ~40px value-noise cell, and the simplex
// coordinate is wx*0.01*a - so far from x=0 a small change in `a` swings the
// coordinate by whole simplex periods (busier swirls away from spawn).
import { PERM_CLASSIC } from './engine_data.js';
import { ComputeMagicValueFromDoubles } from './simplex_noise.js';

const F = Math.fround;

// Permutation table @0xfdf730 (classic Ken Perlin table, byte-verified against
// the binary; the second 256 bytes are a wrapped copy, so index up to 511).
const PERM = new Uint8Array(PERM_CLASSIC);
const PERM512 = new Uint8Array(512);
PERM512.set(PERM, 0);
PERM512.set(PERM, 256);

const F2 = F(0.3660253882408142); // @0x010535bc (sqrt3-1)/2
const G2 = F(0.21132487058639526); // @0x01053548 (3-sqrt3)/6
const G2x2 = F(0.4226497411727905); // @0x010535d4

// The binary's floor for the skew coords is trunc + DEC unless value > 0:
// it maps -2.0 -> -3 and 0.0 -> -1 (a bias real floor doesn't have). Keep it.
function skewFloor(v) {
	let i = Math.trunc(v);
	if (!(v > 0)) i -= 1;
	return i;
}

// ProceduralNoise_Simplex2D @0x00872d40: Gustavson 2D simplex, 8-gradient
// variant ((+-x or +-y) + (+-2 * the other)), corner cutoff t = 0.5 - x^2 - y^2,
// contribution (u+v)*t^4, sum * 40. Output roughly [-1, 1].
export function carveSimplex2D(x, y) {
	const s = F(F(x + y) * F2);
	const i = skewFloor(F(x + s));
	const j = skewFloor(F(s + y));
	const t = F(F(i + j) * G2);
	const x0 = F(x - F(F(i) - t));
	const y0 = F(y - F(F(j) - t));
	let i1, j1;
	if (x0 > y0) { i1 = 1; j1 = 0; } else { i1 = 0; j1 = 1; }
	const x1 = F(F(x0 - i1) + G2);
	const y1 = F(F(y0 - j1) + G2);
	const x2 = F(F(x0 - 1) + G2x2);
	const y2 = F(F(y0 - 1) + G2x2);
	const ii = i & 0xff, jj = j & 0xff;
	const corner = (cx, cy, g) => {
		const tt = F(F(F(0.5) - F(cx * cx)) - F(cy * cy));
		if (tt < 0) return 0;
		const t2 = F(tt * tt);
		let u = (g & 7) < 4 ? cx : cy;
		let v = (g & 7) < 4 ? cy : cx;
		if (g & 1) u = -u;
		v = F(v * ((g & 2) ? -2 : 2));
		return F(F(u + v) * F(t2 * t2));
	};
	const n0 = corner(x0, y0, PERM512[PERM512[jj] + ii] & 7);
	const n1 = corner(x1, y1, PERM512[PERM512[jj + j1] + ii + i1] & 7);
	const n2 = corner(x2, y2, PERM512[PERM512[jj + 1] + ii + 1] & 7);
	return F(F(F(n1 + n0) + n2) * 40);
}

// ProceduralNoise_nearby_871850 @0x00871850: sin-hash value noise
// (frac(sin(n + k) * 43758.5453), n = floor(x) + floor(y)*57, corners
// k = 0/1/57/58) with a parity twist: the interpolation weight along each
// axis morphs between smoothstep (even lattice cell) and linear (odd cell).
// Output [0, 1).
const SIN_MAG = F(43758.546875); // @0x01053fb0
function fade(f) {
	return F(F(F(3) - F(f * 2)) * F(f * f));
}
function hash(v) {
	const m = F(F(Math.sin(v)) * SIN_MAG);
	return F(m - Math.floor(m));
}
export function carveValueNoise2D(x, y) {
	const ix = Math.floor(x), iy = Math.floor(y);
	const fx = F(x - F(ix)), fy = F(y - F(iy));
	const u0 = (ix & 1) === 0 ? fade(fx) : fx;
	const u1 = ((ix + 1) & 1) === 0 ? fade(fx) : fx;
	const u = F(F(F(u1 - u0) * fx) + u0);
	const v0 = (iy & 1) === 0 ? fade(fy) : fy;
	const v1 = ((iy + 1) & 1) === 0 ? fade(fy) : fy;
	const v = F(F(F(v1 - v0) * fy) + v0);
	const n = F(F(F(iy) * 57) + F(ix));
	const hTop = F(F(F(hash(F(n + 58)) - hash(F(n + 57))) * u) + hash(F(n + 57)));
	const hBot = F(F(F(hash(F(n + 1)) - hash(F(n + 0))) * u) + hash(F(n + 0)));
	return F(F(F(hTop - hBot) * v) + hBot);
}

// ProceduralNoise_ValueNoiseSmooth2D @0x00871630 -- the same sin-hash value
// noise as carveValueNoise2D but WITHOUT the parity twist: both axes always use
// the smoothstep weight. Only the noise_type 3 carve calls it.
export function carveValueNoiseSmooth2D(x, y) {
	const ix = Math.floor(x), iy = Math.floor(y);
	const fx = F(x - F(ix)), fy = F(y - F(iy));
	const u = fade(fx), v = fade(fy);
	const n = F(F(F(iy) * 57) + F(ix));
	const hTop = F(F(F(hash(F(n + 58)) - hash(F(n + 57))) * u) + hash(F(n + 57)));
	const hBot = F(F(F(hash(F(n + 1)) - hash(F(n + 0))) * u) + hash(F(n + 0)));
	return F(F(F(hTop - hBot) * v) + hBot);
}

const AMP_LO = F(0.05000000074505806); // @0x010534cc
const VN_FREQ = F(0.02500000037252903); // @0x01053490
const CO_FREQ = F(0.019999999552965164); // @0x01053484
const CARVE_GATE = F(0.8500000238418579); // @0x01053714
const BLEND_DIV = F(0.10000000149011612); // @0x010534fc
// noise_type 3 constants: @0x01053800 / @0x01053808 (value-noise frequencies),
// @0x010536e0 (1/1024), and the 1024 * 0.5 * 0.06 amplitude chain
// (@0x01053bf8, @0x01053968, @0x01053868).
const VN3_FREQ_X = 0.02, VN3_FREQ_Y = 0.021;
const CAP_FREQ = 0.0009765625;
const CAP_AMP_A = 1024.0, CAP_AMP_B = 0.5, CAP_AMP_C = 0.05999999865889549;

// The shared blend tail @0x0087e6f0: d' = d + (s*d - d) * (d - 0.85)/0.1.
// `s` arrives as a float for noise_type 0 and as a double for noise_type 3
// (the engine multiplies by the density in double there and only then rounds).
function carveBlend(s, density) {
	const cave = F(s * density);
	const t = F(F(density - CARVE_GATE) / BLEND_DIV);
	return F(F(F(cave - density) * t) + density);
}

// density > CARVE_GATE only; returns the carved density d' that replaces
// density in the G*density term of the final material value.
export function carveDensity(wx, wy, density) {
	const fx = F(wx), fy = F(wy);
	const vn = carveValueNoise2D(F(fx * VN_FREQ), F(fy * VN_FREQ));
	const a = F(F(vn * AMP_LO) + AMP_LO);
	const sx = F(a * F(F(fx * F(0.5)) * CO_FREQ));
	const sy = F(F(F(fy * F(0.5)) * CO_FREQ) * a);
	return carveBlend(carveSimplex2D(sx, sy), density);
}

// noise_type 3 (SIN_CAPPED_SIMPLEX) carve branch @0x0087e48b -- the variant the
// XML's `noise_type="SIN_CAPPED_SIMPLEX"` selects (Biome+0x220 == 3, live-PEEKed).
// Instead of feeding the simplex a world-scaled coordinate it feeds it
// cos(x/1024) / sin(y/1024) scaled by the same 0.05..0.1 value-noise amplitude,
// so the noise coordinate is CAPPED to +-30.72*a -- hence the name. The simplex
// here is the double-precision EdgeNoise_Simplex2D @0x00872300, not the float
// ProceduralNoise_Simplex2D the type-0 branch uses.
// Live-validated against CELLPROBE (seed 786433191, excavationsite_cube_chamber:
// 5/5 exact on the engine's own `n`).
export function carveDensityType3(wx, wy, density) {
	const vn = carveValueNoiseSmooth2D(F(wx * VN3_FREQ_X), F(wy * VN3_FREQ_Y));
	const a = F(F(vn * AMP_LO) + AMP_LO);
	const sy = Math.sin(wy * CAP_FREQ) * CAP_AMP_A * CAP_AMP_B * CAP_AMP_C * a;
	const sx = Math.cos(wx * CAP_FREQ) * CAP_AMP_A * CAP_AMP_B * CAP_AMP_C * a;
	return carveBlend(ComputeMagicValueFromDoubles(sx, sy), density);
}
