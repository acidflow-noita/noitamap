import { decode, encode } from "fast-png";
import type { StoredTerrain } from "./retained-terrain";
import type { EncodedTerrain } from "./retained-terrain-codec";

function dimensions(page: { width: number; height: number }) {
  if (
    !Number.isInteger(page.width) ||
    !Number.isInteger(page.height) ||
    page.width < 1 ||
    page.width > 256 ||
    page.height < 1 ||
    page.height > 256
  )
    throw new Error("Invalid retained terrain dimensions");
}

/** Pure byte encoding: no browser canvas, premultiplication, palette reduction
 * or alpha normalization. Hidden RGB bytes survive round trips too. */
export function encodeTerrainPages(pages: StoredTerrain[]): EncodedTerrain[] {
  if (
    pages.reduce((sum, page) => sum + page.pixels.byteLength, 0) >
    4 * 1024 * 1024
  )
    throw new Error("Retained terrain codec batch exceeds 4 MiB");
  return pages.map((page) => {
    dimensions(page);
    if (page.pixels.length !== page.width * page.height * 4)
      throw new Error("Invalid retained terrain pixels");
    let constant = true;
    for (let i = 4; i < page.pixels.length; i++)
      if (page.pixels[i] !== page.pixels[i & 3]) {
        constant = false;
        break;
      }
    const { pixels, ...metadata } = page;
    return {
      ...metadata,
      encoding: constant ? "constant-rgba-v1" : "png-rgba-v1",
      data: constant
        ? new Uint8Array(pixels.subarray(0, 4))
        : encode({
            data: new Uint8Array(
              pixels.buffer,
              pixels.byteOffset,
              pixels.byteLength,
            ),
            width: page.width,
            height: page.height,
            channels: 4,
          }),
    };
  });
}

export function decodeTerrainPage(page: EncodedTerrain): StoredTerrain {
  dimensions(page);
  let pixels: Uint8ClampedArray;
  if (page.encoding === "constant-rgba-v1") {
    if (page.data.length !== 4)
      throw new Error("Invalid constant retained terrain");
    pixels = new Uint8ClampedArray(page.width * page.height * 4);
    for (let i = 0; i < pixels.length; i += 4) pixels.set(page.data, i);
  } else if (page.encoding === "png-rgba-v1") {
    // Verify encoded dimensions before the PNG decoder can allocate them.
    if (page.data.length < 24) throw new Error("Invalid retained terrain PNG");
    const header = new DataView(
      page.data.buffer,
      page.data.byteOffset,
      page.data.byteLength,
    );
    if (
      header.getUint32(16) !== page.width ||
      header.getUint32(20) !== page.height
    )
      throw new Error("Retained terrain PNG dimensions changed");
    const decoded = decode(page.data);
    if (
      decoded.depth !== 8 ||
      decoded.channels !== 4 ||
      decoded.data.length !== page.width * page.height * 4
    )
      throw new Error("Invalid retained terrain RGBA PNG");
    pixels = new Uint8ClampedArray(decoded.data);
  } else throw new Error("Unknown retained terrain encoding");
  const { encoding: _encoding, data: _data, ...metadata } = page;
  return { ...metadata, pixels };
}
