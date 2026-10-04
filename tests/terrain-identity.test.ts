import { expect, it } from 'vitest';
import { retainedTerrainIdentity } from '../src/telescope/retained-terrain';
import { TERRAIN_VERSION } from '../src/telescope/terrain-policy';

const prefix = `${TERRAIN_VERSION}/retained-hd-v1-9c58775`;
function generation(buffer: ArrayBufferView): any {
  return { seed: 42, isNGP: false, gameMode: 'normal',
    tileLayers: [{ biomeName: 'coalmine', correctedX: -510, correctedY: 510, w: 512, h: 512, buffer }],
    biomeData: { pixels: new Uint8Array([1, 239, 205, 171]) } };
}

// Golden identities from the original byte-at-a-time implementation. These
// protect compatibility with already stored native terrain, not timing/JIT behavior.
const zeroVectors: Array<[number, string]> = [
  [0, "7c36f384-802559a"],
  [1, "d62c49fc-86ae7da"],
  [2, "4eab24-1630431a"],
  [3, "3482f65c-dbca655a"],
  [4, "df5531c4-54ea8e9a"],
  [5, "f313a8bc-f25a40da"],
  [7, "2cbec11c-fef3fe5a"],
  [8, "6383d304-dd47479a"],
  [9, "1a4ae47c-864e19da"],
  [15, "422279c-faf4b05a"],
  [16, "2633a484-595e399a"],
  [17, "6ef6ecfc-85434bda"],
  [255, "b1abac9c-a03b8c5a"],
  [256, "55b00384-a780959a"],
  [257, "2fc079fc-97b127da"],
  [4097, "d96f49fc-bccee7da"],
];
it.each(zeroVectors)('preserves the stored key for %i zero bytes at every byte alignment', (length, hash) => {
  for (let offset = 0; offset < 8; offset++) {
    const storage = new Uint8Array(length + 16).fill(0xa5);
    storage.fill(0, offset, offset + length);
    for (const view of [storage.subarray(offset, offset + length), new DataView(storage.buffer, offset, length)]) {
      expect(retainedTerrainIdentity(generation(view), [])).toBe(`${prefix}/42/${hash}`);
    }
  }
});

it('preserves mixed-byte order, zero runs and partial final words', () => {
  const bytes = Uint8Array.from({ length: 259 }, (_, i) => (i * 151 + 73) & 255);
  bytes.fill(0, 4, 20); bytes.fill(0, 127, 191);
  expect(retainedTerrainIdentity(generation(bytes), [])).toBe(`${prefix}/42/52c6266-6b313ce4`);
  for (const offset of [1, 2, 3, 4, 7]) {
    const storage = new Uint8Array(bytes.length + 16).fill(255);
    storage.set(bytes, offset);
    expect(retainedTerrainIdentity(generation(new DataView(storage.buffer, offset, bytes.length)), []))
      .toBe(`${prefix}/42/52c6266-6b313ce4`);
  }
});

function richFixture() {
  const storage = Uint8Array.from({ length: 600 }, (_, i) => (i * 29 + 203) & 255);
  const gen = generation(new Uint16Array(storage.buffer, 4, 128));
  Object.assign(gen, { seed: 4294967295, ngPlus: 4, isNGP: true, gameMode: 'nightmare' });
  Object.assign(gen.tileLayers[0], { biomeName: '雪/Ö✨', minX: -3, minY: 17, chunkBasePos: { x: -7, y: 9 },
    width: 23, height: 54, mapH: 48, validChunks: new Set(['3,2', '-2,1', '0,0']) });
  gen.tileLayers.push({ biomeName: 'fill', isFill: true });
  gen.biomeData.heavenPixels = new Uint32Array(storage.buffer, 260, 8);
  gen.biomeData.hellPixels = new DataView(storage.buffer, 300, 19);
  const bits = storage.subarray(321, 350), airBits = storage.subarray(501, 538);
  const masks = [{ x: -35840, y: -31744, width: 17, height: 13, bits, airBits },
    { x: 35840, y: 20116, width: 17, height: 13, bits, airBits }];
  return { gen, masks, storage };
}

it('preserves UTF-8 metadata, typed views, planes, sorted chunk claims and repeated masks', () => {
  const { gen, masks } = richFixture();
  const expected = `${prefix}/4294967295/6be0b615-800a8155`;
  expect(retainedTerrainIdentity(gen, masks)).toBe(expected);
  gen.tileLayers[0].validChunks = new Set(['0,0', '-2,1', '3,2']);
  expect(retainedTerrainIdentity(gen, masks)).toBe(expected);
  gen.ngPlus++;
  expect(retainedTerrainIdentity(gen, masks)).not.toBe(expected);
});

it('reads current geometry and force-air bytes while ignoring bytes outside each view', () => {
  const { gen, masks, storage } = richFixture();
  const expected = retainedTerrainIdentity(gen, masks);
  storage[0] ^= 255; storage[599] ^= 255;
  expect(retainedTerrainIdentity(gen, masks)).toBe(expected);
  for (const index of [20, 270, 308, 340, 512]) {
    storage[index] ^= 255;
    expect(retainedTerrainIdentity(gen, masks)).not.toBe(expected);
    storage[index] ^= 255;
    expect(retainedTerrainIdentity(gen, masks)).toBe(expected);
  }
  masks[1].x++;
  expect(retainedTerrainIdentity(gen, masks)).not.toBe(expected);
});
