// Exact batched owned edge core. See EDGE-BATCH.txt and LICENSE-telescope.txt.
import { edgeShader as baseline } from './edge-shader.mjs';

// Keep the exact owned rules in the existing single-page edge shader. These mechanical
// changes only introduce page offsets and a phase shared across independent
// pages. No translated ray lookup, spatial priority, or color rule is changed.
function once(source, before, after) {
  if (source.split(before).length !== 2) throw Error(`Unexpected baseline edge shader anchor: ${before.slice(0, 72)}`);
  return source.replace(before, after);
}
const fields = [
  ['width','u32'],['height','u32'],['origin_x','i32'],['origin_y','i32'],
  ['seed','u32'],['shift_x','i32'],['shift_y','i32'],['margin','i32'],
  ['phase','u32'],['scene_x','i32'],['scene_y','i32'],['scene_width','i32'],
  ['scene_height','i32'],['clip_x','u32'],['clip_y','u32'],['clip_width','u32'],
  ['clip_height','u32'],['updates_at','u32'],['eligible','u32'],['reserved','u32'],
];
const batchHeader = /*wgsl*/`
struct Batch { pages:u32,phase:u32,phase_at:u32,candidates:u32,pixels:u32,unused0:u32,unused1:u32,unused2:u32 }
@group(0) @binding(0) var<uniform> batch:Batch;
var<private> page:Page;
var<private> pixel_base:u32;
var<private> action_base:u32;
var<private> skip_at:u32;
fn load_page(index:u32) {
  let at=batch.phase_at+index*24u;
  ${fields.map(([name, type], i) => `page.${name}=${type === 'i32' ? `bitcast<i32>(updates[at+${i}u])` : `updates[at+${i}u]`};`).join('\n  ')}
  pixel_base=updates[at+21u];action_base=pixel_base*table[4];skip_at=updates[at+22u];
}
`;
let source = once(baseline, '@group(0) @binding(0) var<uniform> page: Page;', batchHeader);
// Material/paint destinations and descriptor storage are disjoint per page.
source = source.replace(/\bmaterial\[/g, 'material[pixel_base + ')
  .replace(/\brgba\[/g, 'rgba[pixel_base + ')
  .replace(/\bpainted\[/g, 'painted[pixel_base + ')
  .replace(/\baction\[/g, 'action[action_base + ')
  .replaceAll('winner.cells[destination]', 'winner.cells[pixel_base + destination]');
source = once(source, 'winner.cells[slot].list_destination = destination;', 'winner.cells[slot].list_destination = pixel_base + destination;');
source = once(source, 'updates[u32(cy * 4 + cx)]', 'updates[skip_at + u32(cy * 4 + cx)]');
source = once(source,
  '  if (gid.x == 0u && gid.y == 0u && page.eligible != 0u) { reset_counts(); }',
  '  if(gid.z>=batch.pages){return;}load_page(gid.z);if(page.phase!=2u){return;}');
// One global reset before each phase, rather than one reset per active scene.
const scatterStart = source.indexOf('fn scatter('), resolveStart = source.indexOf('@compute @workgroup_size(64)\nfn resolve_winners(');
if (scatterStart < 0 || resolveStart < 0) throw Error('Missing owned edge entry points');
let scatter = source.slice(scatterStart, resolveStart).replaceAll('gid.x', 'candidate');
scatter = once(scatter, 'fn scatter(@builtin(global_invocation_id) gid: vec3u) {', /*wgsl*/`fn scatter(@builtin(global_invocation_id) gid: vec3u) {
  if(gid.x>=batch.candidates){return;}
  var candidate=0u;var previous=0u;
  for(var index=0u;index<batch.pages;index++) {
    let end=updates[batch.phase_at+index*24u+20u];
    if(gid.x<end){load_page(index);candidate=gid.x-previous;break;}previous=end;
  }`);
source = source.slice(0, scatterStart) + scatter + source.slice(resolveStart);
source = once(source, '    if (page.phase == 0u) { atomicAdd(&winner.generation_touched, count); }\n    else if (page.phase == 1u) { atomicAdd(&winner.seam_touched, count); }',
  '    if (batch.phase == 0u) { atomicAdd(&winner.generation_touched, count); }\n    else if (batch.phase == 1u) { atomicAdd(&winner.seam_touched, count); }');
source = once(source, '  let destination = winner.cells[gid.x].list_destination;', /*wgsl*/`
  let global_destination=winner.cells[gid.x].list_destination;
  for(var index=0u;index<batch.pages;index++) {
    let at=batch.phase_at+index*24u;let base=updates[at+21u];
    if(global_destination>=base&&global_destination<base+updates[at]*updates[at+1u]){load_page(index);break;}
  }
  let destination=global_destination-pixel_base;`);
export const batchEdgeShader = source;

export const sceneCopyShader = /*wgsl*/`
struct Clip { source_at:u32,source_width:u32,source_x:u32,source_y:u32,width:u32,height:u32,target_at:u32,source_eligible:u32,target_eligible:u32,unused0:u32,unused1:u32,unused2:u32 }
@group(0) @binding(0) var<uniform> p:Clip;
@group(0) @binding(1) var<storage,read> source:array<u32>;
@group(0) @binding(2) var<storage,read_write> clipped:array<u32>;
@compute @workgroup_size(8,8) fn copy_scene(@builtin(global_invocation_id) gid:vec3u) {
 if(gid.x==0u&&gid.y==0u){clipped[p.target_eligible]=source[p.source_eligible];}
 if(gid.x>=p.width||gid.y>=p.height){return;}
 clipped[p.target_at+gid.y*p.width+gid.x]=source[p.source_at+(p.source_y+gid.y)*p.source_width+p.source_x+gid.x];
}
`;
