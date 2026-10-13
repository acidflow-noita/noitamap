// Adapted into the owned Noitamap rules runtime. See NOTICE.txt for provenance.
// Exact float32 ports of:
//   ProceduralNoise_Perlin2D                @0x00872a20
//   ProceduralNoise_ValueNoisePerlinPerm2D  @0x00872be0
// Both use the CUSTOM 256-byte permutation table @0x00fdffe0 (doubled to 512),
// and the 8-entry gradient table @0x011d2960 = (-1,0)(1,0)(0,-1)(0,1)
// (-1,-1)(-1,1)(1,-1)(1,1).  Derived from disassembly; every arithmetic step is
// wrapped in Math.fround to reproduce the SSE scalar-single ops exactly.
import { PERM_CUSTOM } from './engine_data.js';

const F = Math.fround;

// @0x00fdffe0 (256 bytes; the binary stores a byte-identical second copy at
// +256 so perm[perm[X]+Y] can index up to 510).
const PERM = new Uint8Array(PERM_CUSTOM);
const PERM512 = new Uint8Array(512);
PERM512.set(PERM, 0);
PERM512.set(PERM, 256);

// g_perlin_grad8 @0x011d2960
const GX = new Float32Array([-1, 1, 0, 0, -1, -1, 1, 1]);
const GY = new Float32Array([0, 0, -1, 1, -1, 1, -1, 1]);

// Constants (bit patterns verified against .rdata)
const C6 = F(6);      // 0x01053c58 = 0x40c00000
const C15 = F(15);    // 0x01053d10 = 0x41700000
const C10 = F(10);    // 0x01053ccc = 0x41200000
const C255 = F(255);  // 0x01053ec4 = 0x437f0000
const C0_5 = F(0.5);  // 0x0105361c = 0x3f000000
const C2 = F(2);      // 0x010539f8 = 0x40000000

// fade(t) = ((t*6 - 15)*t + 10)*t*t*t, in the binary's exact MULSS/SUBSS order.
function fade5(t) {
	let a = F(t * C6);
	a = F(a - C15);
	a = F(a * t);
	a = F(a + C10);
	a = F(a * t);
	a = F(a * t);
	a = F(a * t);
	return a;
}

// The binary's lattice floor here is CVTTSS2SI + "DEC unless (float)i <= v",
// i.e. a TRUE floor (unlike the simplex skew floor).
function lfloor(v) {
	return Math.floor(v);
}

// ProceduralNoise_Perlin2D @0x00872a20 (XMM0 = x, XMM1 = y, both float32)
export function perlin2D(x, y) {
	x = F(x); y = F(y);
	const ix = lfloor(x), iy = lfloor(y);
	const fx = F(x - ix);
	const fy = F(y - iy);
	const X = ix & 0xff, Xp = (ix + 1) & 0xff;
	const Y = iy & 0xff, Yp = (iy + 1) & 0xff;
	const pX = PERM512[X], pX1 = PERM512[Xp];
	const g00 = PERM512[pX + Y] & 7;
	const g01 = PERM512[pX + Yp] & 7;
	const g10 = PERM512[pX1 + Y] & 7;
	const g11 = PERM512[pX1 + Yp] & 7;
	const fx1 = F(fx - F(1));
	const fy1 = F(fy - F(1));
	// n = grad.y*dy + dx*grad.x   (that operand order is what the asm uses)
	const n00 = F(F(GY[g00] * fy) + F(fx * GX[g00]));
	const n10 = F(F(GY[g10] * fy) + F(fx1 * GX[g10]));
	const n01 = F(F(GY[g01] * fy1) + F(GX[g01] * fx));
	const n11 = F(F(GY[g11] * fy1) + F(GX[g11] * fx1));
	const fdY = fade5(fy);
	const A = F(F(F(n01 - n00) * fdY) + n00);
	const B = F(F(F(n11 - n10) * fdY) + n10);
	const fdX = fade5(fx);
	return F(F(F(B - A) * fdX) + A);
}

// ProceduralNoise_ValueNoisePerlinPerm2D @0x00872be0 (XMM0 = x, XMM1 = y)
export function valueNoisePerlinPerm2D(x, y) {
	x = F(x); y = F(y);
	const ix = lfloor(x), iy = lfloor(y);
	const fx = F(x - ix);
	const fy = F(y - iy);
	const X = ix & 0xff, Xp = (ix + 1) & 0xff;
	const Y = iy & 0xff, Yp = (iy + 1) & 0xff;
	const pX = PERM512[X], pX1 = PERM512[Xp];
	const v00 = F(PERM512[pX + Y] / C255);
	const v01 = F(PERM512[pX + Yp] / C255);
	const v10 = F(PERM512[pX1 + Y] / C255);
	const v11 = F(PERM512[pX1 + Yp] / C255);
	const fdY = fade5(fy);
	const A = F(F(F(v01 - v00) * fdY) + v00);
	const B = F(F(F(v11 - v10) * fdY) + v10);
	const fdX = fade5(fx);
	const r = F(F(F(B - A) * fdX) + A);
	return F(F(r - C0_5) * C2);
}
