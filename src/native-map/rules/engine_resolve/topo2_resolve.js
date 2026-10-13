// Adapted into the owned Noitamap rules runtime. See NOTICE.txt for provenance.
// Standalone reference implementation of Noita's topology-2 per-pixel terrain
// resolve (WorldSave_ResolveCellMaterialAtPixel @0x0087d0e0, topology 2 branch).
//
// Chain (see docs/worldgen/topology2_resolve.md):
//   coord0 = BiomeNodeLookupCoord(0, x, y)            @0x0087ce50
//   idx0   = WangGrid_LookupMaterialIndex(coord0)     @0x008712d0
//   -> per-material scale/threshold/samplerType (CellData +0x234/+0x238/+0x23c)
//   coord  = BiomeNodeLookupCoord(scale, x, y)
//   cov    = sampler(coord)   type 0 @0x00870e60 / 1 @0x00871160 / 2 @0x00870f80
//   cov < threshold                -> AIR
//   idx2 = WangGrid_LookupMaterialIndex(coord) >= 1 -> explicit material
//   else density = ComputeMaterialNoiseDensity(x,y,cov)  @0x0087d010
//
// Every float32 op is Math.fround'ed in the binary's exact instruction order.
import { carveSimplex2D } from './carve_noise.js';
import { perlin2D, valueNoisePerlinPerm2D } from './perlin_noise.js';

const F = Math.fround;

// ---- exact constants, reconstructed from their .rdata bit patterns ----------
const _b = new ArrayBuffer(8);
const _dv = new DataView(_b);
function dblFromHex(hi, lo) { _dv.setUint32(0, hi); _dv.setUint32(4, lo); return _dv.getFloat64(0); }
function fltFromHex(u) { _dv.setUint32(0, u); return _dv.getFloat32(0); }

export const K = {
	// worldOffX is the engine global @0x01206fb0 = the biome grid's x shift,
	// mapWidth*256: 17920 on the 70-chunk ng0 grid, 16384 on the 64-chunk
	// NG+/nightmare grid. Hardcoding 17920 shifted every NG+ topo2 sample --
	// and with it the decal tiles and CPU provenance -- 1536px west of the
	// GL terrain (which centers on u_centerPx correctly): user-measured
	// offset -3361 vs -1826 at seed 786433191 ng2. createMaterialField sets
	// it per map via setTopo2WorldOffX before resolving.
	worldOffX: 17920.0,            // 0x01206fb0
	worldOffY: 7168.0,             // 0x012051b0
	half_d: 0.5,                   // 0x01053968 (double)
	one_d: 1.0,                    // 0x010539c0 (double)
	tenth_d: dblFromHex(0x3fb99999, 0x9999999a),   // 0x01053898 = 0.1
	warpCx: dblFromHex(0x3fc18e21, 0x9652bd3c),    // 0x010538c0
	warpCy: dblFromHex(0x3fc18ec9, 0x5bff0457),    // 0x010538c8
	f2: dblFromHex(0x3fbc71c7, 0x20000000),        // 0x010538b0 = float(1/9) widened
	a_mul: fltFromHex(0x3ee66666),                 // 0x010535e4 = 0.45f
	a_add: fltFromHex(0x3dcccccd),                 // 0x010534fc = 0.1f
	y_mul: fltFromHex(0x3ea8f5c3),                 // 0x01053598 = 0.33f
	y_add: fltFromHex(0x3de353f8),                 // 0x01053504 = 0.111f
	one_f: fltFromHex(0x3f800000),                 // 0x01053780 = 1.0f
	half_f: fltFromHex(0x3f000000),                // 0x0105361c = 0.5f
	two_f: fltFromHex(0x40000000),                 // 0x010539f8 = 2.0f
	three_f: fltFromHex(0x40400000),               // 0x01053ae8 = 3.0f
	dens_x: dblFromHex(0x3fa1eb85, 0x1eb851ec),    // 0x01053828 = 0.035
	dens_y: dblFromHex(0x3fb1eb85, 0x1eb851ec),    // 0x01053878 = 0.07
	dens_warp: fltFromHex(0x41780000),             // 0x01053d20 = 15.5f
	dens_scale: fltFromHex(0x3d486834),            // 0x010534c4 = 0.048927501f
	dens_k1: fltFromHex(0x40ab3333),               // 0x01053c20 = 5.35f
	dens_k2: fltFromHex(0x3f733333),               // 0x0105373c = 0.95f
};

export function setTopo2WorldOffX(px) { K.worldOffX = px; }

// ---------------------------------------------------------------------------
// Grid2D wrapped sampling (FloatGrid2D_SampleWrapped @0x0092a310, and the u16
// twin Grid2D_GetMaterialIdAt @0x0092a1d0 -- identical index math).
// ---------------------------------------------------------------------------
function wrapIndex(v, n) {
	if (v < 0) v += (1 - Math.trunc(v / n)) * n;
	if (v >= n) v = v % n;
	return v;
}

export class CoverGrid {
	constructor(w, h, cov, mat) { this.w = w; this.h = h; this.cov = cov; this.mat = mat; }
	cval(x, y) {
		const w = this.w, h = this.h;
		if (w <= 0 || h <= 0) return 0;
		return this.cov[wrapIndex(y, h) * w + wrapIndex(x, w)];
	}
	mval(x, y) {
		const w = this.w, h = this.h;
		if (w <= 0 || h <= 0) return 0;
		return this.mat[wrapIndex(y, h) * w + wrapIndex(x, w)] & 0xffff;
	}
}

// smoothstep fade s(t) = (3 - t*2) * (t*t), exact op order
function sstep(t) {
	const sq = F(t * t);
	const lin = F(t * K.two_f);
	return F(F(K.three_f - lin) * sq);
}

// ---------------------------------------------------------------------------
// BiomeNodeLookupCoord @0x0087ce50
//   ECX=&out float[2], XMM1=scale (float), XMM2=x (double), XMM3=y (double)
// ---------------------------------------------------------------------------
export function lookupCoord(scale, x, y) {
	scale = F(scale);
	const X = K.worldOffX + x;               // doubles
	const Y = K.worldOffY + y;
	const gx = F((X + K.half_d) * K.tenth_d);
	const gy = F((Y + K.half_d) * K.tenth_d);
	if (!(scale > 0)) return [gx, gy];       // COMISS 0,scale / JNC

	const fgx = Math.floor(gx) | 0;          // Math_Floor @0x0044a390 then CVTTSS2SI
	const fgy = Math.floor(gy) | 0;

	// warp amplitude
	const sxArg = F(X * K.warpCx);
	const syArg = F(Y * K.warpCy);
	const A = F(F(carveSimplex2D(sxArg, syArg) * K.a_mul) + K.a_add);

	const Yf = F(Y * K.f2);
	const Xf = F(X * K.f2);

	// --- Y component: Perlin2D with X/Y arguments SWAPPED ---
	const pv = perlin2D(Yf, Xf);
	let fy = F(K.one_f - A);
	fy = F(fy * K.y_mul);
	fy = F(fy + K.y_add);
	fy = F(fy * scale);
	let outY = F(pv * fy);
	const fracY = F(gy - fgy);
	outY = F(outY + fracY);

	// --- X component ---
	const vn = valueNoisePerlinPerm2D(Xf, Yf);
	const ax = F(A * scale);
	let outX = F(vn * ax);
	const fracX = F(gx - fgx);
	outX = F(outX + fracX);
	outX = F(outX + fgx);

	outY = F(fgy + outY);
	return [outX, outY];
}

// ---------------------------------------------------------------------------
// FloatGrid2D_SampleBilinearSmooth @0x00870e60 (wang_noise_type 0)
// ---------------------------------------------------------------------------
export function sampleBilinearSmooth(g, sx, sy) {
	const x0 = Math.floor(sx), y0 = Math.floor(sy);
	const fx = F(sx - x0);
	const fyd = sy - y0;                     // kept double until the end
	const sFx = sstep(fx);
	const cTL = g.cval(x0, y0 + 1);
	const cBL = g.cval(x0, y0);
	const cBR = g.cval(x0 + 1, y0);
	const bottom = F(F(F(cBR - cBL) * sFx) + cBL);
	const cTR = g.cval(x0 + 1, y0 + 1);
	const top = F(F(F(cTR - cTL) * sFx) + cTL);
	const sFy = sstep(F(fyd));
	return F(F(F(top - bottom) * sFy) + bottom);
}

// ---------------------------------------------------------------------------
// FloatGrid2D_SampleCoverageEdge @0x00871160 (wang_noise_type 1)
// ---------------------------------------------------------------------------
export function sampleCoverageEdge(g, sx, sy) {
	const xp = sx + K.half_d, yp = sy + K.half_d;
	const x0 = Math.floor(xp), y0 = Math.floor(yp);
	if (g.cval(x0, y0) > K.half_f) return K.one_f;
	const fx = F(xp - x0);
	const fy = F(yp - y0);
	const omfx = F(K.one_f - fx);
	let nx, ny;
	if (fx >= fy) {
		if (omfx <= fy) { nx = x0 + 1; ny = y0; }
		else { nx = x0; ny = y0 - 1; }
	} else {
		if (omfx <= fy) { nx = x0; ny = y0 + 1; }
		else { nx = x0 - 1; ny = y0; }
	}
	if (g.cval(nx, ny) >= K.half_f) return K.one_f;
	const sx1 = x0 + (fx >= K.half_f ? 1 : -1);
	const sy1 = y0 + (fy >= K.half_f ? 1 : -1);
	if (g.cval(sx1, sy1) < K.half_f) return 0;
	if (g.cval(sx1, y0) >= K.half_f) return K.one_f;
	return g.cval(x0, sy1) >= K.half_f ? K.one_f : 0;
}

// ---------------------------------------------------------------------------
// FloatGrid2D_SampleMaterialEdge @0x00870f80 (wang_noise_type 2)
// ---------------------------------------------------------------------------
export function sampleMaterialEdge(g, sx, sy) {
	const xp = sx + K.half_d, yp = sy + K.half_d;
	const x0 = Math.floor(xp), y0 = Math.floor(yp);
	if (g.cval(x0, y0) > K.half_f) return K.one_f;
	const fx = xp - x0;                       // doubles here
	const fy = yp - y0;
	const dx = fx >= fy ? 1 : -1;
	const dy = fx >= fy ? -1 : 1;
	const m0 = g.mval(x0, y0);
	const ax = x0 + dx, by = y0 + dy;
	if (g.cval(ax, y0) >= K.half_f && g.cval(x0, by) >= K.half_f &&
		g.mval(ax, y0) === m0 && g.mval(x0, by) === m0) return K.one_f;
	const d = (K.one_d - fx) >= fy ? -1 : 1;
	const cx = x0 + d, cy = y0 + d;
	if (g.cval(cx, y0) >= K.half_f && g.cval(x0, cy) >= K.half_f &&
		g.mval(cx, y0) === m0 && g.mval(x0, cy) === m0) return K.one_f;
	return 0;
}

export function sampleByType(g, type, cx, cy) {
	if (type === 1) return sampleCoverageEdge(g, cx, cy);
	if (type === 2) return sampleMaterialEdge(g, cx, cy);
	return sampleBilinearSmooth(g, cx, cy);
}

// ---------------------------------------------------------------------------
// WangGrid_LookupMaterialIndex @0x008712d0 -- smoothstep-aware nearest cell
// ---------------------------------------------------------------------------
export function wangLookup(g, cx, cy) {
	let x0 = Math.floor(cx), y0 = Math.floor(cy);
	const fx = F(cx - x0);
	const fy = F(cy - y0);
	const sFx = sstep(fx);
	const sFy = sstep(fy);
	if (!(K.half_f > sFy)) y0 += 1;
	if (!(K.half_f > sFx)) x0 += 1;
	return (g.mval(x0, y0) & 0xffff) - 1;
}

// ---------------------------------------------------------------------------
// BiomeMaterials_ComputeMaterialNoiseDensity @0x0087d010
// ---------------------------------------------------------------------------
export function computeMaterialNoiseDensity(x, y, coverage) {
	const cov = F(coverage);
	const n1 = valueNoisePerlinPerm2D(F(x * K.dens_x), F(y * K.dens_y));
	const warp = F(n1 * K.dens_warp);
	const t = F(F(cov - K.half_f) * K.half_f);
	const sy = F(F(F(y) + warp) * K.dens_scale);
	const sx = F(F(F(x) + warp) * K.dens_scale);
	const n2 = carveSimplex2D(sx, sy);
	let m = F(t * t);
	m = F(m * K.dens_k1);
	m = F(m * K.dens_k2);
	const r = F(F(n2 * m) + cov);
	return K.half_f > r ? K.half_f : r;
}

// ---------------------------------------------------------------------------
// Full topology-2 resolve for one world pixel.
// getParams(idx) -> {scale, threshold, type} | null (null = "no CellData")
// ---------------------------------------------------------------------------
export const DEFAULT_PARAMS = { scale: 1.0, threshold: 0.5, type: 0 };

export function resolvePixel(g, x, y, getParams) {
	const c0 = lookupCoord(0, x, y);
	const idx0 = wangLookup(g, c0[0], c0[1]);
	let p = DEFAULT_PARAMS;
	if (idx0 >= 1) {
		const q = getParams(idx0);
		if (q) p = q;
	}
	const c = lookupCoord(p.scale, x, y);
	const cov = sampleByType(g, p.type, c[0], c[1]);
	const out = { coord0: c0, idx0, params: p, coord: c, cov, status: 0, mat: 0, density: 0 };
	if (cov < F(p.threshold)) { out.status = 1; return out; }
	const idx2 = wangLookup(g, c[0], c[1]);
	if (idx2 >= 1) { out.status = 2; out.mat = idx2; return out; }
	out.status = 3;
	out.density = computeMaterialNoiseDensity(x, y, cov);
	return out;
}
