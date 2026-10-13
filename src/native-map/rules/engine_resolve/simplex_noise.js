// Adapted into the owned Noitamap rules runtime. See NOTICE.txt for provenance.
// Pure 2D simplex noise ("edge noise") used by the engine for biome edge wobble,
// biome surface lines and inside/material noise (EdgeNoise_Simplex2D @0x00872300).
// Byte-identical to scripts/ref_resolver/simplex_noise.js, kept here so the app
// can import it without reaching into scripts/. It is NOT interchangeable with
// js/edge_noise.js's copy: that one still converts with `>>> 0`, which wraps a
// negative input mod 2^32 and freezes the noise to exactly 0 over the whole west
// half of the world. Correcting it there would move the biome-edge wobble the
// rest of the map is tuned against, so the fixed version lives separately and
// only the engine-faithful callers (band_select.js) use it.
// No imports allowed in this module.

const EDGE_NOISE = [0x97, 0xa0, 0x89, 0x5b, 0x5a, 0x0f, 0x83, 0x0d, 0xc9, 0x5f, 0x60, 0x35, 0xc2, 0xe9, 0x07, 0xe1, 0x8c, 0x24, 0x67, 0x1e, 0x45, 0x8e, 0x08, 0x63, 0x25, 0xf0, 0x15, 0x0a, 0x17, 0xbe, 0x06, 0x94, 0xf7, 0x78, 0xea, 0x4b, 0x00, 0x1a, 0xc5, 0x3e, 0x5e, 0xfc, 0xdb, 0xcb, 0x75, 0x23, 0x0b, 0x20, 0x39, 0xb1, 0x21, 0x58, 0xed, 0x95, 0x38, 0x57, 0xae, 0x14, 0x7d, 0x88, 0xab, 0xa8, 0x44, 0xaf, 0x4a, 0xa5, 0x47, 0x86, 0x8b, 0x30, 0x1b, 0xa6, 0x4d, 0x92, 0x9e, 0xe7, 0x53, 0x6f, 0xe5, 0x7a, 0x3c, 0xd3, 0x85, 0xe6, 0xdc, 0x69, 0x5c, 0x29, 0x37, 0x2e, 0xf5, 0x28, 0xf4, 0x66, 0x8f, 0x36, 0x41, 0x19, 0x3f, 0xa1, 0x01, 0xd8, 0x50, 0x49, 0xd1, 0x4c, 0x84, 0xbb, 0xd0, 0x59, 0x12, 0xa9, 0xc8, 0xc4, 0x87, 0x82, 0x74, 0xbc, 0x9f, 0x56, 0xa4, 0x64, 0x6d, 0xc6, 0xad, 0xba, 0x03, 0x40, 0x34, 0xd9, 0xe2, 0xfa, 0x7c, 0x7b, 0x05, 0xca, 0x26, 0x93, 0x76, 0x7e, 0xff, 0x52, 0x55, 0xd4, 0xcf, 0xce, 0x3b, 0xe3, 0x2f, 0x10, 0x3a, 0x11, 0xb6, 0xbd, 0x1c, 0x2a, 0xdf, 0xb7, 0xaa, 0xd5, 0x77, 0xf8, 0x98, 0x02, 0x2c, 0x9a, 0xa3, 0x46, 0xdd, 0x99, 0x65, 0x9b, 0xa7, 0x2b, 0xac, 0x09, 0x81, 0x16, 0x27, 0xfd, 0x13, 0x62, 0x6c, 0x6e, 0x4f, 0x71, 0xe0, 0xe8, 0xb2, 0xb9, 0x70, 0x68, 0xda, 0xf6, 0x61, 0xe4, 0xfb, 0x22, 0xf2, 0xc1, 0xee, 0xd2, 0x90, 0x0c, 0xbf, 0xb3, 0xa2, 0xf1, 0x51, 0x33, 0x91, 0xeb, 0xf9, 0x0e, 0xef, 0x6b, 0x31, 0xc0, 0xd6, 0x1f, 0xb5, 0xc7, 0x6a, 0x9d, 0xb8, 0x54, 0xcc, 0xb0, 0x73, 0x79, 0x32, 0x2d, 0x7f, 0x04, 0x96, 0xfe, 0x8a, 0xec, 0xcd, 0x5d, 0xde, 0x72, 0x43, 0x1d, 0x18, 0x48, 0xf3, 0x8d, 0x80, 0xc3, 0x4e, 0x42, 0xd7, 0x3d, 0x9c, 0xb4];
const EDGE_SIGNS = [1, 1, 0, 0, -1, 1, 0, 0, 1, -1, 0, 0, -1, -1, 0, 0, 1, 0, 1, 0, -1, 0, 1, 0, 1, 0, -1, 0, -1, 0, -1, 0, 0, 1, 1, 0, 0, -1, 1, 0, 0, 1, -1, 0, 0, -1, -1, 0];

const sqrt312 = (Math.sqrt(3) - 1) / 2;
const sqrt336 = (3 - Math.sqrt(3)) / 6;
const EDGE_NOISE_2 = [];
const EDGE_NOISE_M12 = [];

for (let i = 0; i < 512; i++) {
	const temp = EDGE_NOISE[i & 0xff];
	EDGE_NOISE_2.push(temp);
	EDGE_NOISE_M12.push(temp % 0xc);
}

// Originally had unused z..?
export function ComputeMagicValueFromDoubles(x, y) {
	let uVar1;
	let uVar2;
	let dVar3;
	let dVar4;
	let dVar5;
	let dVar6;
	let dVar7;
	let dVar8;
	let dVar9;
	let dVar10;
	let dVar11;

	dVar7 = (x + y) * sqrt312;
	dVar6 = dVar7 + x;
	// The binary converts with CVTTSD2SI (SIGNED truncation) then applies the
	// floor fixup. The old `>>> 0` (ToUint32) wraps negatives mod 2^32, which
	// blew up the corner distances and froze the noise to exactly 0 for any
	// negative input - i.e. the whole west half of the world for the material
	// noise (raw world coords; the surface-line noise only survived because
	// the per-seed phase keeps its inputs positive in the main world).
	uVar2 = Math.trunc(dVar6);
	if (dVar6 < uVar2) {
		uVar2 = uVar2 - 1;
	}

	dVar7 = dVar7 + y;
	uVar1 = Math.trunc(dVar7);
	if (dVar7 < uVar1) {
		uVar1 = uVar1 - 1;
	}

	dVar6 = (uVar1 + uVar2) * sqrt336;
	dVar10 = x - (uVar2 - dVar6);
	dVar9 = y - (uVar1 - dVar6);
	uVar1 = uVar1 & 0xff;
	uVar2 = uVar2 & 0xff; // This will bring it back in range
	dVar8 = 0.0;
	dVar7 = (dVar10 - (dVar9 < dVar10 ? 1 : 0)) + sqrt336;
	dVar3 = (dVar9 - (dVar10 <= dVar9 ? 1 : 0)) + sqrt336;
	dVar11 = (dVar10 - 1.0) + sqrt336 * 2.0;
	dVar4 = (dVar9 - 1.0) + sqrt336 * 2.0;
	dVar5 = (0.5 - dVar10 * dVar10) - dVar9 * dVar9;
	dVar6 = dVar8;
	if (0.0 <= dVar5) {
		dVar6 = (EDGE_SIGNS[EDGE_NOISE_M12[EDGE_NOISE_2[uVar1] + uVar2] * 4 + 1] * dVar9 +
			EDGE_SIGNS[EDGE_NOISE_M12[EDGE_NOISE_2[uVar1] + uVar2] * 4] * dVar10) * dVar5 * dVar5 * dVar5 * dVar5;
	}
	dVar5 = (0.5 - dVar7 * dVar7) - dVar3 * dVar3;
	if (0.0 <= dVar5) {
		dVar7 = (EDGE_SIGNS[EDGE_NOISE_M12[EDGE_NOISE_2[(dVar10 <= dVar9 ? 1 : 0) + uVar1] + uVar2 + (dVar9 < dVar10 ? 1 : 0)] * 4 + 1] * dVar3 +
		    EDGE_SIGNS[EDGE_NOISE_M12[EDGE_NOISE_2[(dVar10 <= dVar9 ? 1 : 0) + uVar1] + uVar2 + (dVar9 < dVar10 ? 1 : 0)] * 4] * dVar7) * dVar5 * dVar5 * dVar5 * dVar5;
	} else {
		dVar7 = 0.0;
	}
	dVar3 = (0.5 - dVar11 * dVar11) - dVar4 * dVar4;
	if (0.0 <= dVar3) {
		dVar8 = (EDGE_SIGNS[EDGE_NOISE_M12[EDGE_NOISE_2[uVar1 + 1] + uVar2 + 1] * 4 + 1] * dVar4 +
		    EDGE_SIGNS[EDGE_NOISE_M12[EDGE_NOISE_2[uVar1 + 1] + uVar2 + 1] * 4] * dVar11) * dVar3 * dVar3 * dVar3 * dVar3;
	}
	return (dVar7 + dVar6 + dVar8) * 70.0; // Should this be world size or just straight 70? Didn't seem to give correct results when I tried using world size. Seems 70 is correct.
}

// ---------------------------------------------------------------------------
// ProceduralNoise_Simplex2D @0x00872d40 -- ProceduralNoise_Dispatch variant 8,
// the one `mInsideNoiseType="SimplexNoise1234"` selects (NoiseImpl_FromString
// @0x004867c6 maps that string to 8). Stefan Gustavson's simplexnoise1234.c
// snoise2 verbatim, in FLOAT32 throughout, over the SAME 256-byte permutation
// table as EdgeNoise_Simplex2D above (the engine's copy at 0x00fdf730 is
// byte-identical to EDGE_NOISE, mirrored to 512).
//
// What differs from ComputeMagicValueFromDoubles (variant 5) is the gradient and
// the output scale: this one takes the hash's low 3 bits into the classic 8-way
// grad2 (u +/- 2v) and scales the sum by 40, where the edge variant runs the
// 12-entry grad3 table in 2D and scales by 70.
//
// Both floors are Gustavson's FASTFLOOR, which the binary implements as
// `CVTTSS2SI; if (!(v > 0)) --i` -- so an exactly-zero coordinate floors to -1.
// That quirk is load-bearing at the world origin, so it is reproduced here.
const F32 = Math.fround;
const SN_F2 = F32(0.3660253882408142);   // 0x010535bc
const SN_G2 = F32(0.21132487058639526);  // 0x01053548
const SN_G2_2 = F32(0.42264974117279053); // 0x010535d4 (2*G2, as its own constant)
const SN_SCALE = 40.0;                   // 0x01053df0

function fastFloor(v) {
	const i = Math.trunc(v);
	return v > 0 ? i : i - 1;
}

/** grad2(hash, x, y) from the binary: u = h<4 ? x : y, v = the other,
 *  u negated on bit 0, v scaled by -2 on bit 1 and +2 otherwise. */
function snGrad2(hash, x, y) {
	const h = hash & 7;
	let u = h < 4 ? x : y;
	const w = h < 4 ? y : x;
	if (h & 1) u = F32(-u);
	return F32(u + F32(w * (h & 2 ? -2.0 : 2.0)));
}

/** ProceduralNoise_Simplex2D(x, y) -> float in roughly [-1, 1]. */
export function SimplexNoise1234(x, y) {
	const fx = F32(x), fy = F32(y);
	const s = F32(F32(fx + fy) * SN_F2);
	const i = fastFloor(F32(s + fx));
	const j = fastFloor(F32(s + fy));
	const t = F32(F32(i + j) * SN_G2);
	const x0 = F32(fx - F32(i - t));
	const y0 = F32(fy - F32(j - t));
	const i1 = x0 > y0 ? 1 : 0;
	const j1 = x0 > y0 ? 0 : 1;
	const x1 = F32(F32(x0 - i1) + SN_G2);
	const y1 = F32(F32(y0 - j1) + SN_G2);
	const x2 = F32(F32(x0 - 1.0) + SN_G2_2);
	const y2 = F32(F32(y0 - 1.0) + SN_G2_2);
	const ii = i & 0xff, jj = j & 0xff;

	let n0 = 0, n1 = 0, n2 = 0;
	let t0 = F32(F32(0.5 - F32(x0 * x0)) - F32(y0 * y0));
	if (t0 >= 0) {
		t0 = F32(t0 * t0);
		n0 = F32(F32(t0 * t0) * snGrad2(EDGE_NOISE_2[EDGE_NOISE_2[jj] + ii], x0, y0));
	}
	let t1 = F32(F32(0.5 - F32(x1 * x1)) - F32(y1 * y1));
	if (t1 >= 0) {
		t1 = F32(t1 * t1);
		n1 = F32(F32(t1 * t1) *
			snGrad2(EDGE_NOISE_2[EDGE_NOISE_2[jj + j1] + ii + i1], x1, y1));
	}
	let t2 = F32(F32(0.5 - F32(x2 * x2)) - F32(y2 * y2));
	if (t2 >= 0) {
		t2 = F32(t2 * t2);
		n2 = F32(F32(t2 * t2) *
			snGrad2(EDGE_NOISE_2[EDGE_NOISE_2[jj + 1] + ii + 1], x2, y2));
	}
	return F32(F32(F32(n1 + n0) + n2) * SN_SCALE);
}
