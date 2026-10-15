import{bandKernelWGSL}from'./band-kernel.mjs';
import{topology0WGSL}from'./topology0-shader.mjs';
import{edgeSamplersWGSL}from'./edge-samplers.mjs';
export const materialShader=/*wgsl*/`
const STORE_DIAGNOSTICS:bool=true;
struct Page{width:u32,height:u32,x:i32,y:i32,gw:u32,gh:u32,map_width:u32,all_known:u32,x_axis:u32,y_axis:u32,band_axes:u32,count:u32,output_stride:u32,output_x:u32,output_y:u32,grid_axes:u32,cave_axes:u32,pad0:u32,pad1:u32,pad2:u32}
struct Diagnostics{count:atomic<u32>,overflow:atomic<u32>,certified:atomic<u32>,pad:u32,values:array<u32>}
@group(0)@binding(0)var<uniform>page:Page;
@group(0)@binding(1)var<storage,read>table:array<u32>;
@group(0)@binding(2)var<storage,read>coverage:array<u32>;
@group(0)@binding(3)var<storage,read>labels:array<u32>;
@group(0)@binding(4)var<storage,read>world:array<u32>;
@group(0)@binding(5)var<storage,read>axes:array<u32>;
@group(0)@binding(6)var<storage,read_write>output:array<i32>;
@group(0)@binding(7)var<storage,read_write>diagnostics:Diagnostics;
var<private>uncertain:u32;
var<private>grid:u32;
fn out_at(index:u32)->u32{return (index/page.width+page.output_y)*page.output_stride+index%page.width+page.output_x;}
fn record_class(index:u32,value:u32){if(STORE_DIAGNOSTICS){diagnostics.values[index]=value;}}
fn record_owner(index:u32,value:u32){if(STORE_DIAGNOSTICS){diagnostics.values[page.count+index]=value;}}
fn wrap(x:i32,n:u32)->u32{let m=i32(n);let r=x%m;return u32(select(r,r+m,r<0));}
fn cell(x:i32,y:i32)->u32{return u32(clamp(y,0,47))*page.map_width+wrap(x,page.map_width);}
fn biome_id(c:u32)->i32{return bitcast<i32>(world[c*4u+1u]);}
fn noisy(c:u32,host:bool)->bool{let id=biome_id(c);if(id<0){return !host;}return table[biome_at(id)+6u]!=0u;}
fn mat_at(x:i32,y:i32)->i32{let index=wrap(y,table[grid+1u])*table[grid]+wrap(x,table[grid]);let word=labels[table[grid+3u]+(index>>1u)];return i32((word>>((index&1u)*16u))&65535u);}
fn cov_at(x:i32,y:i32)->Interval{let bits=coverage[table[grid+2u]+wrap(y,table[grid+1u])*table[grid]+wrap(x,table[grid])];let magnitude=bits&0x7fffffffu;if(magnitude!=0u&&magnitude<0x00800000u){uncertain|=128u;return point(0.0);}return point(bitcast<f32>(bits));}
${bandKernelWGSL}
${topology0WGSL}
${edgeSamplersWGSL}
fn owner(wx:i32,wy:i32,ax:u32,ay:u32,host:bool)->u32{
 let sx=wx+i32(page.map_width)*256;let sy=wy+7168;let cx=sx>>9u;let cy=sy>>9u;let original=cell(cx,cy);
 if(!noisy(original,host)){return original;}
 let lx=sx&511;let ly=sy&511;if(lx>=42&&lx<=470&&ly>=42&&ly<=470){return original;}
 let color=world[original*4u];var neighbor=0xffffffffu;
 let offsets=array<vec2i,8>(vec2i(-1,0),vec2i(0,-1),vec2i(1,0),vec2i(0,1),vec2i(-1,-1),vec2i(-1,1),vec2i(1,-1),vec2i(1,1));
 let enabled=array<bool,8>((lx<42),(ly<42),(lx>470),(ly>470),(lx<42&&ly<42),(lx<42&&ly>470),(lx>470&&ly<42),(lx>470&&ly>470));
 for(var i=0u;i<8u;i++){if(enabled[i]){let n=cell(cx+offsets[i].x,cy+offsets[i].y);if(world[n*4u]!=color){neighbor=n;break;}}}
 if(neighbor==0xffffffffu||!noisy(neighbor,host)){return original;}
 let noise=mul(edge_simplex(Interval(af(ax+6u),af(ax+7u)),Interval(af(ay+6u),af(ay+7u))),point(11.0));
 let col=add(add(Interval(af(ay+8u),af(ay+9u)),noise),point(f32(sx)));
 let row=add(add(Interval(af(ax+8u),af(ax+9u)),noise),point(f32(sy)));
 let c0=i32(col.lo)>>9u;let c1=i32(col.hi)>>9u;let r0=i32(row.lo)>>9u;let r1=i32(row.hi)>>9u;
 if(c0!=c1||r0!=r1){uncertain|=8u;return original;}
 let candidate=cell(c0,r0);return select(original,candidate,noisy(candidate,host));
}
fn topology2(id:i32,x:u32,y:u32,ax:u32,ay:u32)->i32{
 let nx=bitcast<i32>(axes[ax+1u]);let ny=bitcast<i32>(axes[ay+1u]);let nominal=mat_at(nx,ny)-1;
 var scale=1.0;var threshold=0.5;var kind=0;
 if(nominal>=1&&u32(nominal)<table[1]){let p=table[0]+u32(nominal)*4u;if(table[p+3u]!=0u){scale=tf(p);threshold=tf(p+1u);kind=ti(p+2u);}}
 if(kind<0||kind>2){uncertain|=128u;return 0;}
 var coord=lookup_coord(scale,af(ax),af(ay),af(ax+2u),af(ay+2u),af(ax+3u),af(ay+3u));
 if(table[11]!=0u){
  if(table[grid+8u]!=0u){let gx=page.grid_axes+x*4u;coord[0]=sub(sub(coord[0],Interval(tf(grid+6u),tf(grid+7u))),Interval(af(gx+1u),af(gx+2u)));}
  coord[1]=sub(coord[1],Interval(tf(grid+4u),tf(grid+5u)));
 }
 if(uncertain!=0u){return 0;}var ix=0;var iy=0;var sx=point(0.0);var sy=point(0.0);var cov=point(0.0);
 if(kind==0){
  ix=floor_i(coord[0]);iy=floor_i(coord[1]);if(uncertain!=0u){return 0;}
  sx=smooth_interval(fraction(coord[0],ix));sy=smooth_interval(fraction(coord[1],iy));
  cov=lerp(lerp(cov_at(ix,iy),cov_at(ix+1,iy),sx),lerp(cov_at(ix,iy+1),cov_at(ix+1,iy+1),sx),sy);
 }else if(kind==1){cov=coverage_edge(coord[0],coord[1]);}else{cov=material_edge(coord[0],coord[1]);}
 if(uncertain!=0u){return 0;}
 if(cov.hi<threshold){return 0;}if(cov.lo<threshold){uncertain|=16u;return 0;}
 if(kind!=0){
  ix=floor_i(coord[0]);iy=floor_i(coord[1]);if(uncertain!=0u){return 0;}
  sx=smooth_interval(fraction(coord[0],ix));sy=smooth_interval(fraction(coord[1],iy));
 }
 var dx=0;var dy=0;if(sx.lo>=0.5){dx=1;}else if(sx.hi>=0.5){uncertain|=16u;return 0;}
 if(sy.lo>=0.5){dy=1;}else if(sy.hi>=0.5){uncertain|=16u;return 0;}
 let explicit_material=mat_at(ix+dx,iy+dy)-1;if(explicit_material>=1){return explicit_material;}
 let d=density(af(ax+5u),af(ay+5u),af(ax+4u),af(ay+4u),cov);if(uncertain!=0u){return 0;}
 return band_select(id,x,y,d,0);
}
fn correction(index:u32,reason:u32){
 output[out_at(index)]=-2;record_class(index,256u|reason);
 let at=atomicAdd(&diagnostics.count,1u);if(at<page.count){let base=select(0u,page.count*2u,STORE_DIAGNOSTICS);diagnostics.values[base+at]=index|(reason<<20u);}else{atomicStore(&diagnostics.overflow,1u);}
}
@compute@workgroup_size(8,8)fn generate(@builtin(global_invocation_id)gid:vec3u){
 if(gid.x>=page.width||gid.y>=page.height){return;}let index=gid.y*page.width+gid.x;let wx=page.x+i32(gid.x);let wy=page.y+i32(gid.y);uncertain=0u;
 output[out_at(index)]=-1;record_class(index,0u);record_owner(index,0xffffffffu);
 let local_y=wy-ti(12u);if(local_y< -7168||local_y>=17408){output[out_at(index)]=0;record_class(index,1u);return;}
 let gx=page.grid_axes+gid.x*4u;grid=table[9]+axes[gx]*12u;
 let ax=page.x_axis+gid.x*10u;let ay=axes[gx+3u]+gid.y*10u;let guard=owner(wx,wy,ax,ay,true);
 if(uncertain!=0u){correction(index,uncertain);return;}
 let flags=world[guard*4u+2u];if(table[grid+8u]==0u){if((flags&2048u)!=0u){output[out_at(index)]=0;record_class(index,2u);return;}
 if(((flags>>8u)&3u)==2u){record_class(index,3u);return;}}
 var owning=guard;if(page.all_known==0u){owning=owner(wx,wy,ax,ay,false);}record_owner(index,owning);
 if(uncertain!=0u){correction(index,uncertain);return;}
 let id=biome_id(owning);if(id<0){record_class(index,5u);return;}let b=biome_at(id);
 if(table[b+5u]==0u){record_class(index,6u);return;}
 let topology=table[b+4u];if(topology==0u&&table[11]==0u){
  if(table[13]==0u){correction(index,512u);return;}
  let material=topology0(id,gid.x,gid.y);if(uncertain!=0u){correction(index,uncertain);return;}output[out_at(index)]=material;if(STORE_DIAGNOSTICS){atomicAdd(&diagnostics.certified,1u);}return;
 }
 if(topology!=2u){record_class(index,7u);return;}
 if(table[11]==0u&&world[owning*4u+3u]==0u){record_class(index,4u);return;}
 let material=topology2(id,gid.x,gid.y,ax,ay);if(uncertain!=0u){correction(index,uncertain);return;}
 output[out_at(index)]=material;if(STORE_DIAGNOSTICS){atomicAdd(&diagnostics.certified,1u);}
}
`;
