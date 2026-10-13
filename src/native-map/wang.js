// Derived from noita-telescope by Lymm (MIT); see LICENSE.
// Source: Lymm 7fce46be8a5587fa88693d468046e236f862f5c7; algorithms unchanged
// except explicit input/state ownership and removal of discarded raster output.

import { NollaPrng } from "./random.js";

export function createWangGenerator() {
  // ============================================================================
  // GLOBALS & CONFIG
  // ============================================================================
  const MAX_W = 300;
  const MAX_H = 300;

  // Grids: [Y][X] - Initialized to -1
  let c_color = new Int32Array(MAX_W * MAX_H).fill(-1);
  let v_color = new Int32Array(MAX_W * MAX_H).fill(-1);
  let h_color = new Int32Array(MAX_W * MAX_H).fill(-1);

  // Helpers
  function get_c(x, y) {
    return x < 0 || x >= MAX_W || y < 0 || y >= MAX_H
      ? -1
      : c_color[y * MAX_W + x];
  }
  function set_c(x, y, v) {
    if (x >= 0 && x < MAX_W && y >= 0 && y < MAX_H) c_color[y * MAX_W + x] = v;
  }

  //function get_h(x, y) { return (x < 0 || x >= MAX_W || y < 0 || y >= MAX_H) ? -1 : h_color[y * MAX_W + x]; }
  //function set_h(x, y, v) { if (x >= 0 && x < MAX_W && y >= 0 && y < MAX_H) h_color[y * MAX_W + x] = v; }

  //function get_v(x, y) { return (x < 0 || x >= MAX_W || y < 0 || y >= MAX_H) ? -1 : v_color[y * MAX_W + x]; }
  //function set_v(x, y, v) { if (x >= 0 && x < MAX_W && y >= 0 && y < MAX_H) v_color[y * MAX_W + x] = v; }

  let globalPrng = new NollaPrng(0);
  let stbhw_error = null;
  let repetition_reduction = true;

  function stbhw_get_last_error() {
    let e = stbhw_error;
    stbhw_error = null;
    return e;
  }
  function stbhw_set_prng(prng) {
    globalPrng = prng;
  }

  class StbhwTile {
    constructor(pixels, a, b, c, d, e, f) {
      this.pixels = pixels;
      this.a = a;
      this.b = b;
      this.c = c;
      this.d = d;
      this.e = e;
      this.f = f;
    }
  }

  class StbhwTileset {
    constructor() {
      this.is_corner = false;
      this.num_color = [0, 0, 0, 0, 0, 0];
      this.short_side_len = 0;
      this.h_tiles = [];
      this.v_tiles = [];
      this.num_h_tiles = 0;
      this.num_v_tiles = 0;
      this.num_vary_x = 0;
      this.num_vary_y = 0;
    }
  }

  // ============================================================================
  // GENERATION LOGIC
  // ============================================================================

  function STB_HBWANG_RAND() {
    let r = globalPrng.NextU();
    return r;
  }

  function stbhw_generate_image(ts, pixels, stride_in_bytes, w, h) {
    c_color.fill(-1);
    h_color.fill(-1);
    v_color.fill(-1);

    const sidelen = ts.short_side_len;
    if (sidelen <= 0) return null;

    //const orig_w = w, orig_h = h;
    // Noita appears to use a 1024px repeat for these maps. For some reason.
    w = Math.min(w, 1024);
    h = Math.min(h, 1028); // Why

    // These are the dimensions of the TILE GRID (Logic Space)
    const xmax = Math.floor(w / sidelen) + 6;
    const ymax = Math.floor(h / sidelen) + 6;

    // The tileIndices array size is based on the logic grid
    const tileIndices = new Int32Array(xmax * ymax).fill(0);
    const num_vary_product = ts.num_vary_x * ts.num_vary_y;

    if (ts.is_corner) {
      // --- PASS 1: COLOR GENERATION ---
      // Loops over the tile grid to establish the corner constraints
      for (let j = 0; j < ymax; j++) {
        for (let i = 0; i < xmax; i++) {
          let p = (i - j + 1) & 3;
          set_c(i, j, (globalPrng.NextU() >>> 0) % ts.num_color[p]);
        }
      }

      // --- PASS 2: REPETITION REDUCTION ---
      if (repetition_reduction) {
        for (let j = 0; j < ymax - 3; j++) {
          for (let i = 0; i < xmax - 3; i++) {
            if (
              stbhw__match(i, j) &&
              stbhw__match(i, j + 1) &&
              stbhw__match(i, j + 2) &&
              stbhw__match(i + 1, j) &&
              stbhw__match(i + 1, j + 1) &&
              stbhw__match(i + 1, j + 2)
            ) {
              let p = (i + 1 - (j + 1) + 1) & 3;
              if (ts.num_color[p] > 1) {
                let curr = get_c(i + 1, j + 1);
                set_c(i + 1, j + 1, stbhw__change_color(curr, ts.num_color[p]));
              }
            }
            if (
              stbhw__match(i, j) &&
              stbhw__match(i + 1, j) &&
              stbhw__match(i + 2, j) &&
              stbhw__match(i, j + 1) &&
              stbhw__match(i + 1, j + 1) &&
              stbhw__match(i + 2, j + 1)
            ) {
              let p = (i + 2 - (j + 1) + 1) & 3;
              if (ts.num_color[p] > 1) {
                let curr = get_c(i + 2, j + 1);
                set_c(i + 2, j + 1, stbhw__change_color(curr, ts.num_color[p]));
              }
            }
          }
        }
      }

      // --- PASS 3: LOGIC & DRAW ---
      let yIdx = -1; // Tracks the current vertical tile row
      let ypos = -1 * sidelen; // Tracks the pixel Y coordinate

      // We loop until yIdx reaches the end of the tiles needed for the pixel height 'h'
      for (let j = -1; yIdx * sidelen < h; j++) {
        let phase = j & 3;
        let i = phase === 0 ? 0 : phase - 4;

        for (; ; i += 4) {
          let xIdx = i;
          let xpos = xIdx * sidelen;

          // If the logic index exceeds the tiles needed for pixel width 'w', break
          if (xpos >= w) break;

          // Horizontal Tile logic
          if (xIdx + 2 >= 0 && yIdx >= 0) {
            let ti = stbhw__choose_tile_refactor2(
              ts.h_tiles,
              ts.num_h_tiles,
              [i + 2, j + 2],
              [i + 3, j + 2],
              [i + 4, j + 2],
              [i + 2, j + 3],
              [i + 3, j + 3],
              [i + 4, j + 3],
              num_vary_product,
            );

            if (ti === -1) return null;

            // Store indices with C++ flags (0x8000 for right side)
            if (xIdx >= 0) tileIndices[yIdx * xmax + xIdx] = ti;
            if (xIdx + 1 >= 0)
              tileIndices[yIdx * xmax + xIdx + 1] = ti | 0x8000;

            // Render to the pixel buffer
            stbhw__draw_h_tile(
              pixels,
              stride_in_bytes,
              w,
              h,
              xpos,
              ypos,
              ts.h_tiles[ti],
              sidelen,
            );
          }

          // Offset for the vertical tile in the herringbone pattern
          let xIdxV = i + 3;
          let xposV = xIdxV * sidelen;

          // Vertical Tile logic
          if (xposV < w) {
            let ti = stbhw__choose_tile_refactor2(
              ts.v_tiles,
              ts.num_v_tiles,
              [i + 5, j + 2],
              [i + 5, j + 3],
              [i + 5, j + 4],
              [i + 6, j + 2],
              [i + 6, j + 3],
              [i + 6, j + 4],
              num_vary_product,
            );

            if (ti === -1) return null;

            // Store indices (0x4000 = Top half, 0xC000 = Bottom half)
            if (yIdx >= 0) tileIndices[yIdx * xmax + xIdxV] = ti | 0x4000;
            if ((yIdx + 1) * sidelen < h + sidelen) {
              tileIndices[(yIdx + 1) * xmax + xIdxV] = ti | 0xc000;
            }

            // Render to the pixel buffer
            stbhw__draw_v_tile(
              pixels,
              stride_in_bytes,
              w,
              h,
              xposV,
              ypos,
              ts.v_tiles[ti],
              sidelen,
            );
          }
        }
        yIdx++;
        ypos += sidelen;
      }
    }

    return { pixels, tileIndices, xmax, ymax };
  }

  // ============================================================================
  // CHOOSERS
  // ============================================================================

  // This version did not seem to make any difference
  function stbhw__choose_tile_refactor2(
    tiles,
    num_tiles,
    a_idx,
    b_idx,
    c_idx,
    d_idx,
    e_idx,
    f_idx,
    num_vary_product,
  ) {
    let a = get_c(a_idx[0], a_idx[1]),
      b = get_c(b_idx[0], b_idx[1]);
    let c = get_c(c_idx[0], c_idx[1]),
      d = get_c(d_idx[0], d_idx[1]);
    let e = get_c(e_idx[0], e_idx[1]),
      f = get_c(f_idx[0], f_idx[1]);

    // 1. Find the FIRST matching tile and the STRIDE to the next one
    let first = -1;
    let second = -1;

    for (let i = 0; i < num_tiles; i++) {
      let h = tiles[i];
      if (
        (a < 0 || a === h.a) &&
        (b < 0 || b === h.b) &&
        (c < 0 || c === h.c) &&
        (d < 0 || d === h.d) &&
        (e < 0 || e === h.e) &&
        (f < 0 || f === h.f)
      ) {
        if (first < 0) first = i;
        else if (second < 0) {
          second = i;
          break; // We only need the first two to calculate the stride
        }
      }
    }

    if (first < 0) return null;

    // 2. Calculate the stride (difference between variant 0 and variant 1)
    let stride = second === -1 ? 0 : second - first;

    // 3. Selection logic from C++: prng.NextU() % (num_vary[0] * num_vary[1])
    let m = STB_HBWANG_RAND() % num_vary_product;
    //m = 2;
    let finalIdx = first + m * stride;
    //console.log(`Choosing tile: first=${first}, stride=${stride}, m=${m}, finalIdx=${finalIdx}`);

    let t = tiles[finalIdx];

    // Update Constraints
    set_c(a_idx[0], a_idx[1], t.a);
    set_c(b_idx[0], b_idx[1], t.b);
    set_c(c_idx[0], c_idx[1], t.c);
    set_c(d_idx[0], d_idx[1], t.d);
    set_c(e_idx[0], e_idx[1], t.e);
    set_c(f_idx[0], f_idx[1], t.f);

    return finalIdx;
    //return t;
  }

  // Corner Mode (checks c_color)
  /*
function stbhw__choose_tile_refactor(tiles, num_tiles, a_idx, b_idx, c_idx, d_idx, e_idx, f_idx) {
    let a=get_c(a_idx[0], a_idx[1]), b=get_c(b_idx[0], b_idx[1]);
    let c=get_c(c_idx[0], c_idx[1]), d=get_c(d_idx[0], d_idx[1]);
    let e=get_c(e_idx[0], e_idx[1]), f=get_c(f_idx[0], f_idx[1]);

    let n = 0;
    let variants = [];
    for(let i=0; i<num_tiles; i++) {
        let h = tiles[i];
        if ((a<0||a===h.a) && (b<0||b===h.b) && (c<0||c===h.c) && (d<0||d===h.d) && (e<0||e===h.e) && (f<0||f===h.f)) {
            variants.push(h); n++;
        }
    }
    if (n === 0) return null;
    let t = variants[STB_HBWANG_RAND() % n];

    // Update Constraints
    set_c(a_idx[0], a_idx[1], t.a);
    set_c(b_idx[0], b_idx[1], t.b);
    set_c(c_idx[0], c_idx[1], t.c);
    set_c(d_idx[0], d_idx[1], t.d);
    set_c(e_idx[0], e_idx[1], t.e);
    set_c(f_idx[0], f_idx[1], t.f);

    return t;
}
*/

  /*
// Edge Mode H (checks h_color, v_color)
function stbhw_choose_tile_h_refactor(tiles, count, a_idx, b_idx, c_idx, d_idx, e_idx, f_idx) {
    let a=get_h(a_idx[0], a_idx[1]), b=get_h(b_idx[0], b_idx[1]);
    let c=get_v(c_idx[0], c_idx[1]), d=get_v(d_idx[0], d_idx[1]);
    let e=get_h(e_idx[0], e_idx[1]), f=get_h(f_idx[0], f_idx[1]);

    let n = 0;
    let variants = [];
    for(let i=0; i<count; i++) {
        let h = tiles[i];
        if ((a<0||a===h.a) && (b<0||b===h.b) && (c<0||c===h.c) && (d<0||d===h.d) && (e<0||e===h.e) && (f<0||f===h.f)) {
            variants.push(h); n++;
        }
    }
    if (n === 0) return null;
    let t = variants[STB_HBWANG_RAND() % n];

    // Update Constraints
    set_h(a_idx[0], a_idx[1], t.a); set_h(b_idx[0], b_idx[1], t.b);
    set_v(c_idx[0], c_idx[1], t.c); set_v(d_idx[0], d_idx[1], t.d);
    set_h(e_idx[0], e_idx[1], t.e); set_h(f_idx[0], f_idx[1], t.f);
    return t;
}

// Edge Mode V (checks h_color, v_color)
function stbhw_choose_tile_v_refactor(tiles, count, a_idx, b_idx, c_idx, d_idx, e_idx, f_idx) {
    let a=get_h(a_idx[0], a_idx[1]), b=get_v(b_idx[0], b_idx[1]);
    let c=get_v(c_idx[0], c_idx[1]), d=get_v(d_idx[0], d_idx[1]);
    let e=get_v(e_idx[0], e_idx[1]), f=get_h(f_idx[0], f_idx[1]);

    let n = 0;
    let variants = [];
    for(let i=0; i<count; i++) {
        let h = tiles[i];
        if ((a<0||a===h.a) && (b<0||b===h.b) && (c<0||c===h.c) && (d<0||d===h.d) && (e<0||e===h.e) && (f<0||f===h.f)) {
            variants.push(h); n++;
        }
    }
    if (n === 0) return null;
    let t = variants[STB_HBWANG_RAND() % n];

    set_h(a_idx[0], a_idx[1], t.a); set_v(b_idx[0], b_idx[1], t.b);
    set_v(c_idx[0], c_idx[1], t.c); set_v(d_idx[0], d_idx[1], t.d);
    set_v(e_idx[0], e_idx[1], t.e); set_h(f_idx[0], f_idx[1], t.f);
    return t;
}
*/

  // ============================================================================
  // HELPERS
  // ============================================================================

  function stbhw__match(i, j) {
    // Standard STB Logic: Match current with neighbor to the right
    return get_c(i, j) === get_c(i + 1, j + 1);
  }

  function stbhw__change_color(old_color, num_options, weights) {
    if (weights) {
      // Not used in Noita.
      let total = 0;
      for (let i = 0; i < num_options; i++) {
        if (i !== old_color) total += weights[i];
      }

      let choice = STB_HBWANG_RAND() % total;
      let cumulative = 0;

      for (let k = 0; k < num_options; k++) {
        if (k === old_color) continue;
        cumulative += weights[k];
        if (choice < cumulative) return k;
      }
      return num_options - 1;
    } else {
      //console.log("Changing color");
      let offset = 1 + (STB_HBWANG_RAND() % (num_options - 1));
      return (old_color + offset) % num_options;
    }
  }

  function stbhw__draw_h_tile(out, stride, w, h, x, y, tile, sz) {
    for (let j = 0; j < sz; j++) {
      if (y + j >= 0 && y + j < h) {
        for (let i = 0; i < sz * 2; i++) {
          if (x + i >= 0 && x + i < w) {
            const srcIdx = (j * (sz * 2) + i) * 3;
            const dstIdx = (y + j) * stride + (x + i) * 3;
            out[dstIdx] = tile.pixels[srcIdx];
            out[dstIdx + 1] = tile.pixels[srcIdx + 1];
            out[dstIdx + 2] = tile.pixels[srcIdx + 2];
          }
        }
      }
    }
  }

  function stbhw__draw_v_tile(out, stride, w, h, x, y, tile, sz) {
    for (let j = 0; j < sz * 2; j++) {
      if (y + j >= 0 && y + j < h) {
        for (let i = 0; i < sz; i++) {
          if (x + i >= 0 && x + i < w) {
            const srcIdx = (j * sz + i) * 3;
            const dstIdx = (y + j) * stride + (x + i) * 3;
            out[dstIdx] = tile.pixels[srcIdx];
            out[dstIdx + 1] = tile.pixels[srcIdx + 1];
            out[dstIdx + 2] = tile.pixels[srcIdx + 2];
          }
        }
      }
    }
  }

  // Builder (Unchanged)
  function stbhw_build_tileset_from_image(
    ts,
    data,
    stride,
    w,
    h,
    override = null,
  ) {
    let header = new Uint8Array(9);
    for (let i = 0; i < 9; i++) {
      let idx = w * 3 - 1 - i;
      if (idx >= 0 && idx < data.length)
        header[i] = data[idx] ^ ((i * 55) % 256);
    }

    if (header[7] === 0xc0) {
      ts.is_corner = true;
      ts.num_color = [header[0], header[1], header[2], header[3], 0, 0];
      ts.num_vary_x = header[4];
      ts.num_vary_y = header[5];
      ts.short_side_len = header[6];
    } else {
      ts.is_corner = false;
      ts.num_color = [
        header[0],
        header[1],
        header[2],
        header[3],
        header[4],
        header[5],
      ];
      ts.num_vary_x = header[6];
      ts.num_vary_y = header[7];
      ts.short_side_len = header[8];
    }

    if (override) {
      if (override.short_side_len) ts.short_side_len = override.short_side_len;
      if (override.is_corner !== undefined) ts.is_corner = override.is_corner;
      for (let i = 0; i < 6; i++)
        if (ts.num_color[i] === 0) ts.num_color[i] = 1;
      if (ts.num_vary_x === 0) ts.num_vary_x = 1;
      if (ts.num_vary_y === 0) ts.num_vary_y = 1;
    }

    if (ts.short_side_len <= 0 || ts.short_side_len > 100) return 0;

    const p = { ts, data, stride, w, h };
    let ypos = 2;
    ts.h_tiles = [];
    ts.v_tiles = [];
    ts.num_h_tiles = 0;
    ts.num_v_tiles = 0;

    if (ts.is_corner) {
      for (let k = 0; k < ts.num_color[2]; k++)
        for (let j = 0; j < ts.num_color[1]; j++)
          for (let i = 0; i < ts.num_color[0]; i++)
            for (let q = 0; q < ts.num_vary_y; q++) {
              process_h_row(
                p,
                0,
                ypos,
                0,
                ts.num_color[1] - 1,
                0,
                ts.num_color[2] - 1,
                0,
                ts.num_color[3] - 1,
                i,
                i,
                j,
                j,
                k,
                k,
                ts.num_vary_x,
              );
              ypos += ts.short_side_len + 3;
            }
      ypos += 2;
      for (let k = 0; k < ts.num_color[3]; k++)
        for (let j = 0; j < ts.num_color[0]; j++)
          for (let i = 0; i < ts.num_color[1]; i++)
            for (let q = 0; q < ts.num_vary_x; q++) {
              process_v_row(
                p,
                0,
                ypos,
                0,
                ts.num_color[0] - 1,
                0,
                ts.num_color[3] - 1,
                0,
                ts.num_color[2] - 1,
                i,
                i,
                j,
                j,
                k,
                k,
                ts.num_vary_y,
              );
              ypos += ts.short_side_len * 2 + 3;
            }
    } else {
      for (let k = 0; k < ts.num_color[3]; k++)
        for (let j = 0; j < ts.num_color[4]; j++)
          for (let i = 0; i < ts.num_color[2]; i++)
            for (let q = 0; q < ts.num_vary_y; q++) {
              process_h_row(
                p,
                0,
                ypos,
                0,
                ts.num_color[2] - 1,
                k,
                k,
                0,
                ts.num_color[1] - 1,
                j,
                j,
                0,
                ts.num_color[0] - 1,
                i,
                i,
                ts.num_vary_x,
              );
              ypos += ts.short_side_len + 3;
            }
      ypos += 2;
      for (let k = 0; k < ts.num_color[3]; k++)
        for (let j = 0; j < ts.num_color[4]; j++)
          for (let i = 0; i < ts.num_color[5]; i++)
            for (let q = 0; q < ts.num_vary_x; q++) {
              process_v_row(
                p,
                0,
                ypos,
                0,
                ts.num_color[0] - 1,
                i,
                i,
                0,
                ts.num_color[1] - 1,
                j,
                j,
                0,
                ts.num_color[5] - 1,
                k,
                k,
                ts.num_vary_y,
              );
              ypos += ts.short_side_len * 2 + 3;
            }
    }

    // Debug validation
    //console.log(`Built tileset: ${ts.is_corner ? "CORNER" : "EDGE"} MODE, short_side_len=${ts.short_side_len}, num_color=${ts.num_color}, num_h_tiles=${ts.num_h_tiles}, num_v_tiles=${ts.num_v_tiles}, num_vary_x=${ts.num_vary_x}, num_vary_y=${ts.num_vary_y}`);

    return 1;
  }

  function process_h_row(
    p,
    xpos,
    ypos,
    a0,
    a1,
    b0,
    b1,
    c0,
    c1,
    d0,
    d1,
    e0,
    e1,
    f0,
    f1,
    variants,
  ) {
    for (let v = 0; v < variants; v++)
      for (let f = f0; f <= f1; f++)
        for (let e = e0; e <= e1; e++)
          for (let d = d0; d <= d1; d++)
            for (let c = c0; c <= c1; c++)
              for (let b = b0; b <= b1; b++)
                for (let a = a0; a <= a1; a++) {
                  parse_rect(p, xpos, ypos, a, b, c, d, e, f, false);
                  xpos += 2 * p.ts.short_side_len + 3;
                }
  }

  function process_v_row(
    p,
    xpos,
    ypos,
    a0,
    a1,
    b0,
    b1,
    c0,
    c1,
    d0,
    d1,
    e0,
    e1,
    f0,
    f1,
    variants,
  ) {
    for (let v = 0; v < variants; v++)
      for (let f = f0; f <= f1; f++)
        for (let e = e0; e <= e1; e++)
          for (let d = d0; d <= d1; d++)
            for (let c = c0; c <= c1; c++)
              for (let b = b0; b <= b1; b++)
                for (let a = a0; a <= a1; a++) {
                  parse_rect(p, xpos, ypos, a, b, c, d, e, f, true);
                  xpos += p.ts.short_side_len + 3;
                }
  }

  function parse_rect(p, xpos, ypos, a, b, c, d, e, f, isV) {
    let len_ = p.ts.short_side_len;
    let w_t = isV ? len_ : len_ * 2;
    let h_t = isV ? len_ * 2 : len_;
    let pixels = new Uint8Array(w_t * h_t * 3);
    xpos += 1;
    ypos += 1;
    for (let j = 0; j < h_t; j++) {
      for (let i = 0; i < w_t; i++) {
        let start = (ypos + j) * p.stride + (xpos + i) * 3;
        let dest = (j * w_t + i) * 3;
        if (start + 2 < p.data.length) {
          pixels[dest] = p.data[start];
          pixels[dest + 1] = p.data[start + 1];
          pixels[dest + 2] = p.data[start + 2];
        }
      }
    }
    let t = new StbhwTile(pixels, a, b, c, d, e, f);
    if (isV) {
      p.ts.v_tiles.push(t);
      p.ts.num_v_tiles++;
    } else {
      p.ts.h_tiles.push(t);
      p.ts.num_h_tiles++;
    }
  }
  return {
    stbhw_generate_image,
    stbhw_build_tileset_from_image,
    StbhwTileset,
    stbhw_set_prng,
  };
}
