const word=new ArrayBuffer(4),f=new Float32Array(word),u=new Uint32Array(word);
const c=x=>{f[0]=x;return `bitcast<f32>(${u[0]}u)`;};
export const topology0WGSL=/*wgsl*/`
fn cave_config(id:i32)->u32{return table[table[13]]+u32(id)*36u;}
fn cave_value(config:u32,field:u32)->Interval{let p=config+12u+field*2u;return Interval(tf(p),tf(p+1u));}
fn cave_surface(id:i32,x:u32)->array<Interval,2>{
 let s=table[cave_config(id)];if(table[table[table[13]+7u]+s]==2u){uncertain|=512u;return array<Interval,2>(point(0.0),point(0.0));}
 let at=axes[page.cave_axes+1u]+(s*page.width+x)*4u;
 return array<Interval,2>(Interval(af(at),af(at+1u)),Interval(af(at+2u),af(at+3u)));
}
fn cave_depth(id:i32,x:u32,y:u32)->Interval{
 let wx=page.x+i32(x);let wy=f32(page.y+i32(y))+0.5;let sx=wx+i32(page.map_width)*256;let cx=sx>>9u;let cy=(page.y+i32(y)+7168)>>9u;
 let physical=biome_id(cell(cx,cy));let left=biome_id(cell(cx-1,cy));var chosen=id;if(wy<=380.0&&physical>=0){chosen=physical;}
 var surface=cave_surface(chosen,x);if(uncertain!=0u){return point(0.0);}
 if(wy<=380.0&&left>=0&&(sx&511)<42){
  let l=cave_surface(left,x);let blend=point(af(axes[page.cave_axes+2u]+x*6u+5u));surface[0]=lerp(surface[0],l[0],blend);surface[1]=lerp(surface[1],l[1],blend);
 }
 if(wy<=surface[0].lo){return point(0.0);}if(wy<=surface[0].hi){uncertain|=256u;return point(0.0);}
 if(surface[1].hi<=wy){return point(1.0);}if(surface[1].lo<=wy){uncertain|=256u;return point(0.0);}
 let denominator=sub(surface[1],surface[0]);if(denominator.lo<=0.0){uncertain|=256u;return point(0.0);}
 return division_positive(sub(point(wy),surface[0]),denominator);
}
fn cave_table_value(at:u32)->Interval{
 let bits=table[at];let m=bits&0x7fffffffu;if((m!=0u&&m<0x00800000u)||m>=0x7f800000u){uncertain|=128u;return point(0.0);}return point(bitcast<f32>(bits));
}
fn cave_modifier_cell(desc:u32,x:i32,y:i32)->Interval{return cave_table_value(table[desc]+wrap(y,table[desc+2u])*table[desc+1u]+wrap(x,table[desc+1u]));}
fn cave_modifier(config:u32,ax:u32,ay:u32)->Interval{
 let kind=table[config+10u];if(kind==0u){return point(1.0);}let gx=point(af(ax+1u));let gy=point(af(ay+1u));var m=point(0.0);
 if(kind==3u){
  let gid=ti(config+11u);if(gid<0||gid>=4){uncertain|=512u;return point(0.0);}let desc=table[table[13]+2u]+u32(gid)*4u;
  if(table[desc+3u]==0u||table[desc+1u]==0u||table[desc+2u]==0u){uncertain|=512u;return point(0.0);}
  let ix=floor_i(gx);let iy=floor_i(gy);let fx=fraction(gx,ix);let fy=fraction(gy,iy);
  let wx=mul(mul(sub(point(3.0),mul(point(2.0),fx)),fx),fx);let wy=mul(mul(sub(point(3.0),mul(point(2.0),fy)),fy),fy);
  m=lerp(lerp(cave_modifier_cell(desc,ix,iy),cave_modifier_cell(desc,ix+1,iy),wx),lerp(cave_modifier_cell(desc,ix,iy+1),cave_modifier_cell(desc,ix+1,iy+1),wx),wy);
  if(m.hi<1.0){let noise=edge_simplex(gx,gy);let weight=mul(sub(point(1.0),m),point(${c(.495)}));m=add(m,mul(noise,weight));}
  else if(m.lo<1.0){uncertain|=256u;return point(0.0);}
 }else if(kind==1u||kind==2u){
  if(kind==1u){m=cave_value(config,9u);if(m.lo>=1.0){return m;}if(m.hi>=1.0){uncertain|=256u;return point(0.0);}}
  let noise=edge_simplex(gx,gy);let weight=sub(point(1.0),m);m=add(m,mul(mul(noise,weight),point(${c(.495)})));
 }else{uncertain|=512u;return point(0.0);}
 return Interval(max(0.0,m.lo),max(0.0,m.hi));
}
fn cave_base_noise(x:Interval,y:Interval,kind:u32)->Interval{
 if(kind==5u){return edge_simplex(x,y);}if(kind==8u){return simplex(x,y);}uncertain|=512u;return point(0.0);
}
fn cave_fbm(x:Interval,y:Interval,kind:u32,octaves:u32)->Interval{
 let m0=point(${c(.84147)});let m1=point(${c(.5403)});let scales=array<f32,3>(${c(2.02)},${c(2.33)},${c(2.01)});
 var ax=x;var ay=y;var acc=point(0.0);var weight=select(1.0,0.5,octaves==4u);
 for(var octave=0u;octave<octaves;octave++){
  acc=add(acc,mul(cave_base_noise(ax,ay,kind),point(weight)));if(uncertain!=0u){return point(0.0);}if(octave+1u==octaves){break;}
  let nx=mul(add(mul(m0,ax),mul(m1,ay)),point(scales[octave]));let ny=mul(add(mul(m1,ax),mul(neg(m0),ay)),point(scales[octave]));ax=nx;ay=ny;weight*=0.5;
 }
 if(octaves==4u){return division_positive(acc,point(0.9375));}return acc;
}
fn cave_material_noise(config:u32,ax:u32,ay:u32)->Interval{
 let x=point(af(ax));let y=point(af(ay));let kind=table[config+3u];var n=point(0.0);
 n=cave_fbm(x,y,kind,select(1u,4u,table[config+4u]!=0u));
 if(table[config+5u]!=0u){n=square(n);}
 let minimum=cave_value(config,7u);let maximum=cave_value(config,8u);
 if(table[config+6u]!=0u){n=Interval(min(max(n.lo,minimum.lo),maximum.lo),min(max(n.hi,minimum.hi),maximum.hi));}
 if(table[config+7u]!=0u){let b=add(mul(n,point(0.5)),point(0.5));n=add(mul(point(tf(config+32u)),b),minimum);}
 return n;
}
fn cave_hash(n:i32)->Interval{
 let header=table[13];let index=n-ti(header+5u);if(index<0||u32(index)>=table[header+6u]){uncertain|=128u;return point(0.0);}return cave_table_value(table[header+4u]+u32(index));
}
fn cave_value_sin(x:Interval,y:Interval,parity:bool)->Interval{
 let ix=floor_i(x);let iy=floor_i(y);if(uncertain!=0u){return point(0.0);}let fx=fraction(x,ix);let fy=fraction(y,iy);var u=smooth_interval(fx);var v=smooth_interval(fy);
 if(parity){var u0=u;var u1=u;var v0=v;var v1=v;if((ix&1)!=0){u0=fx;}else{u1=fx;}if((iy&1)!=0){v0=fy;}else{v1=fy;}u=lerp(u0,u1,fx);v=lerp(v0,v1,fy);}
 let n=iy*57+ix;return lerp(lerp(cave_hash(n),cave_hash(n+1),u),lerp(cave_hash(n+57),cave_hash(n+58),u),v);
}
fn cave_carved(d:Interval,kind:u32,x:u32,y:u32)->Interval{
 let ax=axes[page.cave_axes+2u]+x*6u;let ay=axes[page.cave_axes+3u]+y*6u;var noise=point(0.0);let amp=point(${c(.05)});
 if(kind==0u){let v=cave_value_sin(point(af(ax+1u)),point(af(ay+1u)),true);let a=add(mul(v,amp),amp);noise=simplex(mul(a,point(af(ax+2u))),mul(point(af(ay+2u)),a));}
 else if(kind==3u){
  if((axes[ax+3u]&0x7fffffffu)>=0x7f800000u||(axes[ay+3u]&0x7fffffffu)>=0x7f800000u){uncertain|=128u;return point(0.0);}
  let v=cave_value_sin(point(af(ax)),point(af(ay)),false);let a=add(mul(v,amp),amp);noise=edge_simplex(mul(Interval(af(ax+3u),af(ax+4u)),a),mul(Interval(af(ay+3u),af(ay+4u)),a));
 }else{uncertain|=512u;return point(0.0);}
 let cave=mul(noise,d);let t=division_positive(sub(d,point(${c(.85)})),point(${c(.1)}));return add(mul(sub(cave,d),t),d);
}
fn topology0(id:i32,x:u32,y:u32)->i32{
 let b=biome_at(id);let config=cave_config(id);if(table[config+1u]!=0u||table[b+3u]==0u){return 0;}
 let family=axes[page.cave_axes];let ax=axes[family+u32(id)*2u]+x*2u;let ay=axes[family+u32(id)*2u+1u]+y*2u;
 let modifier=cave_modifier(config,ax,ay);if(uncertain!=0u){return 0;}if(modifier.hi<=0.0){return band_select(id,x,y,point(0.0),0);}if(modifier.lo<=0.0){uncertain|=256u;return 0;}
 var d=mul(cave_depth(id,x,y),modifier);if(uncertain!=0u){return 0;}if(d.hi<=0.0){return band_select(id,x,y,point(0.0),0);}if(d.lo<=0.0){uncertain|=256u;return 0;}
 var weight=point(0.0);var noise=point(0.0);let perlin=cave_value(config,1u);
 if(perlin.lo!=0.0||perlin.hi!=0.0){
  if(d.lo>${c(.51)}){weight=mul(sub(d,point(0.5)),point(2.0));noise=cave_material_noise(config,ax,ay);}
  else if(d.hi>${c(.51)}){uncertain|=256u;return 0;}
 }
 var addition=point(0.0);if(d.lo>${c(.85)}){addition=cave_value(config,2u);d=cave_carved(d,table[config+2u],x,y);}else if(d.hi>${c(.85)}){uncertain|=256u;return 0;}
 if(table[config+9u]!=0u){uncertain|=512u;return 0;}
 let first=mul(mul(perlin,weight),noise);let second=mul(cave_value(config,0u),d);let result=add(add(first,second),addition);
 if(uncertain!=0u){return 0;}return band_select(id,x,y,result,0);
}
`;
