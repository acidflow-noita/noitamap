import { intervalNoiseWGSL } from './interval-noise.mjs';
import { polkaHashWGSL } from './polka-hash.mjs';
// Caller supplies table, axes, page{x,y,band_axes}, and private uncertain:u32.
// Terrain passes no_match=0; scene selectors preserve no_match=-1.
export const bandKernelWGSL=/*wgsl*/`
fn perm_c(i:u32)->u32{return table[table[6]+i];}
fn perm_v(i:u32)->u32{return table[table[7]+i];}
fn perm_value(i:u32)->f32{return bitcast<f32>(table[table[8]+i]);}
fn tf(i:u32)->f32{return bitcast<f32>(table[i]);}
fn af(i:u32)->f32{return bitcast<f32>(axes[i]);}
fn ti(i:u32)->i32{return bitcast<i32>(table[i]);}
fn biome_at(id:i32)->u32{return table[2]+u32(id)*8u;}
${intervalNoiseWGSL}
${polkaHashWGSL}
fn division_positive(a:Interval,b:Interval)->Interval{
 if(b.lo<=0.0){uncertain|=16u;return point(0.0);}
 if(b.lo<bitcast<f32>(0x20000000u)||a.hi>1048576.0){uncertain|=128u;return point(0.0);}
 var lo=a.lo/b.hi;var hi=a.hi/b.lo;
 // WGSL division allows2.5ULP. Eight adjacent-float steps conservatively
 // cover either rounding direction, exponent boundaries and source RN.
 for(var i=0u;i<8u;i++){lo=down(lo);hi=up(hi);}return Interval(lo,hi);
}
fn hash_fraction(bits:u32)->f32{let v=bitcast<f32>(bits);return v-floor(v);}
fn polka(b:u32,ax:u32,ay:u32)->Interval{
 let h=polka_hash(axes[ax+2u],axes[ay+2u]);if(uncertain!=0u){return point(0.0);}
 if(hash_fraction(h.x)>=tf(b+8u)){return point(0.0);}
 let h0=point(hash_fraction(h.y));let h1=point(hash_fraction(h.z));let h2=point(hash_fraction(h.w));
 let radius=add(mul(point(tf(b+11u)),h2),Interval(tf(b+9u),tf(b+10u)));
 if(radius.hi<=0.0){return point(0.0);}let s=division_positive(point(2.0),radius);let sm1=sub(s,point(1.0));let sm2=sub(s,point(2.0));
 let dy=add(mul(sm2,h1),sub(mul(point(af(ay+1u)),s),sm1));let dx=add(mul(sm2,h0),sub(mul(point(af(ax+1u)),s),sm1));
 var xx=square(dx);var yy=square(dy);if((table[b+1u]&32u)!=0u){xx=square(xx);yy=square(yy);}
 var distance=add(yy,xx);if(distance.lo>=1.0){return point(0.0);}distance.hi=min(distance.hi,1.0);distance.lo=max(distance.lo,0.0);
 let v=sub(point(1.0),distance);return mul(square(v),v);
}
fn band_select(id:i32,x:u32,y:u32,d:Interval,no_match:i32)->i32{
 let biome=biome_at(id);let minimum=tf(biome);let maximum=tf(biome+1u);
 if(d.hi<minimum||d.lo>maximum){return no_match;}
 if(d.lo<minimum||d.hi>maximum){uncertain|=32u;return no_match;}
 let first=table[biome+2u];let count=table[biome+3u];let wy=f32(page.y+i32(y));
 for(var i=0u;i<count;i++){
  let index=first+i;let b=table[4]+index*16u;let flags=table[b+1u];
  if((flags&1u)!=0u&&(wy<tf(b+4u)||wy>tf(b+5u))){continue;}
  let ax=axes[page.band_axes+index*2u]+x*4u;let ay=axes[page.band_axes+index*2u+1u]+y*4u;var n=d;
  if((flags&2u)!=0u){n=add(edge_simplex(point(af(ax+3u)),point(af(ay+3u))),d);}
  if(n.hi<tf(b+2u)||n.lo>=tf(b+3u)){continue;}
  if(n.lo<tf(b+2u)||n.hi>=tf(b+3u)){uncertain|=32u;return no_match;}
  if((flags&4u)==0u){return max(no_match,ti(b));}
  if((flags&8u)!=0u){
   let v=edge_simplex(point(af(ax)),point(af(ay)));
   if(v.hi<=tf(b+6u)||v.lo>tf(b+7u)){continue;}
   if(v.lo<=tf(b+6u)||v.hi>tf(b+7u)){uncertain|=64u;return no_match;}
  }
  if((flags&16u)==0u){return max(no_match,ti(b));}
  let v=polka(b,ax,ay);
  if(v.hi<=tf(b+6u)||v.lo>tf(b+7u)){continue;}
  if(v.lo<=tf(b+6u)||v.hi>tf(b+7u)){uncertain|=64u;return no_match;}
  return max(no_match,ti(b));
 }
 return no_match;
}
`;
