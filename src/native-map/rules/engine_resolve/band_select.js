// Adapted into the owned Noitamap rules runtime. See NOTICE.txt for provenance.
// BiomeMaterials_SelectComponentForCell @0x0086d2a0 — the engine's per-pixel
// <MaterialComponent> band chooser, on the CPU.
//
// The GL terrain shader already runs this (gl/shaders.js engBandSelect) for the
// terrain it resolves. Pixel scenes are stamped by the 2D draw path instead, and
// their gray/white (fully solid) pixels go through the very same chooser in game,
// so this module answers it for them: "what material does this biome paint at
// density d, at this exact world pixel".
//
// `d` is never the raw coverage: the engine runs coverage through
// ComputeMaterialNoiseDensity first (topo2_resolve.js, re-exported below), and
// so must every caller here.
//
// It reads the committed BIOME_ENGINE tables (engine_resolve/engine_data.js),
// i.e. the same band data the shader is fed, so the two renderers cannot
// disagree. The float32 op order follows scripts/ref_resolver/band_select.js,
// which is the validated reference port of the binary.
//
// Ported alongside it:
//   BiomeMaterials_RarePolkaTest @0x00872140
//   PolkaCellHash_Scalar        @0x0086fd40
//   PolkaCellHash_3Vec          @0x0086fe30
import { BIOME_ENGINE, MATERIAL_NAMES_BY_ID } from './engine_data.js';
import { ComputeMagicValueFromDoubles } from './simplex_noise.js';

// Re-exported so a caller cannot pick up the chooser without the density term
// that belongs in front of it.
export { computeMaterialNoiseDensity } from './topo2_resolve.js';

const F = Math.fround;

// ---- exact .rdata / immediate constants, from their float32 bit patterns ----
const _dv = new DataView(new ArrayBuffer(4));
function flt(u) { _dv.setUint32(0, u); return _dv.getFloat32(0); }

const INV71 = flt(0x3c66c2b4);     // _DAT_01053470  ~1/71
const C71 = flt(0x428e0000);       // _DAT_01053e38  71.0
const C26 = flt(0x41d00000);       // DAT_01053d70   26.0
const C161 = flt(0x43210000);      // DAT_01053e8c   161.0
const K_SCALAR = flt(0x3a84cd4e);  // _DAT_0105342c
const K_V0 = flt(0x3a89ce48);      // DAT_01053430
const K_V1 = flt(0x3acbdc41);      // immediate @0x0086fe8f
const K_V2 = flt(0x3aa32fcf);      // immediate @0x0086fe99

// CVTTSS2SI + "if (v < (float)i) i--" -- floorf via truncation, as the binary does.
function ffloor(v) {
	let i = Math.trunc(v);
	if (v < i) i -= 1;
	return i;
}
function ffrac(v) {
	return F(v - ffloor(v));
}

// PolkaCellHash_* share this per-lattice-cell base term. Op order per the
// disassembly: the two squares are formed FIRST and then multiplied --
// (a*a)*(b*b), NOT the decompiler's left-assoc `b*b*a*a`. base reaches ~5e8,
// where a float32 ulp is 32, so the association order visibly moves the result.
function polkaBase(cx, cy) {
	const ix = ffloor(F(cx * INV71));
	const iy = ffloor(F(cy * INV71));
	const a = F(F(cx - F(ix * C71)) + C26);    // px + 26
	const b = F(F(cy - F(iy * C71)) + C161);   // py + 161
	return F(F(b * b) * F(a * a));
}

/** BiomeMaterials_RarePolkaTest — the cubic blob falloff in [0,1]. */
function rarePolkaTest(x, y, radiusLow, radiusHigh, isBoxed, probability) {
	const cy = ffloor(y);
	const cx = ffloor(x);
	const base = polkaBase(cx, cy);
	if (probability <= ffrac(F(base * K_SCALAR))) return 0;
	const fx = F(x - cx);
	const fy = F(y - cy);
	const h0 = ffrac(F(base * K_V0));
	const h1 = ffrac(F(base * K_V1));
	const h2 = ffrac(F(base * K_V2));
	const radius = F(F(F(radiusHigh - radiusLow) * h2) + radiusLow);
	if (!(radius > 0)) return 0;
	const s = F(2.0 / radius);
	const sm1 = F(s - 1.0);
	const sm2 = F(s - 2.0);
	let dy = F(F(sm2 * h1) + F(F(fy * s) - sm1));
	let dx = F(F(sm2 * h0) + F(F(fx * s) - sm1));
	dy = F(dy * dy);
	dx = F(dx * dx);
	let d;
	if (isBoxed) {
		d = F(F(dy * dy) + F(dx * dx));
		if (d > 1.0) return 0;
	} else {
		d = F(dy + dx);
		if (d >= 1.0) d = 1.0;
	}
	const u = F(1.0 - d);
	return F(F(u * u) * u);
}

/** The BIOME_ENGINE entry for a biome-map color, or null. */
const ENGINE_BY_COLOR = new Map(BIOME_ENGINE.map(b => [b.color & 0xffffff, b]));
export function engineBiomeForColor(color) {
	return ENGINE_BY_COLOR.get(color & 0xffffff) ?? null;
}

/**
 * The material id this biome paints at (worldX, worldY) for the given density,
 * or -1 for AIR / no matching band.
 *
 * `worldSeed` is only read by rare_offset_by_seed bands, which no shipped biome
 * sets; the tables drop that flag, so it is not a parameter here.
 */
export function selectComponentForCell(biome, worldX, worldY, density) {
	if (!biome) return -1;
	if (!(biome.setMin <= density && density <= biome.setMax)) return -1;
	const fx = F(worldX), fy = F(worldY);
	for (const c of biome.bands) {
		if (c.limY && !(c.limY[0] <= fy && fy <= c.limY[1])) continue;
		let n = density;
		if (c.addP)
			n = F(F(ComputeMagicValueFromDoubles(F(fx * c.addP[0]), F(fy * c.addP[1]))) + density);
		if (!(c.min <= n && n < c.max)) continue;
		if (!c.rare) return c.mat;
		const r = c.rare;
		const rx = F(F(fx * r.sx) + r.ox);
		const ry = F(F(fy * r.sy) + r.oy);
		if (r.perlin) {
			const p = F(ComputeMagicValueFromDoubles(rx, ry));
			if (!(r.rmin < p && p <= r.rmax)) continue;
		}
		if (!r.polka) return c.mat;
		const k = F(rarePolkaTest(rx, ry, r.plo, r.phi, r.boxed, r.prob));
		if (r.rmin < k && k <= r.rmax) return c.mat;
	}
	return -1;
}

/** Material name for an id from the tables above, or null. */
export function materialNameForId(id) {
	return (id >= 0 && id < MATERIAL_NAMES_BY_ID.length) ? MATERIAL_NAMES_BY_ID[id] : null;
}

/** The inverse: engine material id for a name, or -1 when the tables lack it. */
let _idByName = null;
export function materialIdForName(name) {
	if (!_idByName) {
		_idByName = new Map();
		MATERIAL_NAMES_BY_ID.forEach((n, i) => { if (n) _idByName.set(n, i); });
	}
	return _idByName.get(name) ?? -1;
}
