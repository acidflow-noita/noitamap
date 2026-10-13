// Derived from noita-telescope by Lymm (MIT); see LICENSE.
// Source: Lymm 7fce46be8a5587fa88693d468046e236f862f5c7; algorithms unchanged
// except explicit input/state ownership and removal of discarded raster output.

import { getWorldCenter } from "./coordinates.js";

//let global_extra_rerolls = 0; // Seed 3 requires 10 rerolls, even though it seems like there is a valid path much earlier??

// World x range of the corridor the main path starts in.
const PATH_FIND_WORLD_POS_MIN_X = 159;
const PATH_FIND_WORLD_POS_MAX_X = 223;

// Biomes built from the mines template start at a fixed tile instead, wherever
// their region happens to sit.
const MINES_TEMPLATE = "coalmine.png";
const MINES_START_X = 142;
const MINES_START_LEN = 12;

export function usesMinesTemplate(wangFile) {
  return !!wangFile && wangFile.endsWith(MINES_TEMPLATE);
}

// The connection the path has to start from, or null when the region doesn't
// reach the corridor and the openings in the top row are used instead.
export function getPathStartSegment(
  bbox,
  width,
  height,
  wangFile,
  isNGPlus,
  gameMode = "normal",
) {
  if (usesMinesTemplate(wangFile))
    return { x: MINES_START_X, len: MINES_START_LEN };

  const segLen = Math.trunc(
    (PATH_FIND_WORLD_POS_MAX_X - PATH_FIND_WORLD_POS_MIN_X) / 10,
  );
  const regionX = (bbox[0] - getWorldCenter(isNGPlus, gameMode)) * 512;
  const startX = Math.trunc((PATH_FIND_WORLD_POS_MIN_X - regionX) / 10);
  if (startX < 0 || startX >= width) return null;
  if (startX + segLen < 0 || startX + segLen >= width) return null;
  if (height < 7) return null;
  return { x: startX, len: Math.trunc(segLen / 10) };
}

// Tiles a path may run through.
function isOpen(pixels, idx) {
  const color = (pixels[idx] << 16) | (pixels[idx + 1] << 8) | pixels[idx + 2];
  return color === 0x000000 || color === 0xc0ffee;
}

// Maximal runs of open tiles along a row, as {x, len}.
function findSequences(pixels, width, rowY, stride) {
  const seqs = [];
  let start = null;
  const rowOffset = rowY * width;

  for (let x = 0; x < width; x++) {
    if (isOpen(pixels, (rowOffset + x) * stride)) {
      if (start === null) start = x;
    } else {
      if (start !== null) {
        seqs.push({ x: start, len: x - start });
        start = null;
      }
    }
  }
  if (start !== null) seqs.push({ x: start, len: width - start });
  return seqs;
}

function midpoint(seq) {
  return seq.x + Math.trunc(seq.len / 2);
}

export function findMinPath(pixels, width, height, startSegment) {
  const stride = 3;
  let startY = 4;
  let topSequences = [];

  // Forced start, whether or not that tile ended up open.
  topSequences = startSegment
    ? [startSegment]
    : findSequences(pixels, width, startY, stride);
  if (topSequences.length === 0) return null;

  const bottomSequences = findSequences(pixels, width, height - 1, stride);
  if (bottomSequences.length === 0) return null;

  const directions = [
    [0, 1],
    [-1, 0],
    [1, 0],
    [0, -1],
  ];

  for (const startSeq of topSequences) {
    const startX = midpoint(startSeq);
    if (startX < 0 || startX >= width) continue;

    const visited = new Uint8Array(width * height);
    const parents = new Int32Array(width * height).fill(-1);

    const queue = [];
    queue.push({ x: startX, y: startY });

    visited[startY * width + startX] = 1;
    parents[startY * width + startX] = -2;

    let maxY = startY;

    while (queue.length > 0) {
      const curr = queue.shift();
      if (curr.y > maxY) maxY = curr.y;

      for (const [dx, dy] of directions) {
        const nx = curr.x + dx;
        const ny = curr.y + dy;

        if (nx >= 0 && nx < width && ny > 3 && ny < height) {
          const nIdx = ny * width + nx;
          if (visited[nIdx] === 0 && isOpen(pixels, nIdx * stride)) {
            visited[nIdx] = 1;
            parents[nIdx] = curr.y * width + curr.x;
            queue.push({ x: nx, y: ny });
          }
        }
      }
    }

    // The path only counts if it reached an opening in the bottom row.
    if (maxY < height - 1) continue;
    let endIdx = -1;
    for (const endSeq of bottomSequences) {
      const endX = midpoint(endSeq);
      if (
        endX >= 0 &&
        endX < width &&
        visited[(height - 1) * width + endX] === 1
      ) {
        endIdx = (height - 1) * width + endX;
        break;
      }
    }
    if (endIdx === -1) continue;

    const path = [];
    let currIdx = endIdx;
    while (currIdx !== -2 && currIdx !== -1) {
      const py = Math.floor(currIdx / width);
      const px = currIdx % width;
      path.push({ x: px, y: py });

      const pIdx = parents[currIdx];
      if (pIdx === -2) break;
      currIdx = pIdx;
    }
    return path.reverse();
  }
  return null;
}
