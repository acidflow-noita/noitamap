// Exact scene semantics from the owned native preparer. See PROVENANCE.txt.
import { bandKernelWGSL } from '../materials/band-kernel.mjs';

export const sceneShader = /*wgsl*/`
struct Page {
 width:u32,height:u32,x:i32,y:i32,
 source_at:u32,art_at:u32,art_width:u32,art_height:u32,
 replacement_at:u32,replacement_count:u32,color_biome:i32,grid_biome:i32,
 fill_recipe:u32,target_color:u32,background_color:u32,grid_fill:u32,
 pixels_at:u32,flags_at:u32,edges_at:u32,bands_at:u32,
 x_axis:u32,y_axis:u32,band_axes:u32,count:u32,
 has_art:u32,correction_capacity:u32,scene_id:u32,has_bands:u32,
 has_eligibility:u32,eligibility_at:u32,pad2:u32,pad3:u32
}
struct Corrections { count:atomic<u32>,overflow:atomic<u32>,pad0:u32,pad1:u32,values:array<vec2u> }
@group(0) @binding(0) var<uniform> page:Page;
@group(0) @binding(1) var<storage,read> source:array<u32>;
@group(0) @binding(2) var<storage,read> recipes:array<u32>;
@group(0) @binding(3) var<storage,read> table:array<u32>;
@group(0) @binding(4) var<storage,read> axes:array<u32>;
@group(0) @binding(5) var<storage,read_write> bands:array<i32>;
@group(0) @binding(6) var<storage,read_write> corrections:Corrections;
@group(0) @binding(7) var<storage,read_write> composition:array<u32>;
@group(0) @binding(8) var<storage,read_write> edges:array<atomic<u32>>;
var<private> uncertain:u32;
var<workgroup> group_eligible:atomic<u32>;
${bandKernelWGSL}
fn rgb(c:u32)->u32 { return ((c&255u)<<16u)|(c&65280u)|((c>>16u)&255u); }
fn rgba(c:u32,a:u32)->u32 { return ((c>>16u)&255u)|(c&65280u)|((c&255u)<<16u)|(a<<24u); }
fn replaced(p:u32)->u32 {
 let original=source[page.source_at+p]; var c=rgb(original);
 for(var i=0u;i<page.replacement_count;i++) {
  let at=page.replacement_at+i*2u;if(c==source[at]) { c=source[at+1u]; }
 }
 return rgba(c,original>>24u);
}
fn gray(c:u32)->bool { let r=c&255u;return r>0u&&r==((c>>8u)&255u)&&r==((c>>16u)&255u); }
fn reject(index:u32,reason:u32) {
 let at=atomicAdd(&corrections.count,1u);
 if(at<page.correction_capacity) { corrections.values[at]=vec2u(page.bands_at+index,reason); }
 else { atomicStore(&corrections.overflow,1u); }
}
@compute @workgroup_size(8,8) fn select_bands(@builtin(global_invocation_id) gid:vec3u) {
 if(gid.x>=page.width||gid.y>=page.height) { return; }
 let index=gid.y*page.width+gid.x; let raw=replaced(index);
 if((raw>>24u)==0u||!gray(raw)) { return; }
 uncertain=0u;
 let ax=page.x_axis+gid.x*10u; let ay=page.y_axis+gid.y*10u;
 let d=density(af(ax+5u),af(ay+5u),af(ax+4u),af(ay+4u),point(1.0));
 var color=-1;var grid=-1;
 if(uncertain==0u) {
  if(page.color_biome>=0) { color=band_select(page.color_biome,gid.x,gid.y,d,-1); }
  if(page.color_biome==page.grid_biome) { grid=color; }
  else if(page.grid_biome>=0) { grid=band_select(page.grid_biome,gid.x,gid.y,d,-1); }
 }
 let at=(page.bands_at+index)*2u;
 if(uncertain!=0u) { bands[at]=-3;bands[at+1u]=-3;reject(index,uncertain); }
 else { bands[at]=color;bands[at+1u]=grid; }
}
fn wang_at(color:u32)->u32 {
 var left=0u;var right=recipes[1];
 while(left<right) { let mid=(left+right)/2u;let at=recipes[0]+mid*4u;
  if(recipes[at]<color) { left=mid+1u; } else { right=mid; }
 }
 if(left<recipes[1]) { let at=recipes[0]+left*4u;if(recipes[at]==color) { return at; } }
 return 0u;
}
fn mod_coord(v:i32,n:u32)->u32 { let r=v%i32(n);return u32(select(r,r+i32(n),r<0)); }
fn material_texel(entry:u32,x:i32,y:i32)->u32 {
 let at=recipes[4]+(entry-1u)*4u;let tx=recipes[at]+mod_coord(x,recipes[at+2u]);
 let ty=recipes[at+1u]+mod_coord(y,recipes[at+3u]);return recipes[recipes[5]+ty*recipes[6]+tx];
}
fn prepare_pixel(gid:vec3u)->bool {
 let index=gid.y*page.width+gid.x;let original=source[page.source_at+index];let raw=replaced(index);
 var pixel=raw;var edge=65534u|((original>>24u)<<24u);var erase=0u;
 if((raw>>24u)!=0u) {
  let color=rgb(raw);let is_gray=gray(raw);let wang=wang_at(color);var grid=32766;
  if(color==66u) { grid=0; }
  else if(is_gray) {
   if(page.grid_biome>=0) { grid=max(0,bands[(page.bands_at+index)*2u+1u]); }
   else { grid=i32(page.grid_fill); }
  } else if(wang!=0u) { grid=bitcast<i32>(recipes[wang+2u]); }
  edge=(u32(grid)&65535u)|((original>>24u)<<24u);
  var art=0u;var art_in_bounds=false;
  if(page.has_art!=0u&&gid.x<page.art_width&&gid.y<page.art_height) {
   art=source[page.art_at+gid.y*page.art_width+gid.x];art_in_bounds=true;
   if((art>>24u)>=128u) { edge|=65536u; }
  }
  var paint=true;var recipe=page.fill_recipe;var flat=page.target_color;var alpha=255u;var entry=0u;
  if(color==66u) { pixel=rgba(page.background_color,0u);erase=1u;paint=false; }
  else if(is_gray) {
   if(page.color_biome>=0) {
    let id=bands[(page.bands_at+index)*2u];
    if(id<0) { pixel=raw&16777215u;erase=1u;paint=false; }
    else if(u32(id)<recipes[3]) { let selected=recipes[recipes[2]+u32(id)];if(selected!=0u) { recipe=selected; } }
   }
  } else {
   if(wang!=0u) { recipe=recipes[wang+1u]; }
   else { recipe=0u;flat=color; }
  }
  if(paint) {
   if(recipe!=0u) { let at=recipes[7]+recipe*4u;entry=recipes[at];flat=select(recipes[at+1u],page.target_color,recipes[at+3u]!=0u);alpha=recipes[at+2u]; }
   if(entry>0u) {
    let texel=material_texel(entry,page.x+i32(gid.x),page.y+i32(gid.y));
    if((texel>>24u)==0u) { pixel=raw&16777215u;paint=false; }
    else { alpha=texel>>24u;pixel=(texel&16777215u)|(raw&4278190080u); }
   } else { pixel=rgba(flat,raw>>24u); }
   if(paint&&alpha<255u) { pixel=(pixel&16777215u)|(alpha<<24u);erase=1u; }
  }
  if(art_in_bounds&&(pixel>>24u)!=0u) {
   let a=art>>24u;var mixed=0u;
   for(var c=0u;c<3u;c++) { let shift=c*8u;let v=(((art>>shift)&255u)*a+((pixel>>shift)&255u)*(255u-a)+127u)/255u;mixed|=v<<shift; }
   pixel=mixed|select(pixel&4278190080u,4278190080u,a==255u);
  }
 }
 atomicStore(&edges[page.edges_at+index],edge|(erase<<17u));composition[page.pixels_at+index]=pixel;
 let material=bitcast<i32>(edge<<16u)>>16u;
 if(page.has_eligibility==0u||material<=0||(edge&65536u)!=0u) { return false; }
 if(u32(material)>=recipes[9]) { return false; }
 return recipes[recipes[8]+u32(material)]!=0u;
}
@compute @workgroup_size(8,8) fn prepare(@builtin(global_invocation_id) gid:vec3u,@builtin(local_invocation_index) local:u32) {
 if(local==0u) { atomicStore(&group_eligible,0u); }workgroupBarrier();
 if(gid.x<page.width&&gid.y<page.height) {
  if(prepare_pixel(gid)) { atomicStore(&group_eligible,1u); }
 }
 workgroupBarrier();
 if(local==0u&&page.has_eligibility!=0u&&atomicLoad(&group_eligible)!=0u) {
  atomicOr(&edges[page.eligibility_at],1u);
 }
}
@compute @workgroup_size(64) fn pack_flags(@builtin(global_invocation_id) gid:vec3u) {
 let first=gid.x*16u;if(first>=page.count) { return; }var flags=0u;
 for(var i=0u;i<16u;i++) { let p=first+i;if(p>=page.count) { break; }let e=atomicLoad(&edges[page.edges_at+p]);
  let f=select(0u,1u,(e>>24u)!=0u)|((e>>16u)&2u);flags|=f<<(i*2u);
 }composition[page.flags_at+gid.x]=flags;
}
`;

export const patchShader=/*wgsl*/`
struct Params { count:u32,pad0:u32,pad1:u32,pad2:u32 }
@group(0) @binding(0) var<uniform> p:Params;
@group(0) @binding(1) var<storage,read> patches:array<vec4i>;
@group(0) @binding(2) var<storage,read_write> bands:array<i32>;
@compute @workgroup_size(64) fn apply_patches(@builtin(global_invocation_id) gid:vec3u) {
 if(gid.x>=p.count) { return; }let v=patches[gid.x];let at=u32(v.x)*2u;bands[at]=v.y;bands[at+1u]=v.z;
}
`;
