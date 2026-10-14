// BitmapCaves density-modifier grid replay - the engine-side blob generator that
// creates cave carves, blob caves and the "mountain" bumps (= the floating
// islands / donuts above the hills surface).
//
// Ported from noita.exe:
//   BiomeNode_GetOrCreateProceduralDensityGrid @0x0086b830 (grid + seeding)
//   BiomeGen_GenerateProceduralContent         @0x00868f70 (phases A/B/C)
//   BiomeGen_CarveCaveWalker                   @0x00868400 (phase A serpentine carver)
//   BiomeGen_PaintDensityDisk_Min/_Lerp        @0x00868020 / @0x00868190
//   FloatGrid2D_SampleBilinearSmooth           @0x00870e60 (+ toroidal SampleWrapped)
//   MINSTD_SeedAndStep                         @0x0044d070
//   LehmerLCG_RandFloatRangeXMM / _RangeRand   @0x0044d0e0 / @0x0044d140
//
// One grid exists per biome NAME per world seed: hills.xml (and every other
// unnamed procedural biome) shares the "_EMPTY_" grid; desert/winter/pyramid
// have their own. The generation chain seeds from the RAW world seed only, so
// grids are NG+- and parallel-world-invariant (sampling wraps toroidally every
// ~10414.5 px). Phases D/E/F (dead CaveStructure stamps, beginning paths)
// consume RNG only AFTER phases A-C, so they are not replayed.
//
// PARITY STATUS (2026-08-04, vs live-dumped seed-1 grids in
// reverse/noita/groundtruth/surface/):
// - DESERT: BYTE-EXACT (0 of 131072 cells differ). The last dust (215 cells,
//   1-ULP class) was the surface-cave depth multiplier being carried as a
//   double ("depth *= floatRange(...)") where the binary MULSSes to float32;
//   the walker then double-rounded e = F(t/0.2 * targetDepth). Keep EVERY
//   value that crosses a walker/stamp boundary f32 (wrap ops in F()).
//   Earlier fixes: child walkers spawn at the parent's pre-advance position
//   (&local_54), reroll draw precedes the childs draw, per-step bounds break,
//   float32 placement lerps, phase E (do_beginning_paths) replay, and three
//   non-canonical .rdata float literals (0x3CF5C280 mountain decay 0.0299...,
//   0x3ECCCCCE envelope divisor 0.4000..., 0x3EA3D70B wobble 0.3200...).
// - PYRAMID: BYTE-EXACT vs the seed-786433191 live grid once pyramid_right's
//   six <CaveStructure> draw batches are replayed (see the entry's note).
// - WINTER/_EMPTY_: byte-exact except phase F (do_beginning_down), which mixes
//   the global MSVC LCG g_damageRng into its draws and is NOT statically
//   replayable (winter residual: 2343 cells, all real phase-F carves, zero
//   1-ULP-class dust). _EMPTY_ additionally mutates at runtime where chunks
//   generate (mask cols 210-264 for seed-1 spawn-area dumps).
//
// No imports beyond dependency-free modules (node tests exercise this file).
// Owned seed-input preparation; no imports or global seed caches.

const F = Math.fround;
const C_UNIT = 4.656612875e-10; // double @0x01053510 (the game's decimal literal for 1/2^31)
const GRID_SCALE_X = 0.49162514; // double @0x01053958
const GRID_SCALE_Y = 6.86035959282328e-7; // double @0x01053590
const SAMPLE_MUL = F(0.1); // float @0x010534fc
const BLEND_0495 = F(0.495); // float @0x01053618
const TAPER_DIV = 25; // float 25.0 @0x01053d60; taper rows y<25 (0x19)

// <BitmapCaves> params per grid cache key. _EMPTY_ is created by the first
// unnamed procedural biome (hills.xml family - validated against the live grid
// dump). Biomes without a <BitmapCaves> element never create a grid (modifier
// stays 1.0), so they don't appear here.
export const CAVES_SETUP = {
	'_EMPTY_': {
		sizeX: 512, sizeY: 256, doBeginningPaths: true, doBeginningDown: true,
		caveCount: [50, 100], surfaceCaves: [7, 12], caveStrength: [0.2, 1],
		caveChilds: [0, 2], surfaceCaveChilds: [2, 7],
		mountainCount: [0, 15], mountainSize: [1, 10],
		blobCount: [20, 55], blobStrength: [1.5, 3], blobRadius: [1, 10],
		// <CaveStructure> entries from hills.xml: visually DEAD (stamping cut
		// pre-release) but each consumes RNG draws between phases C and E -
		// skipping them desyncs the do_beginning_paths carve positions (this
		// was the winter/hills grid parity bug: phantom carves at grid center).
		structures: [
			{ templated: true, countMin: 5, countMax: 12, aabbMinY: 0, aabbMaxY: 20, aabbMinX: 5, aabbMaxX: 507, strengthMin: 0.55, strengthMax: 2.15 }, // cave_$[0-999].png
			{ templated: false, countMin: 0, countMax: 4, aabbMinY: 0, aabbMaxY: 20, aabbMinX: 5, aabbMaxX: 507, strengthMin: 1.45, strengthMax: 1.55 }, // mountain_rock.png
			{ templated: false, countMin: 0, countMax: 3, aabbMinY: 0, aabbMaxY: 5, aabbMinX: 5, aabbMaxX: 507, strengthMin: 1.45, strengthMax: 1.55 }, // skull_mountain.png
			{ templated: true, countMin: 3, countMax: 3, aabbMinY: 0, aabbMaxY: 5, aabbMinX: 5, aabbMaxX: 507, strengthMin: 1.45, strengthMax: 1.55 }, // eye_0$[1-4].png (hills only)
			{ templated: false, countMin: 0, countMax: 3, aabbMinY: -8, aabbMaxY: 2, aabbMinX: 5, aabbMaxX: 507, strengthMin: 0.0, strengthMax: 0.65 }, // pit.png
			{ templated: false, countMin: 0, countMax: 5, aabbMinY: -8, aabbMaxY: 2, aabbMinX: 5, aabbMaxX: 507, strengthMin: 0.0, strengthMax: 0.40 }, // deep_pit.png
			{ templated: false, countMin: 0, countMax: 3, aabbMinY: 0, aabbMaxY: 15, aabbMinX: 5, aabbMaxX: 507, strengthMin: 1.15, strengthMax: 1.85 }, // brush_03.png
			{ templated: false, countMin: 0, countMax: 4, aabbMinY: 0, aabbMaxY: 15, aabbMinX: 5, aabbMaxX: 507, strengthMin: 0.5, strengthMax: 2.85 }, // brush_04.png
			{ templated: false, countMin: 0, countMax: 3, aabbMinY: 0, aabbMaxY: 25, aabbMinX: 5, aabbMaxX: 507, strengthMin: 0.15, strengthMax: 2.15 }, // brush_05.png
			{ templated: false, countMin: 0, countMax: 4, aabbMinY: 0, aabbMaxY: 35, aabbMinX: 5, aabbMaxX: 507, strengthMin: 0.55, strengthMax: 1.85 }, // brush_06.png
		],
	},
	'$biome_winter': {
		sizeX: 512, sizeY: 256, doBeginningPaths: true, doBeginningDown: true,
		caveCount: [50, 100], surfaceCaves: [7, 12], caveStrength: [0.2, 1],
		caveChilds: [0, 2], surfaceCaveChilds: [2, 7],
		mountainCount: [0, 15], mountainSize: [1, 10],
		blobCount: [20, 55], blobStrength: [1.5, 3], blobRadius: [1, 10],
		// winter.xml <CaveStructure> list = hills minus the eye entry; same
		// draw-consumption-only role (see _EMPTY_ note).
		structures: [
			{ templated: true, countMin: 5, countMax: 12, aabbMinY: 0, aabbMaxY: 20, aabbMinX: 5, aabbMaxX: 507, strengthMin: 0.55, strengthMax: 2.15 }, // cave_$[0-999].png
			{ templated: false, countMin: 0, countMax: 4, aabbMinY: 0, aabbMaxY: 20, aabbMinX: 5, aabbMaxX: 507, strengthMin: 1.45, strengthMax: 1.55 }, // mountain_rock.png
			{ templated: false, countMin: 0, countMax: 3, aabbMinY: 0, aabbMaxY: 5, aabbMinX: 5, aabbMaxX: 507, strengthMin: 1.45, strengthMax: 1.55 }, // skull_mountain.png
			{ templated: false, countMin: 0, countMax: 3, aabbMinY: -8, aabbMaxY: 2, aabbMinX: 5, aabbMaxX: 507, strengthMin: 0.0, strengthMax: 0.65 }, // pit.png
			{ templated: false, countMin: 0, countMax: 5, aabbMinY: -8, aabbMaxY: 2, aabbMinX: 5, aabbMaxX: 507, strengthMin: 0.0, strengthMax: 0.40 }, // deep_pit.png
			{ templated: false, countMin: 0, countMax: 3, aabbMinY: 0, aabbMaxY: 15, aabbMinX: 5, aabbMaxX: 507, strengthMin: 1.15, strengthMax: 1.85 }, // brush_03.png
			{ templated: false, countMin: 0, countMax: 4, aabbMinY: 0, aabbMaxY: 15, aabbMinX: 5, aabbMaxX: 507, strengthMin: 0.5, strengthMax: 2.85 }, // brush_04.png
			{ templated: false, countMin: 0, countMax: 3, aabbMinY: 0, aabbMaxY: 25, aabbMinX: 5, aabbMaxX: 507, strengthMin: 0.15, strengthMax: 2.15 }, // brush_05.png
			{ templated: false, countMin: 0, countMax: 4, aabbMinY: 0, aabbMaxY: 35, aabbMinX: 5, aabbMaxX: 507, strengthMin: 0.55, strengthMax: 1.85 }, // brush_06.png
		],
	},
	'$biome_desert': {
		sizeX: 512, sizeY: 256, doBeginningPaths: true,
		caveCount: [10, 30], surfaceCaves: [1, 3], caveStrength: [0.2, 1],
		caveChilds: [0, 2], surfaceCaveChilds: [0, 4],
		mountainCount: [0, 3], mountainSize: [1, 5],
		blobCount: [5, 15], blobStrength: [1.0, 3], blobRadius: [1, 10],
	},
	// $biome_pyramid is declared by pyramid_right.xml, pyramid_hallway.xml and
	// pyramid.xml. The name-keyed cache entry is created by the first PROCEDURAL
	// biome loaded under the name (pyramid.xml is BIOME_WANG_TILE and takes the
	// wang arm of Biome_InitializeFromConfig, never touching the cache), and
	// _biomes_all.xml lists pyramid_right (line 103) before pyramid_hallway
	// (106): pyramid_right.xml's block and its six <CaveStructure> entries are
	// the ones that count. hallway's list (same six plus a leading
	// mountain_rock) is one draw-batch off and leaves 2,268 cells wrong.
	//
	// BYTE-EXACT vs the live grid (reverse/noita/groundtruth/bitmap_caves/
	// pyramid_seed786433191_modifier.f32, PEEKed out of the running game
	// 2026-08-28): 0 of 131072 cells differ. Without the structures the two
	// phase-E beginning paths land off by a draw batch (2,290 cells).
	'$biome_pyramid': {
		sizeX: 512, sizeY: 256, doBeginningPaths: true,
		caveCount: [10, 30], surfaceCaves: [1, 3], caveStrength: [0.2, 1],
		caveChilds: [0, 2], surfaceCaveChilds: [0, 4],
		mountainCount: [0, 0], mountainSize: [1, 5],
		blobCount: [5, 15], blobStrength: [1.0, 3], blobRadius: [1, 10],
		structures: [
			{ templated: false, countMin: 2, countMax: 5, aabbMinY: -8, aabbMaxY: 2, aabbMinX: 5, aabbMaxX: 507, strengthMin: 0.0, strengthMax: 0.65 }, // pit.png
			{ templated: false, countMin: 5, countMax: 8, aabbMinY: -8, aabbMaxY: 2, aabbMinX: 5, aabbMaxX: 507, strengthMin: 0.0, strengthMax: 0.40 }, // deep_pit.png
			{ templated: false, countMin: 0, countMax: 3, aabbMinY: 0, aabbMaxY: 15, aabbMinX: 5, aabbMaxX: 507, strengthMin: 1.15, strengthMax: 1.85 }, // brush_03.png
			{ templated: false, countMin: 0, countMax: 4, aabbMinY: 0, aabbMaxY: 15, aabbMinX: 5, aabbMaxX: 507, strengthMin: 0.5, strengthMax: 2.85 }, // brush_04.png
			{ templated: false, countMin: 0, countMax: 3, aabbMinY: 0, aabbMaxY: 25, aabbMinX: 5, aabbMaxX: 507, strengthMin: 0.15, strengthMax: 2.15 }, // brush_05.png
			{ templated: false, countMin: 0, countMax: 4, aabbMinY: 0, aabbMaxY: 35, aabbMinX: 5, aabbMaxX: 507, strengthMin: 0.55, strengthMax: 1.85 }, // brush_06.png
		],
	},
};

// ---- MINSTD (Park-Miller 16807 mod 2^31-1; double state holding an int) ----
function minstdStep(s) {
	let t = (s * 16807) % 2147483647;
	if (t <= 0) t += 2147483647;
	return t;
}

// MINSTD_SeedAndStep @0x0044d070: halve once if >= 2147483646.0, truncate, one step.
export function minstdSeedAndStep(x) {
	let s = x;
	if (s >= 2147483646.0) s *= 0.5;
	return minstdStep(Math.trunc(s));
}

// state -> u draw ("u = s * 4.656612875e-10", the generator's inline form)
function u(st) {
	st.s = minstdStep(st.s);
	return st.s * C_UNIT;
}

// LehmerLCG_RandFloatRangeXMM @0x0044d0e0: float32 result
function floatRange(st, lo, hi) {
	st.s = minstdStep(st.s);
	const uu = F(st.s * C_UNIT);
	return F(F(uu * F(F(hi) - F(lo))) + F(lo));
}

// LehmerLCG_RangeRand @0x0044d140: lo - trunc((hi-lo+1) * (s * -C_UNIT)), inclusive
function intRange(st, lo, hi) {
	st.s = minstdStep(st.s);
	return lo - Math.trunc((hi - lo + 1) * (st.s * -C_UNIT));
}

// float32 lerp exactly as the generator computes it: (hi-lo)*u + lo, all MULSS/ADDSS
const lerpF = (lo, hi, uu) => F(F(F(hi - lo) * F(uu)) + lo);
const clamp = (v, lo, hi) => v < lo ? lo : (v > hi ? hi : v);

// ---- Disk stamps (exact loops from the binary) ----
// Min-merge carve @0x00868020: v = 1 + ((r2-d2)/r2)*(target-1); center-row<25
// tapers v toward 1 by (y/25)^8; grid = min(grid, v). r<=1: single-pixel min.
function diskMin(g, x, y, taper, r, target) {

	if (r > 1.0) {
		const r2 = F(r * r);
		const R = Math.trunc(r + 0.5);
		let tw8 = 1;
		if (taper && y < 25) {
			let f = F(y / TAPER_DIV);
			f = F(f * f); f = F(f * f);
			tw8 = F(f * f); // (y/25)^8 via three MULSS squarings
		}
		for (let dy = -R; dy <= R; dy++) {
			for (let dx = -R; dx <= R; dx++) {
				const d2 = F(dx * dx + dy * dy);
				if (d2 <= r2) {
					// MULSS then ADDSS: each op rounds separately
					let v = F(F(F(F(r2 - d2) / r2) * F(target - 1)) + 1);
					if (taper && y < 25) v = F(F(F(v - 1) * tw8) + 1);
					const px = x + dx, py = y + dy;
					if (px >= 0 && py >= 0 && px < g.W && py < g.H) {
						const i = py * g.W + px;
						if (v < g.data[i]) g.data[i] = v;
					}
				}
			}
		}
	} else if (x >= 0 && y >= 0 && x < g.W && y < g.H) {
		const i = y * g.W + x;
		if (target < g.data[i]) g.data[i] = target;
	}
}

// Lerp blend @0x00868190: grid = grid + (target-grid)*w^2, w = (r2-d2)/r2.
// r<=1 degenerates to a single-pixel MIN write (as in the binary).
function diskLerp(g, x, y, r, target) {

	if (r > 1.0) {
		const r2 = F(r * r);
		const R = Math.trunc(r + 0.5);
		for (let dy = -R; dy <= R; dy++) {
			for (let dx = -R; dx <= R; dx++) {
				const d2 = F(dx * dx + dy * dy);
				if (d2 <= r2) {
					const px = x + dx, py = y + dy;
					if (px >= 0 && py >= 0 && px < g.W && py < g.H) {
						const i = py * g.W + px;
						const w2 = F(F(F(r2 - d2) / r2) * F(F(r2 - d2) / r2));
						g.data[i] = F(F(F(F(target) - g.data[i]) * w2) + g.data[i]);
					}
				}
			}
		}
	} else if (x >= 0 && y >= 0 && x < g.W && y < g.H) {
		const i = y * g.W + x;
		if (target < g.data[i]) g.data[i] = target;
	}
}

// ---- Phase A serpentine cave carver (BiomeGen_CarveCaveWalker @0x00868400) ----
// Draw order transcribed from the plate; spawn_percent is 0 for the surface
// biomes (no XML attr, ctor default), so the S3/S4 spawn draws never happen.
function carveWalker(st, g, x, y, targetDepth, steps, dir, stepY, reroll, childBudget) {
	const wobbly = u(st) * 101 < 50; // W1
	const base = F(F(2 + Math.trunc(u(st) * 4)) / F(5)); // W2: sizeClass 2..5
	const rStart = F(F(F(F(u(st)) * F(0.2)) + 0) * base); // W3
	const rA = F(F(F(F(u(st)) * F(2.5)) + 1) * base); // W4
	const rB = F(F(F(F(u(st)) * F(2.5)) + 1) * base); // W5
	const rEnd = F(F(F(F(u(st)) * F(0.2)) + 0) * base); // W6
	if (steps < 0) return;
	// positions and all per-step math are float32 in the binary (MOVSS/ADDSS)
	let fx = F(x), fy = F(y);
	let sinceReroll = 0;
	for (let i = 0; F(i) <= steps; i++) {
		// per-step bounds/abort check (the walker RETURNS when the position
		// leaves the grid mid-walk - draw counts depend on this)
		const px = Math.trunc(fx), py = Math.trunc(fy);
		if (px < 0 || py < 0 || px >= g.W || py >= g.H || targetDepth <= 0) break;
		const t = F(F(i) / steps);
		let e;
		if (t < F(0.2)) e = F(F(t / F(0.2)) * targetDepth);
		else if (t > F(0.6)) e = F(F(0.7) - F(F(F(t - F(0.6)) / F(0.6)) * F(0.7)));
		else e = F(targetDepth + F(F(F(t - F(0.2)) / 0.40000003576278687) * F(F(0.7) - targetDepth))); // divisor float 0x3ECCCCCE (non-canonical); literal IS the exact f32 value
		let target = F(1.0 - e);
		let r;
		if (t < F(0.3)) r = F(rStart + F(F(t / F(0.3)) * F(rA - rStart)));
		else if (t > F(0.6)) r = F(rB + F(F(F(t - F(0.6)) / F(0.6)) * F(rEnd - rB)));
		else r = F(rA + F(F(F(t - F(0.3)) / F(0.3)) * F(rB - rA)));
		target = F(target + F(F(F(u(st)) * F(0.35)) - F(0.25))); // S1
		if (wobbly) target = F(target * F(F(F(u(st)) * 0.32000002264976501) + F(0.35))); // S2; scale float 0x3EA3D70B (non-canonical)
		target = clamp(target, 0, 1);
		diskMin(g, px, py, 1, r, target);
		fy = F(fy + stepY);
		// Spawn-point rolls (CavesSetup spawn_percent ctor default 0.05, never
		// overridden in XML; both spawn fns exist for the surface biomes). The
		// spawns don't touch the grid but their draws must be replayed.
		if (u(st) < 0.05) { // S3
			u(st); // S4: which spawn fn
			u(st); u(st); // TrySpawnAtPathStep jitter draws
		}
		let d = u(st) * 101 < 25 ? -1.0 : 0.0; // S5
		if (u(st) * 101 < 25) d += 1.0; // S6
		const hi = Math.max(dir, 0), lo = Math.min(dir, 0);
		const stepX = clamp(F(F(F(F(hi - lo) * F(u(st))) + lo) + d), -1.0, 1.0);
		fx = F(fx + stepX); // S7
		sinceReroll++;
		const V = 0; // Pinned default source behavior; diagnostic globals cannot alter inputs.
		if (V === 0 ? sinceReroll > 50 : V === 1 ? sinceReroll >= 50 : sinceReroll > 50) {
			const u8 = F(u(st));
			if (reroll > u8) { // S8 (game: COMISS reroll, F(u); fire iff reroll > u strictly)
				dir = F(F(F(u(st)) * 2.0) - 1.0); // S9
				sinceReroll = 0;
			} else if (V === 2) {
				sinceReroll = 0; // variant: reset even on fail
			}
		}
		if (childBudget.v > 0) {
			if (F(u(st)) * 100 < 2.0) { // S10
				childBudget.v--;
				const childSteps = F(F(F(F(u(st)) * 50) - 50) + F(steps - F(i))); // S11
				// the child starts at THIS step's disk position (captured at the
				// loop top, before fy += stepY and the x drift - &local_54)
				carveWalker(st, g, px, py, targetDepth, childSteps,
					-dir, stepY, reroll, childBudget);
			}
		}
	}
}

// ---- Generator phases A/B/C (BiomeGen_GenerateProceduralContent @0x00868f70) ----
function generate(cfg, g, st) {
	const W = g.W, H = g.H;
	// PHASE A: serpentine caves (must be replayed before B for RNG parity)
	const nCaves = intRange(st, cfg.caveCount[0], cfg.caveCount[1]);
	const nSurf = intRange(st, cfg.surfaceCaves[0], cfg.surfaceCaves[1]);
	let surfDone = 0, flag = 0, prevX = 0, prevY = 0;
	for (let i = 0; i < nCaves; i++) {

		let depth = floatRange(st, cfg.caveStrength[0], cfg.caveStrength[1]);
		let x, y;
		const Wf = F(W), Hf = F(H);
		if (flag === 0) {
			y = Math.trunc(lerpF(F(Hf * F(0.07)), F(Hf * F(0.33)), u(st)));
			x = Math.trunc(F(F(F(F(F(Wf - 5) - 5) * F(u(st)))) + 5));
			if (surfDone < nSurf) {
				const sw = F(Wf / F(nSurf)); // float division (spread range)
				const lo = F(sw * F(-0.45)), hi = F(sw * F(0.45));
				// base uses INTEGER division W/nSurf (differs from sw when nSurf=3)
				const bx = Math.trunc(F(F(Math.trunc(W / nSurf)) * F(i))) + Math.trunc(lerpF(lo, hi, u(st)));
				x = clamp(bx + Math.trunc(lerpF(lo, hi, u(st))), 5, W - 5);
				y = Math.trunc(u(st) * 6.0);
				const k = Math.trunc(u(st) * -3.0); // 0 / -1 / -2
				const MULT = { 3: [0.1, 0.5], 4: [0.75, 1.0], 5: [1.07, 1.2] }[3 - k];
				depth = F(depth * floatRange(st, MULT[0], MULT[1])); // MULSS: keep f32 (bare *= carried a double -> 1-ULP dust)
				surfDone++;
				flag = 1;
			}
		} else {
			x = prevX + Math.trunc(lerpF(F(Wf * F(-0.01)), F(Wf * F(0.01)), u(st)));
			y = prevY + Math.trunc(lerpF(F(Hf * F(0.05)), F(Hf * F(0.25)), u(st)));
			flag = 0;
		}
		prevX = x; prevY = y;

		u(st); // jitterScale (dead in the walker - draw kept for parity)
		const dyv = F(H - y);
		let len = lerpF(F(dyv * F(0.15)), F(dyv * F(0.96)), u(st));
		let dir = F(F(F(u(st)) * 2) - 1);
		let stepY = F(F(F(u(st)) * F(0.4)) + F(0.1));
		if (u(st) * 101 < 33) stepY = F(stepY + F(0.5));
		let reroll = F(u(st)); // reroll draw comes BEFORE the childs draw
		const childs = { v: intRange(st, cfg.caveChilds[0], cfg.caveChilds[1]) };
		if (u(st) * 101 < 10) childs.v += Math.trunc(u(st) * 8.0);
		if (flag) {
			len = lerpF(F(dyv * F(0.45)), F(dyv * F(0.96)), u(st));
			u(st); // jitterScale override (jitterScale is dead in the walker)
			childs.v += intRange(st, cfg.surfaceCaveChilds[0], cfg.surfaceCaveChilds[1]);
			if (u(st) * 101 < 20) childs.v += 2 - Math.trunc(u(st) * 5.0);
		}
		// these two rolls are COMMON to all caves (not surface-only)
		if (u(st) * 101 < 50) reroll = 0;
		if (u(st) * 101 < 50) reroll = F(reroll * reroll); // MULSS: keep f32
		carveWalker(st, g, x, y, depth, F(len / stepY), F(dir * dir), stepY, reroll, childs);
	}

	// PHASE B: mountains (ADDITIVE bumps in the top 10% of rows = the islands)
	const nMountains = intRange(st, cfg.mountainCount[0], cfg.mountainCount[1]);
	for (let i = 0; i < nMountains; i++) {
		const y0 = Math.trunc(F(F(F(H) * F(0.1)) * F(u(st))));
		const x = 5 + Math.trunc((W - 9) * u(st));
		let radius = floatRange(st, cfg.mountainSize[0], cfg.mountainSize[1]);
		let target = F(1.5); // float @0x010538bc
		let yEnd = y0 + 15 + Math.trunc(u(st) * 11.0);
		if (Math.trunc(u(st) * 101) < 20) { // ~19.8%: single boulder
			target = F(F(F(u(st)) * F(0.25)) + F(1.5));
			yEnd = y0;
		}
		for (let y = y0; y <= yEnd; y++) {
			diskLerp(g, x, y, radius, target);
			radius = F(radius + F(F(F(u(st)) * F(0.5)) + F(0.5))); // grows 0.5..1.0/row: downward cone
			if (Math.trunc(u(st) * 101) < 50) target = F(target * F(F(F(u(st)) * 0.029999971389770508) + F(0.97))); // 0x3CF5C280 (non-canonical) / 0x3F7851EC
		}
	}

	// PHASE C: blob caves (Lerp toward 1.5..3 at depth; overshoots the top
	// material band / enters the 0.85 carve regime => blobby caves)
	const nBlobs = intRange(st, cfg.blobCount[0], cfg.blobCount[1]);
	for (let i = 0; i < nBlobs; i++) {
		const y = 25 + Math.trunc((H - 29) * u(st));
		const x = 5 + Math.trunc((W - 9) * u(st));
		const target = floatRange(st, cfg.blobStrength[0], cfg.blobStrength[1]);
		const radius = floatRange(st, cfg.blobRadius[0], cfg.blobRadius[1]);
		diskLerp(g, x, y, radius, target);
	}

	// PHASE D (<CaveStructure> stamping) is dead code but consumes draws;
	// desert/pyramid have no structures, hills/winter do (handled by caller
	// config when parity for those grids is pursued - see structures field).
	if (cfg.structures) {
		for (const s of cfg.structures) {
			const n = intRange(st, s.countMin, s.countMax);
			for (let i = 0; i < n; i++) {
				u(st); // BiomeNode seed draw
				if (s.templated) u(st); // Filename_ExpandRandomRangeTemplate $[..] draw
				intRange(st, s.aabbMinY, s.aabbMaxY); // y
				intRange(st, s.aabbMinX, s.aabbMaxX); // x
				floatRange(st, s.strengthMin, s.strengthMax); // strength
			}
		}
	}
	// PHASE E - do_beginning_paths: two serpentine carvers starting at row 0
	// near the grid center (the coalmine-approach paths). All constants
	// byte-verified from the 0x0086aaa0..0x0086b12b block.
	if (cfg.doBeginningPaths) {
		let side = u(st) * 101 < 50 ? F(-1) : F(1);
		const center = F(F(W) * F(0.5));
		for (let iter = 0; iter < 2; iter++) {
			let xoff;
			if (iter === 0) {
				xoff = F(F(F(u(st)) * F(31.5)) + F(3.5));
			} else {
				side = F(-side);
				xoff = F(F(F(u(st)) * F(50)) + F(25));
			}
			let fx = F(F(xoff * side) + center);
			let fy = F(0);
			st.s = minstdStep(st.s);
			let steps = 120 - Math.trunc(st.s * -C_UNIT * 81.0); // double 81.0 @0x01053b48
			let rBase = F(F(F(u(st)) * F(3)) + F(1));
			let tBase = F(F(F(u(st)) * F(0.1)) + F(0.1));
			let drift = F(F(F(F(u(st)) * F(2.25)) + F(1.25)) * side);
			while (steps > 0) {
				const target = F(F(F(F(u(st)) * F(0.25)) + F(0.75)) * tBase);
				const radius = F(F(F(F(u(st)) * F(0.3500000238418579)) + F(0.65)) * rBase);
				diskMin(g, Math.trunc(fx), Math.trunc(fy), 0, radius, target);
				fy = F(fy + F(F(F(u(st)) * F(0.09999996423721313)) + F(0.95)));
				tBase = F(F(F(F(u(st)) * F(0.009999990463256836)) + F(0.9900000095367432)) * tBase);
				rBase = clamp(F(F(F(u(st)) + F(0.5)) * rBase), F(0.75), F(4));
				drift = clamp(F(drift + F(F(F(u(st)) * F(0.5)) - F(0.25))), F(-2.5), F(2.5));
				fx = F(fx + drift);
				steps--;
				if (u(st) * 101 < 5) { // 5% spawn roll (both spawn fns exist)
					u(st); // fn select
					u(st); u(st); // TrySpawnAtPathStep draws
				}
			}
		}
	}
	// PHASE F (do_beginning_down) mixes the global MSVC LCG (g_damageRng) into
	// its draws - not replayable statically; hills/winter grids therefore
	// cannot reach full byte parity offline. Desert/pyramid don't set it.
}

// ---- Seed chain (Biome_InitializeFromConfig): r1..r6 from the RAW world seed;
// the procedural grid seeds from the map of r5. ----
function mapToU32(r) {
	return Math.trunc(r * C_UNIT * 4294967295.0) >>> 0;
}

export function gridSeedFromWorldSeed(worldSeed) {
	let s = minstdSeedAndStep(worldSeed >>> 0);
	const r = [];
	for (let i = 0; i < 6; i++) { s = minstdStep(s); r.push(s); }
	return mapToU32(r[4]); // r5
}

// BiomeNode+0x94 of a *bitmap-noise* node (the four lakes: bitmap_noise_file
// set, no <BitmapCaves>). BiomeNode_ConstructInstance @0x0086ffb0 seeds it as
//   u = MINSTD(MINSTD(seedAndStep(nodeSeed)));  +0x94 = u*2^-31*200000 - 100000
// (float32 chain) and nothing overwrites it, because
// BiomeNode_GetOrCreateBitmapNoiseGrid @0x00867c90 never generates the grid
// (the procedural path resets +0x94 to width*5.0 = 2560). The node seed is
// r6 of the Biome_InitializeFromConfig chain (r5 seeds the procedural grids).
// CellNoise_EvaluateCaveAndMaterial then samples the 0x0 grid (-> 0.0) and
// blends the edge simplex at (wx*0.49162514 + off)*0.1, (off*6.86e-7 +
// wy*0.49162514)*0.1: this offset is where the lakes' sparse mud specks sit.
// Live: seed 786433191 -> -84616.4140625 (lake and lake_statue share the node).

export function bitmapNoiseNodeOffset(worldSeed) {
	let v;
	let s = minstdSeedAndStep(worldSeed >>> 0);
	for (let i = 0; i < 6; i++) s = minstdStep(s);
	let t = minstdSeedAndStep(mapToU32(s)); // ctor: uint -> double, halve if >= 2^31-1, step
	t = minstdStep(t);
	v = F(F(F(F(t) * F(4.656613e-10)) * F(200000)) - F(100000));
	return v;
}

// Test hook: generate a grid from an explicit already-scrambled MINSTD state.
export function generateGridFromState(key, s0) {
	const cfg = CAVES_SETUP[key];
	const g = {
		W: cfg.sizeX, H: cfg.sizeY,
		data: new Float32Array(cfg.sizeX * cfg.sizeY).fill(1.0),
		node94: F(F(cfg.sizeX) * 0.5 / 0.1),
	};
	generate(cfg, g, { s: s0 });
	return g;
}

// Fresh ownership per resolver: no process-global, unbounded seed cache.
export function getModifierGrid(worldSeed, key) {
 const cfg = CAVES_SETUP[key];
 if (!cfg) return null;
 return generateGridFromState(key, minstdSeedAndStep(gridSeedFromWorldSeed(worldSeed)));
}

// Pinned surfaceNoisePhase chain; BigInt and the rounding sequence are retained.
function minstdNext(s) {
 const v = BigInt(Math.floor(s));
 let r = 16807n * v - 2147483647n * (v / 127773n);
 if (r <= 0n) r += 2147483647n;
 return Number(r);
}
export function surfaceNoisePhase(worldSeed) {
 let s = worldSeed;
 if (s >= 2147483646.0) s = s * 0.5;
 s = minstdNext(s);
 s = minstdNext(s);
 s = minstdNext(s);
 return F(F(s * Math.pow(2, -31)) * 200000.0) - 100000.0;
}
