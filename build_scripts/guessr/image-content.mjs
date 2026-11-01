/** Exact nonblack, nontransparent pixels, merged into lossless rectangles.
 * Private sampling metadata only; this never changes or creates an image. */
export function imageContent(data, width, height) {
  if (data.length !== width * height * 4)
    throw new Error("Image content requires native RGBA pixels.");
  const rectangles = [];
  let previous = new Map(),
    count = 0;
  for (let y = 0; y < height; y++) {
    const current = new Map();
    let start = -1;
    for (let x = 0; x <= width; x++) {
      const offset = (y * width + x) * 4;
      const visible =
        x < width &&
        data[offset + 3] > 0 &&
        (data[offset] > 0 || data[offset + 1] > 0 || data[offset + 2] > 0);
      if (visible) {
        count++;
        if (start < 0) start = x;
      } else if (start >= 0) {
        const key = start * (width + 1) + x;
        let rectangle = previous.get(key);
        if (rectangle) rectangle[3]++;
        else {
          rectangle = [start, y, x - start, 1];
          rectangles.push(rectangle);
        }
        current.set(key, rectangle);
        start = -1;
      }
    }
    previous = current;
  }
  return !count ? "empty" : count === width * height ? "full" : rectangles;
}

/** Keep detailed masks compact on disk and lazy to decode in the round service. */
export function compactImageContent(content) {
  if (!Array.isArray(content)) return content;
  const bytes = Buffer.alloc(content.length * 8);
  content.forEach((rectangle, i) =>
    rectangle.forEach((value, j) => bytes.writeUInt16LE(value, i * 8 + j * 2)),
  );
  return { rectangles: bytes.toString("base64") };
}
