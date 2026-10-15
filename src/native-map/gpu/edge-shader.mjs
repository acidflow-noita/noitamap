// Derived from the owned Lymm Telescope edge core (MIT).
// See FINISHING.txt and LICENSE-telescope.txt for provenance and scope.
export const edgeShader = /* wgsl */ `
struct Page {
  width: u32, height: u32, origin_x: i32, origin_y: i32,
  seed: u32, shift_x: i32, shift_y: i32, margin: i32,
  phase: u32, scene_x: i32, scene_y: i32, scene_width: i32,
  scene_height: i32, clip_x: u32, clip_y: u32, clip_width: u32,
  clip_height: u32, updates_at: u32, eligible: u32, reserved: u32,
};
struct Action { token: u32, color: u32 };
// The high bit of first marks a touched destination. Lower bits contain the
// inverted first-nonoverwrite priority; a separate word tracks last overwrite.
// list_destination shares capacity with winner cells, but is indexed by list
// position, not destination. Every field has exactly one resolved owner.
struct WinnerCell { first: atomic<u32>, last: atomic<u32>, list_destination: u32 };
struct WinnerState {
  count: atomic<u32>, total_touched: atomic<u32>, generation_touched: atomic<u32>,
  seam_touched: atomic<u32>, scene_touched: atomic<u32>, resolved_phases: atomic<u32>,
  cells: array<WinnerCell>,
};
@group(0) @binding(0) var<uniform> page: Page;
@group(0) @binding(1) var<storage, read> table: array<u32>;
@group(0) @binding(2) var<storage, read_write> material: array<i32>;
@group(0) @binding(3) var<storage, read_write> rgba: array<u32>;
@group(0) @binding(4) var<storage, read_write> painted: array<u32>;
@group(0) @binding(5) var<storage, read_write> winner: WinnerState;
@group(0) @binding(6) var<storage, read_write> action: array<Action>;
@group(0) @binding(7) var<storage, read> updates: array<u32>;
@group(0) @binding(8) var<storage, read_write> resolve_dispatch: array<atomic<u32>>;

// table header: NM, NE, NI, atlasWidth, maxEntries, materialAt, entryAt,
// imageIndicesAt, imageAt, anglesAt, sampleXAt, sampleYAt, atlasAt.
fn int_at(at: u32) -> i32 { return bitcast<i32>(table[at]); }
fn type_of(id: i32) -> i32 {
  if (id <= 0 || id >= i32(table[0])) { return -9999; }
  return int_at(table[5] + u32(id) * 3u + 2u);
}
fn entry_count(id: i32) -> u32 {
  if (id <= 0 || id >= i32(table[0])) { return 0u; }
  return table[table[5] + u32(id) * 3u + 1u];
}
fn positive_mod(a: i32, b: i32) -> i32 { return ((a % b) + b) % b; }
fn hash32(x: i32, y: i32, seed: u32, entry: u32, draw: u32) -> u32 {
  var h = (bitcast<u32>(x) * 0x27d4eb2du) ^ (bitcast<u32>(y) * 0x165667b1u) ^ (seed * 0x9e3779b1u) ^ ((entry * 8u + draw) * 0x85ebca6bu);
  h = (h ^ (h >> 16u)) * 0x85ebca6bu;
  h = (h ^ (h >> 13u)) * 0xc2b2ae35u;
  return h ^ (h >> 16u);
}
// floor((hash / 2^32) * count), with count <= 4096, using exact uint arithmetic.
fn scaled_choice(hash: u32, count: u32) -> u32 {
  let low = (hash & 65535u) * count;
  return (((hash >> 16u) * count) + (low >> 16u)) >> 16u;
}
fn normal_angle(x: u32, y: u32, id: i32, kind: i32, same_type: bool) -> i32 {
  var mask = 0u;
  for (var ray = 0u; ray < 16u; ray++) {
    var last = -1;
    for (var step = 0u; step < 4u; step++) {
      let xx = int_at(table[10] + x * 64u + ray * 4u + step);
      let yy = int_at(table[11] + y * 64u + ray * 4u + step);
      if (xx < 0 || yy < 0 || xx >= i32(page.width) || yy >= i32(page.height)) { break; }
      let index = yy * i32(page.width) + xx;
      if (index == last) { continue; }
      last = index;
      let other = material[u32(index)];
      if (other == id || (same_type && other > 0 && type_of(other) == kind)) { continue; }
      mask |= 1u << ray; break;
    }
  }
  return int_at(table[9] + mask);
}
fn cardinal(mask: array<u32, 9>, bit: u32, count: u32) -> i32 {
  if (count > 7u) { return 0; }
  if (((mask[0] >> bit) & (mask[3] >> bit) & (mask[6] >> bit) & 1u) != 0u) { return 180; }
  if (((mask[0] >> bit) & (mask[1] >> bit) & (mask[2] >> bit) & 1u) != 0u) { return 270; }
  if (((mask[6] >> bit) & (mask[7] >> bit) & (mask[8] >> bit) & 1u) != 0u) { return 90; }
  return 0;
}
fn choose_image(entry_at: u32, angle: i32, start: u32) -> i32 {
  let count = table[entry_at + 6u];
  for (var k = 0u; k < count; k++) {
    let image = table[table[7] + table[entry_at + 5u] + (start + k) % count];
    let im = table[8] + image * 7u;
    if (angle >= int_at(im + 4u) && angle < int_at(im + 5u)) { return i32(image); }
  }
  return -1;
}
struct Footprint { x: i32, y: i32, width: i32, height: i32, fixed_x: i32, fixed_y: i32, transpose: bool };
fn footprint(source: u32, token: u32) -> Footprint {
  let image = (token & 1023u) - 1u;
  let im = table[8] + image * 7u;
  let iw = int_at(im + 2u); let ih = int_at(im + 3u); let flags = table[im + 6u];
  let cx = i32(source % page.width) + i32((token >> 13u) & 1u);
  let cy = i32(source / page.width) + i32((token >> 14u) & 1u);
  if ((flags & 2u) != 0u) { return Footprint(cx, cy - ih / 2, 1, ih, positive_mod(page.origin_x + cx, iw), -1, false); }
  if ((flags & 4u) != 0u) { return Footprint(cx - iw / 2, cy, iw, 1, -1, positive_mod(page.origin_y + cy, ih), false); }
  if ((token & 4096u) != 0u) { return Footprint(cx - ih / 2, cy - iw / 2, ih, iw, -1, -1, true); }
  return Footprint(cx - iw / 2, cy - ih / 2, iw, ih, -1, -1, false);
}
fn texel(token: u32, f: Footprint, x: i32, y: i32) -> u32 {
  let im = table[8] + ((token & 1023u) - 1u) * 7u;
  var sx = x - f.x; var sy = y - f.y;
  if (f.transpose) { sx = y - f.y; sy = x - f.x; }
  else {
    if (f.fixed_x >= 0) { sx = f.fixed_x; }
    if (f.fixed_y >= 0) { sy = f.fixed_y; }
  }
  if ((token & 1024u) != 0u) { sx = int_at(im + 2u) - 1 - sx; }
  if ((token & 2048u) != 0u) { sy = int_at(im + 3u) - 1 - sy; }
  return table[table[12] + (table[im + 1u] + u32(sy)) * table[3] + table[im] + u32(sx)];
}
fn publish(destination: u32, priority: u32, overwrite: bool) {
  var previous = 0u;
  if (overwrite) {
    atomicMax(&winner.cells[destination].last, priority);
    previous = atomicOr(&winner.cells[destination].first, 0x80000000u);
  } else {
    if (painted[destination] != 0u) { return; }
    previous = atomicMax(&winner.cells[destination].first, 0x80000000u | (0x7fffffffu - priority));
  }
  if (previous == 0u) {
    let slot = atomicAdd(&winner.count, 1u);
    winner.cells[slot].list_destination = destination;
    // One count update per destination; no CPU readback or scan is needed to
    // launch just enough resolve invocations after scatter finishes.
    atomicMax(&resolve_dispatch[0], (slot + 64u) / 64u);
  }
}
fn mutate_scene(x: u32, y: u32, index: u32) {
  if (x < page.clip_x || y < page.clip_y || x >= page.clip_x + page.clip_width || y >= page.clip_y + page.clip_height) { return; }
  let word = updates[page.updates_at + (y - page.clip_y) * page.clip_width + x - page.clip_x];
  let id = bitcast<i32>(word << 16u) >> 16u;
  if (id == -2) { return; }
  material[index] = id; rgba[index] = 0u;
  painted[index] = select(0u, 1u, id > 0 && (word & 65536u) != 0u);
}
fn reset_counts() {
  atomicStore(&winner.count, 0u);
  atomicStore(&resolve_dispatch[0], 0u);
  atomicStore(&resolve_dispatch[1], 1u);
  atomicStore(&resolve_dispatch[2], 1u);
}
@compute @workgroup_size(1)
fn prepare_phase() {
  // Newly allocated RGBA, painted and winner buffers are initialized to zero
  // once by WebGPU. Resolve resets touched winner pairs after every phase.
  reset_counts();
}
@compute @workgroup_size(8, 8)
fn mutate_only(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x == 0u && gid.y == 0u && page.eligible != 0u) { reset_counts(); }
  if (gid.x >= page.clip_width || gid.y >= page.clip_height) { return; }
  let x = page.clip_x + gid.x; let y = page.clip_y + gid.y;
  mutate_scene(x, y, y * page.width + x);
}
@compute @workgroup_size(64)
fn scatter(@builtin(global_invocation_id) gid: vec3u) {
  // Eligibility is computed over the complete scene, before this page clips
  // its material grid. A scene with no exposed edge material emits no stamps.
  if (page.phase == 2u && (page.eligible == 0u || (page.eligible == 2u && updates[page.reserved] == 0u))) { return; }
  let end_x = max(page.margin, i32(page.width) - page.margin);
  let end_y = max(page.margin, i32(page.height) - page.margin);
  var x = 0; var y = 0;
  if (page.phase == 1u) {
    // Disjoint full-width horizontal seam bands, then vertical seam bands
    // excluding those rows. Each source is dispatched once, in compact space.
    let records = updates[page.reserved];
    var start = 0u; var found = false;
    for (var rectangle = 0u; rectangle < records; rectangle++) {
      let at = page.reserved + 1u + rectangle * 5u;
      let end = updates[at + 4u];
      if (gid.x < end) {
        let local = gid.x - start; let width = updates[at + 2u];
        x = i32(updates[at] + local % width);
        y = i32(updates[at + 1u] + local / width);
        found = true; break;
      }
      start = end;
    }
    if (!found) { return; }
  } else {
    var left = page.margin; var top = page.margin;
    var right = end_x; var bottom = end_y;
    if (page.phase == 2u) {
      left = max(left, page.scene_x + 1); top = max(top, page.scene_y + 1);
      right = min(right, page.scene_x + page.scene_width - 1);
      bottom = min(bottom, page.scene_y + page.scene_height - 1);
    }
    let width = u32(max(0, right - left)); let height = u32(max(0, bottom - top));
    if (gid.x >= width * height) { return; }
    x = left + i32(gid.x % width); y = top + i32(gid.x / width);
  }
  if (x < page.margin || y < page.margin || x >= end_x || y >= end_y) { return; }
  let lx = (page.origin_x + x + page.shift_x) & 511;
  let ly = (page.origin_y + y + page.shift_y) & 511;
  let is_seam = lx < 8 || lx >= 504 || ly < 8 || ly >= 504;
  if (page.phase == 0u && is_seam) { return; }
  if (page.phase == 1u) {
    if (!is_seam) { return; }
    let cx = ((page.origin_x + x + page.shift_x) >> 9u) - ((page.origin_x + page.shift_x) >> 9u);
    let cy = ((page.origin_y + y + page.shift_y) >> 9u) - ((page.origin_y + page.shift_y) >> 9u);
    if (updates[u32(cy * 4 + cx)] != 0u) { return; }
  }
  if (page.phase == 2u) {
    if (page.eligible == 0u || x < page.scene_x + 1 || y < page.scene_y + 1 || x >= page.scene_x + page.scene_width - 1 || y >= page.scene_y + page.scene_height - 1) { return; }
  }
  let source = u32(y) * page.width + u32(x); let id = material[source];
  let count = entry_count(id); if (count == 0u) { return; }
  let kind = type_of(id); var mask: array<u32, 9>; var same_material = 0u; var same_type = 0u;
  for (var dy = -1; dy <= 1; dy++) { for (var dx = -1; dx <= 1; dx++) {
    let other = material[u32((y + dy) * i32(page.width) + x + dx)]; let k = u32((dy + 1) * 3 + dx + 1);
    if (other == id) { same_material++; same_type++; mask[k] = 3u; }
    else if (other > 0 && type_of(other) == kind) { same_type++; mask[k] = 1u; }
    else { mask[k] = 0u; }
  }}
  if (same_material >= 8u) { return; }
  let first = table[table[5] + u32(id) * 3u];
  let wx = page.origin_x + x; let wy = page.origin_y + y;
  let seed = select(page.seed, page.seed ^ 0x53434e45u, page.phase == 2u);
  for (var e = 0u; e < count; e++) {
    let at = table[6] + (first + e) * 9u;
    let mode = table[at]; let overwrite = table[at + 1u] != 0u;
    let require_material = table[at + 2u] != 0u; let require_type = table[at + 3u] != 0u;
    if (table[at + 8u] != 0u || hash32(wx, wy, seed, e, 0u) > table[at + 7u]) { continue; }
    if (mode != 3u && (require_material || require_type)) {
      let bit = select(0u, 1u, require_material);
      let sum = ((mask[1] >> bit) & 1u) + ((mask[3] >> bit) & 1u) + ((mask[5] >> bit) & 1u) + ((mask[7] >> bit) & 1u);
      if (sum != 2u && sum != 3u) { continue; }
    }
    let priority = source * table[4] + e + 1u;
    if (mode == 0u) {
      let color = table[at + 4u]; if ((color >> 24u) == 0u) { continue; }
      let word = (color & 0xff000000u) | ((color >> 16u) & 255u) | (color & 0xff00u) | ((color & 255u) << 16u);
      action[priority - 1u] = Action(32768u, word); publish(source, priority, overwrite); continue;
    }
    var image = -1; var angle = 0;
    if (mode == 1u) {
      let n = table[at + 6u]; image = i32(table[table[7] + table[at + 5u] + min(n - 1u, scaled_choice(hash32(wx, wy, seed, e, 1u), n))]);
    } else if (mode == 2u || mode == 3u) {
      if (mode == 3u) { angle = normal_angle(u32(x), u32(y), id, kind, require_type); }
      else if (require_material) { angle = cardinal(mask, 1u, same_material); }
      else { angle = cardinal(mask, 0u, same_type); }
      if (angle < 0) { continue; }
      image = choose_image(at, angle, hash32(wx, wy, seed, e, 1u) % table[at + 6u]);
      if (image < 0) { continue; }
    } else { continue; }
    let flags = table[table[8] + u32(image) * 7u + 6u]; var token = u32(image) + 1u;
    if (mode != 1u && (flags & 6u) != 0u) {
      if (angle >= 135 && angle < 225) { token |= 8192u; }
      else if (angle >= 225 && angle < 315) { token |= 16384u; }
    }
    if ((flags & 1u) != 0u) {
      if (hash32(wx, wy, seed, e, 2u) > 0x80000000u) { token |= 1024u; }
      if (hash32(wx, wy, seed, e, 3u) > 0x80000000u) { token |= 2048u; }
      if (hash32(wx, wy, seed, e, 4u) > 0x80000000u) { token |= 4096u; }
    }
    action[priority - 1u] = Action(token, 0u);
    let f = footprint(source, token); var left = max(0, f.x); var top = max(0, f.y);
    var right = min(i32(page.width) - 1, f.x + f.width - 1); var bottom = min(i32(page.height) - 1, f.y + f.height - 1);
    if (page.phase == 0u) { left = max(left, x - lx); right = min(right, x - lx + 511); top = max(top, y - ly); bottom = min(bottom, y - ly + 511); }
    for (var yy = top; yy <= bottom; yy++) { for (var xx = left; xx <= right; xx++) {
      let destination = u32(yy) * page.width + u32(xx);
      if (material[destination] != id || (!overwrite && painted[destination] != 0u)) { continue; }
      // RGB under alpha zero is still a nonzero atlas word and consumes paint.
      if (texel(token, f, xx, yy) != 0u) { publish(destination, priority, overwrite); }
    }}
  }
}
@compute @workgroup_size(64)
fn resolve_winners(@builtin(global_invocation_id) gid: vec3u) {
  let count = atomicLoad(&winner.count);
  if (gid.x >= count) { return; }
  if (gid.x == 0u) {
    atomicAdd(&winner.total_touched, count);
    atomicAdd(&winner.resolved_phases, 1u);
    if (page.phase == 0u) { atomicAdd(&winner.generation_touched, count); }
    else if (page.phase == 1u) { atomicAdd(&winner.seam_touched, count); }
    else { atomicAdd(&winner.scene_touched, count); }
  }
  let destination = winner.cells[gid.x].list_destination;
  var priority = atomicLoad(&winner.cells[destination].last);
  if (priority == 0u) { priority = 0x7fffffffu - (atomicLoad(&winner.cells[destination].first) & 0x7fffffffu); }
  let item = action[priority - 1u]; var word = item.color;
  if ((item.token & 32768u) == 0u) {
    let source = (priority - 1u) / table[4]; let f = footprint(source, item.token);
    word = texel(item.token, f, i32(destination % page.width), i32(destination / page.width));
  }
  rgba[destination] = word; painted[destination] = 1u;
  atomicStore(&winner.cells[destination].first, 0u);
  atomicStore(&winner.cells[destination].last, 0u);
}
`;
