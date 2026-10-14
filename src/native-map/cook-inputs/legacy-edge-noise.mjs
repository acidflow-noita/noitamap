// Owned pure legacy noise; no runtime imports. See NOTICE.txt.
const getWorldSize = (isNGP, gameMode = 'normal') => isNGP || gameMode === 'nightmare' ? 64 : 70;
const getWorldCenter = (isNGP, gameMode = 'normal') => getWorldSize(isNGP, gameMode) / 2;

// TODO: This is currently not accurate for NG+. I wonder if it's still using the offsets for NG, just hardcoded?

// Exported (export keyword only, no behavior change) so the GL terrain shader
// can build its permutation/gradient tables from the same source instead of
// keeping a second copy — see js/gl/chunk_textures.js and js/gl/shaders.js.
export const EDGE_NOISE = [0x97, 0xa0, 0x89, 0x5b, 0x5a, 0x0f, 0x83, 0x0d, 0xc9, 0x5f, 0x60, 0x35, 0xc2, 0xe9, 0x07, 0xe1, 0x8c, 0x24, 0x67, 0x1e, 0x45, 0x8e, 0x08, 0x63, 0x25, 0xf0, 0x15, 0x0a, 0x17, 0xbe, 0x06, 0x94, 0xf7, 0x78, 0xea, 0x4b, 0x00, 0x1a, 0xc5, 0x3e, 0x5e, 0xfc, 0xdb, 0xcb, 0x75, 0x23, 0x0b, 0x20, 0x39, 0xb1, 0x21, 0x58, 0xed, 0x95, 0x38, 0x57, 0xae, 0x14, 0x7d, 0x88, 0xab, 0xa8, 0x44, 0xaf, 0x4a, 0xa5, 0x47, 0x86, 0x8b, 0x30, 0x1b, 0xa6, 0x4d, 0x92, 0x9e, 0xe7, 0x53, 0x6f, 0xe5, 0x7a, 0x3c, 0xd3, 0x85, 0xe6, 0xdc, 0x69, 0x5c, 0x29, 0x37, 0x2e, 0xf5, 0x28, 0xf4, 0x66, 0x8f, 0x36, 0x41, 0x19, 0x3f, 0xa1, 0x01, 0xd8, 0x50, 0x49, 0xd1, 0x4c, 0x84, 0xbb, 0xd0, 0x59, 0x12, 0xa9, 0xc8, 0xc4, 0x87, 0x82, 0x74, 0xbc, 0x9f, 0x56, 0xa4, 0x64, 0x6d, 0xc6, 0xad, 0xba, 0x03, 0x40, 0x34, 0xd9, 0xe2, 0xfa, 0x7c, 0x7b, 0x05, 0xca, 0x26, 0x93, 0x76, 0x7e, 0xff, 0x52, 0x55, 0xd4, 0xcf, 0xce, 0x3b, 0xe3, 0x2f, 0x10, 0x3a, 0x11, 0xb6, 0xbd, 0x1c, 0x2a, 0xdf, 0xb7, 0xaa, 0xd5, 0x77, 0xf8, 0x98, 0x02, 0x2c, 0x9a, 0xa3, 0x46, 0xdd, 0x99, 0x65, 0x9b, 0xa7, 0x2b, 0xac, 0x09, 0x81, 0x16, 0x27, 0xfd, 0x13, 0x62, 0x6c, 0x6e, 0x4f, 0x71, 0xe0, 0xe8, 0xb2, 0xb9, 0x70, 0x68, 0xda, 0xf6, 0x61, 0xe4, 0xfb, 0x22, 0xf2, 0xc1, 0xee, 0xd2, 0x90, 0x0c, 0xbf, 0xb3, 0xa2, 0xf1, 0x51, 0x33, 0x91, 0xeb, 0xf9, 0x0e, 0xef, 0x6b, 0x31, 0xc0, 0xd6, 0x1f, 0xb5, 0xc7, 0x6a, 0x9d, 0xb8, 0x54, 0xcc, 0xb0, 0x73, 0x79, 0x32, 0x2d, 0x7f, 0x04, 0x96, 0xfe, 0x8a, 0xec, 0xcd, 0x5d, 0xde, 0x72, 0x43, 0x1d, 0x18, 0x48, 0xf3, 0x8d, 0x80, 0xc3, 0x4e, 0x42, 0xd7, 0x3d, 0x9c, 0xb4];
export const EDGE_SIGNS = [1, 1, 0, 0, -1, 1, 0, 0, 1, -1, 0, 0, -1, -1, 0, 0, 1, 0, 1, 0, -1, 0, 1, 0, 1, 0, -1, 0, -1, 0, -1, 0, 0, 1, 1, 0, 0, -1, 1, 0, 0, 1, -1, 0, 0, -1, -1, 0];

const sqrt312 = (Math.sqrt(3) - 1) / 2;
const sqrt336 = (3 - Math.sqrt(3)) / 6;
//const BASE_X = 512*35; // TODO: Change for world size?
const BASE_Y = 512*14;
//const BIOME_W = 70; // TODO: Change for world size?
const BIOME_H = 48;
const EDGE_NOISE_2 = [];
const EDGE_NOISE_M12 = [];

for (let i = 0; i < 512; i++) {
	const temp = EDGE_NOISE[i & 0xff];
	EDGE_NOISE_2.push(temp);
	EDGE_NOISE_M12.push(temp % 0xc);
}
// 30 * sin(0.005 * x) or cos... + 11 * 0.05 * x
// not clear how it combines the x and y parts here though...

function Mod(a, b) {
	return ((a % b) + b) % b;
}

function SampleBiome(x, y) {
	return Mod(x, 2) * 2 + Mod(y, 2);
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
	uVar2 = dVar6 >>> 0; // Originally casting double to uint, hopefully this is the same?
	if (dVar6 < uVar2) {
		uVar2 = uVar2 - 1;
	}

	dVar7 = dVar7 + y;
	uVar1 = dVar7 >>> 0;
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

function GetOriginalChunkPosIdAt(x, y, isNGP = false, gameMode='normal') {
    const biomeW = getWorldSize(isNGP, gameMode);
    
    // The engine's internal shift logic
    const shifted_x = x + 512 * (biomeW / 2);
    const shifted_y = y + 512 * 14;

    // Use Math.floor to determine which 512x512 chunk we are in
    const chunkX = Mod(Math.floor(shifted_x / 512), biomeW);
    const chunkY = Math.floor(shifted_y / 512);

    return SampleBiome(chunkX, chunkY);
}

// TODO: Should be able to do this without the shifted position...
export function GetTrueChunkPosIdAt(x, y, isNGP = false, highDetail=true, gameMode='normal') {
	let subchunk_y;
	let subchunk_x;
	let chunk_x;
	let chunk_y;
	let shifted_y;
	//let dVar1;
	let shifted_x;
	let new_x;
	let new_y;
	//let x2;
	//let y2;
	let biome;

	shifted_x = x + 512 * getWorldCenter(isNGP, gameMode); // This becomes offset -3 in NG+ which agrees with the word center shift
	shifted_y = y + BASE_Y;
	subchunk_x = Math.floor(shifted_x) & 0x1ff;
	subchunk_y = Math.floor(shifted_y) & 0x1ff;
	new_x = 70; //getWorldSize(isNGP); // Seems like world size may be correct here? Actually might just ignore NG+
	// Actually this makes no difference anyway
	chunk_x = (Math.floor(shifted_x) >> 9) % new_x;
	chunk_y = Math.floor(shifted_y) >> 9;
	if (chunk_x < 0) {
		chunk_x = chunk_x + new_x;
	}
	// What exactly is this doing?
	new_y = BIOME_H + -1;
	if (chunk_y < new_y) {
		new_y = chunk_y;
	}
	chunk_y = 0;
	if (0 < new_y) {
		chunk_y = new_y;
	}
	biome = SampleBiome(chunk_x, chunk_y);

	// Massive simplification of the original code...
	// The entire purpose of this is to avoid having to calculate the wobbled biome if the position is in the middle of a chunk.
	if (subchunk_x < 42 || subchunk_y < 42 || subchunk_x > 470 || subchunk_y > 470) {
		return GetWobbledBiome(shifted_x, shifted_y, highDetail);
	}
	return biome;

	/*
	let offsetX = 0;
	let offsetY = 0;
	if (subchunk_x < 42) {
		offsetX = -1;
	}
	else if (subchunk_y < 42) {
		offsetY = -1;
	}
	else if (470 < subchunk_x) {
		offsetX = 1;
	}
	else if (470 < subchunk_y) {
		offsetY = 1;
	}
	else {
		return biome;
	}
	return GetWobbledBiome(biome, shifted_x, shifted_y, chunk_x + offsetX, chunk_y + offsetY);
	*/

	/*
	y2 = shifted_y;
	x2 = shifted_x;
	if (subchunk_x < 42) {
		new_x = chunk_x + -1;
		newBiome = SampleBiome(new_x, chunk_y);
		new_y = chunk_y;
		if (newBiome == biome) { // Unreachable
			// goto SampleMap;
		}
	} else {
	//SampleMap:
		if (subchunk_y < 42) {
			newBiome = SampleBiome(chunk_x, chunk_y + -1);
			new_x = chunk_x;
			new_y = chunk_y + -1;
			if (newBiome != biome) // Always true
				goto DoSinStuff;
		}
		if (470 < subchunk_x) {
			newBiome = SampleBiome(chunk_x + 1, chunk_y);
			new_x = chunk_x + 1;
			new_y = chunk_y;
			if (newBiome != biome) // Always true
				goto DoSinStuff;
		}
		if (470 < subchunk_y) {
			newBiome = SampleBiome(chunk_x, chunk_y + 1);
			new_x = chunk_x;
			new_y = chunk_y + 1;
			if (newBiome != biome) // Always true
				goto DoSinStuff;
		}
		if (subchunk_x < 42) { // Unreachable
			if (subchunk_y < 42) {
				new_x = chunk_x + -1;
				newBiome = SampleBiome(new_x, chunk_y + -1);
				new_y = chunk_y + -1;
				if (newBiome != biome) // Always true
					goto DoSinStuff;
			}
			if (470 < subchunk_y) {
				new_x = chunk_x + -1;
				newBiome = SampleBiome(new_x, chunk_y + 1);
				new_y = chunk_y + 1;
				if (newBiome != biome) // Always true
					goto DoSinStuff;
			}
		}
		if (subchunk_x < 471) // Always true
			return biome;
		if (subchunk_y < 42) { // Unreachable
			new_x = chunk_x + 1;
			newBiome = SampleBiome(new_x, chunk_y + -1);
			new_y = chunk_y + -1;
			if (newBiome != biome) // Always true
				goto DoSinStuff;
		}
		if (subchunk_y < 471) // Always true (but also unreachable lol)
			return biome;
		newBiome = SampleBiome(chunk_x + 1, chunk_y + 1);
		if (newBiome == biome) // Unreachable
			return biome;
		new_x = chunk_x + 1;
		new_y = chunk_y + 1;
		// Dear god why is it like this
	}
	return GetWobbledBiome(biome, shifted_x, shifted_y, new_x, new_y);
	*/
}

// Assuming all biomes have the sincos wobble
// Note that in the future, if any biomes have `big_noise_biome_edges == 0` on either side of the edge, they will have sincosWobble false
function GetWobbledBiome(shifted_x, shifted_y, highDetail = true, sincosWobble = true) {
	let x2 = 0;
	let y2 = 0;
	if (!sincosWobble) {
		if (highDetail)
			x2 = ComputeMagicValueFromDoubles(shifted_x * 0.05, shifted_y * 0.05);
		x2 = x2 * 2.5;
		y2 = x2;
	} else {
		if (highDetail)
			y2 = ComputeMagicValueFromDoubles(shifted_x * 0.05, shifted_y * 0.05);
		let dVar1 = Math.sin(shifted_y * 0.005);
		x2 = Math.cos(shifted_x * 0.005);
		x2 = x2 * 30.0 + y2 * 11.0;
		y2 = dVar1 * 30.0 + y2 * 11.0;
	}
	return SampleBiome(Math.floor(y2 + shifted_x) >> 9, Math.floor(x2 + shifted_y) >> 9);
}

export function GetBiomeOffset(x, y, isNGP = false, highDetail = true, gameMode='normal') {
	const originalBiomeId = GetOriginalChunkPosIdAt(x, y, isNGP, gameMode);
	const trueBiomeId = GetTrueChunkPosIdAt(x, y, isNGP, highDetail, gameMode);
	const isDiffY = Mod(trueBiomeId - originalBiomeId, 2);
	const isDiffX = Mod(Math.floor(trueBiomeId / 2) - Math.floor(originalBiomeId / 2), 2);
	const signX = Mod(x, 512) < 42 ? -1 : (Mod(x, 512) > 470 ? 1 : 0);
	const signY = Mod(y, 512) < 42 ? -1 : (Mod(y, 512) > 470 ? 1 : 0);
	return {
		x: isDiffX * signX,
		y: isDiffY * signY,
	};
}

