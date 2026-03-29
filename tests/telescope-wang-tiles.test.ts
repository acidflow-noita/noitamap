import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const WANG_TILES_DIR = path.resolve(__dirname, '../lib/noita-telescope/data/wang_tiles');
const DOM_SHIM_PATH = path.resolve(__dirname, '../src/telescope/telescope-dom-shim.ts');

/**
 * Minimal PNG decoder that extracts raw RGBA pixel data.
 * Only handles the subset of PNG features used by wang tile images
 * (8-bit RGBA/RGB, non-interlaced).
 */
function decodePngPixels(filePath: string): { width: number; height: number; data: Uint8Array } | null {
  try {
    const buf = fs.readFileSync(filePath);

    // Verify PNG signature
    const signature = [137, 80, 78, 71, 13, 10, 26, 10];
    for (let i = 0; i < 8; i++) {
      if (buf[i] !== signature[i]) return null;
    }

    // Parse IHDR chunk
    let offset = 8;
    const ihdrLength = buf.readUInt32BE(offset);
    const ihdrType = buf.toString('ascii', offset + 4, offset + 8);
    if (ihdrType !== 'IHDR') return null;

    const width = buf.readUInt32BE(offset + 8);
    const height = buf.readUInt32BE(offset + 12);
    const bitDepth = buf[offset + 16];
    const colorType = buf[offset + 17];

    // We only handle 8-bit depth and color types 2 (RGB) or 6 (RGBA)
    if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
      // Fall back to just reporting that this PNG exists but can't be decoded
      return null;
    }

    const channels = colorType === 6 ? 4 : 3;

    // Collect all IDAT chunks
    offset = 8;
    const idatChunks: Buffer[] = [];
    while (offset < buf.length) {
      const chunkLen = buf.readUInt32BE(offset);
      const chunkType = buf.toString('ascii', offset + 4, offset + 8);
      if (chunkType === 'IDAT') {
        idatChunks.push(buf.subarray(offset + 8, offset + 8 + chunkLen));
      }
      offset += 12 + chunkLen; // 4 len + 4 type + data + 4 crc
    }

    if (idatChunks.length === 0) return null;

    // Decompress
    const { inflateSync } = require('zlib');
    const compressed = Buffer.concat(idatChunks);
    let decompressed: Buffer;
    try {
      decompressed = inflateSync(compressed);
    } catch {
      return null;
    }

    // Unfilter (each row has a filter byte prefix)
    const rowBytes = width * channels;
    const outData = new Uint8Array(width * height * 4);

    let prevRow = new Uint8Array(rowBytes);
    let srcOffset = 0;

    for (let y = 0; y < height; y++) {
      const filterType = decompressed[srcOffset++];
      const row = new Uint8Array(rowBytes);

      for (let x = 0; x < rowBytes; x++) {
        const raw = decompressed[srcOffset++];
        const a = x >= channels ? row[x - channels] : 0;
        const b = prevRow[x];
        const c = x >= channels ? prevRow[x - channels] : 0;

        switch (filterType) {
          case 0: row[x] = raw; break; // None
          case 1: row[x] = (raw + a) & 0xff; break; // Sub
          case 2: row[x] = (raw + b) & 0xff; break; // Up
          case 3: row[x] = (raw + Math.floor((a + b) / 2)) & 0xff; break; // Average
          case 4: { // Paeth
            const p = a + b - c;
            const pa = Math.abs(p - a);
            const pb = Math.abs(p - b);
            const pc = Math.abs(p - c);
            const pr = (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
            row[x] = (raw + pr) & 0xff;
            break;
          }
          default: row[x] = raw; break;
        }
      }

      // Write to output as RGBA
      for (let x = 0; x < width; x++) {
        const outIdx = (y * width + x) * 4;
        const srcIdx = x * channels;
        outData[outIdx] = row[srcIdx];         // R
        outData[outIdx + 1] = row[srcIdx + 1]; // G
        outData[outIdx + 2] = row[srcIdx + 2]; // B
        outData[outIdx + 3] = channels === 4 ? row[srcIdx + 3] : 255; // A
      }

      prevRow = row;
    }

    return { width, height, data: outData };
  } catch {
    return null;
  }
}

/**
 * Check if a pixel is a "spawn pixel" — colored (non-gray, non-black)
 * that would be visible on the map when clearSpawnPixels is false.
 */
function isSpawnPixel(r: number, g: number, b: number, a: number): boolean {
  // Transparent pixels are not spawn pixels
  if (a === 0) return false;
  // Black pixels (0,0,0) are not spawn pixels
  if (r === 0 && g === 0 && b === 0) return false;
  // Gray pixels (r===g===b) are NOT spawn pixels — they are terrain material indicators
  if (r === g && g === b) return false;
  // Everything else is a colored spawn pixel
  return true;
}

describe('Wang Tile Spawn Pixel Analysis', () => {
  const wangTilePngs: string[] = [];

  // Collect all PNG files from the wang_tiles directory (top level only, skip subdirs for speed)
  if (fs.existsSync(WANG_TILES_DIR)) {
    const entries = fs.readdirSync(WANG_TILES_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.png')) {
        wangTilePngs.push(path.join(WANG_TILES_DIR, entry.name));
      }
    }
  }

  it('should find wang tile PNG files', () => {
    expect(wangTilePngs.length, 'No wang tile PNGs found — telescope submodule may not be initialized').toBeGreaterThan(0);
  });

  it('should report spawn pixel counts per wang tile (informational)', () => {
    const report: { file: string; total: number; spawnPixels: number }[] = [];

    for (const filePath of wangTilePngs) {
      const decoded = decodePngPixels(filePath);
      if (!decoded) continue;

      let spawnCount = 0;
      const totalPixels = decoded.width * decoded.height;

      for (let i = 0; i < totalPixels; i++) {
        const idx = i * 4;
        if (isSpawnPixel(decoded.data[idx], decoded.data[idx + 1], decoded.data[idx + 2], decoded.data[idx + 3])) {
          spawnCount++;
        }
      }

      if (spawnCount > 0) {
        report.push({
          file: path.basename(filePath),
          total: totalPixels,
          spawnPixels: spawnCount,
        });
      }
    }

    if (report.length > 0) {
      console.log('\nWang tiles with spawn pixels:');
      for (const r of report) {
        const pct = ((r.spawnPixels / r.total) * 100).toFixed(2);
        console.log(`   ${r.file}: ${r.spawnPixels} spawn pixels (${pct}% of ${r.total})`);
      }
    } else {
      console.log('\n✅ No spawn pixels detected in wang tiles (they may have been cleaned)');
    }

    // This test always passes — it's informational
    expect(true).toBe(true);
  });

  it('should have clearSpawnPixels=true so spawn pixels are hidden at runtime', () => {
    const shimContent = fs.readFileSync(DOM_SHIM_PATH, 'utf8');

    // Verify the DEFAULTS object has clearSpawnPixels: true
    const match = shimContent.match(/clearSpawnPixels:\s*(true|false)/);
    expect(match, 'Could not find clearSpawnPixels default in DOM shim').not.toBeNull();
    expect(match![1], 'clearSpawnPixels must default to true to hide spawn pixels').toBe('true');
  });
});
