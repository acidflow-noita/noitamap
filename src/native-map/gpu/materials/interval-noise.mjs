const buffer=new ArrayBuffer(4),f=new Float32Array(buffer),u=new Uint32Array(buffer);
const bits=v=>{f[0]=v;return u[0];};
const literal=v=>`bitcast<f32>(${bits(v)}u)`;
function bounds(v){f[0]=v;const x=f[0],b=u[0];const low=x>v?(x>0?b-1:b+1):b,high=x<v?(x>=0?b+1:b-1):b;return`Interval(bitcast<f32>(${low>>>0}u),bitcast<f32>(${high>>>0}u))`;}

// The caller supplies perm_c, perm_v and perm_value lookup functions and a
// private `uncertain:u32`. All integer/floor branch uncertainty is explicit.
// Outward float bounds cover either allowed rounding direction of each WGSL
// operation; bit-level widening is an observable non-float operation between
// every ordered step, so reassociation cannot cross it while preserving values.
export const intervalNoiseWGSL=/*wgsl*/`
struct Interval { lo:f32, hi:f32 }
fn point(x:f32)->Interval{return Interval(x,x);}
fn down(x:f32)->f32 {
 let b=bitcast<u32>(x); let a=b&0x7fffffffu;
 if(a<0x00800000u){return bitcast<f32>(0x80800000u);}
 if(b==0x00800000u){return 0.0;}
 return bitcast<f32>(select(b-1u,b+1u,(b&0x80000000u)!=0u));
}
fn up(x:f32)->f32 {
 let b=bitcast<u32>(x); let a=b&0x7fffffffu;
 if(a<0x00800000u){return bitcast<f32>(0x00800000u);}
 if(b==0x80800000u){return 0.0;}
 return bitcast<f32>(select(b+1u,b-1u,(b&0x80000000u)!=0u));
}
fn neg(a:Interval)->Interval{return Interval(-a.hi,-a.lo);}
fn add(a:Interval,b:Interval)->Interval {
 if(a.lo==0.0&&a.hi==0.0){return b;} if(b.lo==0.0&&b.hi==0.0){return a;}
 if(a.lo==a.hi&&b.lo==b.hi&&a.lo == -b.lo){return point(0.0);}
 return Interval(down(a.lo+b.lo),up(a.hi+b.hi));
}
fn sub(a:Interval,b:Interval)->Interval{return add(a,neg(b));}
fn mul(a:Interval,b:Interval)->Interval {
 if((a.lo==0.0&&a.hi==0.0)||(b.lo==0.0&&b.hi==0.0)){return point(0.0);}
 if(a.lo==1.0&&a.hi==1.0){return b;} if(b.lo==1.0&&b.hi==1.0){return a;}
 if(a.lo == -1.0&&a.hi == -1.0){return neg(b);} if(b.lo == -1.0&&b.hi == -1.0){return neg(a);}
 let aa=a.lo*b.lo;let ab=a.lo*b.hi;let ba=a.hi*b.lo;let bb=a.hi*b.hi;
 return Interval(down(min(min(aa,ab),min(ba,bb))),up(max(max(aa,ab),max(ba,bb))));
}
fn square(a:Interval)->Interval {
 let lo=min(abs(a.lo),abs(a.hi));let hi=max(abs(a.lo),abs(a.hi));
 if(hi==0.0){return point(0.0);}
 return Interval(select(max(0.0,down(lo*lo)),0.0,a.lo<=0.0&&a.hi>=0.0),up(hi*hi));
}
fn floor_i(a:Interval)->i32 {
 let lo=i32(floor(a.lo)); let hi=i32(floor(a.hi));
 if(lo!=hi){uncertain|=1u;} return lo;
}
fn skew_i(a:Interval)->i32 {
 let lo=i32(a.lo)-select(1,0,a.lo>0.0);let hi=i32(a.hi)-select(1,0,a.hi>0.0);
 if(lo!=hi){uncertain|=2u;}return lo;
}
fn fraction(a:Interval,i:i32)->Interval {
 // For these bounded coordinates, subtracting floor(a) is exact by Sterbenz
 // except in(-1,0); [0,1) subtracts0 exactly. Fraction always lies in[0,1].
 if(a.lo==a.hi&&(a.lo>=0.0||a.lo<= -1.0)){return point(a.lo-f32(i));}
 let v=sub(a,point(f32(i)));return Interval(max(0.0,v.lo),min(1.0,v.hi));
}
fn smooth_interval(a:Interval)->Interval{return mul(sub(point(3.0),mul(a,point(2.0))),square(a));}
fn lerp(a:Interval,b:Interval,t:Interval)->Interval{return add(mul(sub(b,a),t),a);}
fn fade(a:Interval)->Interval {
 var r=sub(mul(a,point(6.0)),point(15.0));r=add(mul(r,a),point(10.0));
 r=mul(r,a);r=mul(r,a);return mul(r,a);
}
const grad_x=array<i32,8>(-1,1,0,0,-1,-1,1,1);
const grad_y=array<i32,8>(0,0,-1,1,-1,1,-1,1);
fn perlin(x:Interval,y:Interval)->Interval {
 let ix=floor_i(x);let iy=floor_i(y);if(uncertain!=0u){return point(0.0);}
 let fx=fraction(x,ix);let fy=fraction(y,iy);let fx1=sub(fx,point(1.0));let fy1=sub(fy,point(1.0));
 let px=perm_v(u32(ix)&255u);let px1=perm_v(u32(ix+1)&255u);let yy=u32(iy)&255u;let yp=u32(iy+1)&255u;
 let g00=perm_v(px+yy)&7u;let g01=perm_v(px+yp)&7u;let g10=perm_v(px1+yy)&7u;let g11=perm_v(px1+yp)&7u;
 let n00=add(mul(point(f32(grad_y[g00])),fy),mul(fx,point(f32(grad_x[g00]))));
 let n10=add(mul(point(f32(grad_y[g10])),fy),mul(fx1,point(f32(grad_x[g10]))));
 let n01=add(mul(point(f32(grad_y[g01])),fy1),mul(point(f32(grad_x[g01])),fx));
 let n11=add(mul(point(f32(grad_y[g11])),fy1),mul(point(f32(grad_x[g11])),fx1));
 let dy=fade(fy);return lerp(lerp(n00,n01,dy),lerp(n10,n11,dy),fade(fx));
}
fn value_noise(x:Interval,y:Interval)->Interval {
 let ix=floor_i(x);let iy=floor_i(y);if(uncertain!=0u){return point(0.0);}
 let fx=fraction(x,ix);let fy=fraction(y,iy);let px=perm_v(u32(ix)&255u);let px1=perm_v(u32(ix+1)&255u);let yy=u32(iy)&255u;let yp=u32(iy+1)&255u;
 let v00=point(perm_value(perm_v(px+yy)));let v01=point(perm_value(perm_v(px+yp)));
 let v10=point(perm_value(perm_v(px1+yy)));let v11=point(perm_value(perm_v(px1+yp)));
 let dy=fade(fy);return mul(sub(lerp(lerp(v00,v01,dy),lerp(v10,v11,dy),fade(fx)),point(0.5)),point(2.0));
}
fn cs_corner(x:Interval,y:Interval,g:u32)->Interval {
 var t=sub(sub(point(0.5),square(x)),square(y));if(t.hi<0.0){return point(0.0);}t.lo=max(0.0,t.lo);
 var a=x;var b=y;if(g>=4u){a=y;b=x;}if((g&1u)!=0u){a=neg(a);}
 b=mul(b,point(select(2.0,-2.0,(g&2u)!=0u)));return mul(add(a,b),square(square(t)));
}
fn simplex(x:Interval,y:Interval)->Interval {
 let f2=point(${literal(0.3660253882408142)});let g2=point(${literal(0.21132487058639526)});let g22=point(${literal(0.4226497411727905)});
 let s=mul(add(x,y),f2);let i=skew_i(add(x,s));let j=skew_i(add(s,y));if(uncertain!=0u){return point(0.0);}
 let t=mul(point(f32(i+j)),g2);let x0=sub(x,sub(point(f32(i)),t));let y0=sub(y,sub(point(f32(j)),t));
 var i1=0;if(x0.lo>y0.hi){i1=1;}else if(x0.hi>y0.lo){uncertain|=4u;return point(0.0);}let j1=1-i1;
 let x1=add(sub(x0,point(f32(i1))),g2);let y1=add(sub(y0,point(f32(j1))),g2);
 let x2=add(sub(x0,point(1.0)),g22);let y2=add(sub(y0,point(1.0)),g22);let ii=u32(i)&255u;let jj=u32(j)&255u;
 let n0=cs_corner(x0,y0,perm_c(perm_c(jj)+ii)&7u);let n1=cs_corner(x1,y1,perm_c(perm_c(jj+u32(j1))+ii+u32(i1))&7u);let n2=cs_corner(x2,y2,perm_c(perm_c(jj+1u)+ii+1u)&7u);
 return mul(add(add(n1,n0),n2),point(40.0));
}
const edge_x=array<i32,12>(1,-1,1,-1,1,-1,1,-1,0,0,0,0);
const edge_y=array<i32,12>(1,1,-1,-1,0,0,0,0,1,-1,1,-1);
fn edge_corner(x:Interval,y:Interval,g:u32)->Interval {
 var t=sub(sub(point(0.5),square(x)),square(y));if(t.hi<0.0){return point(0.0);}t.lo=max(0.0,t.lo);
 var n=add(mul(point(f32(edge_y[g])),y),mul(point(f32(edge_x[g])),x));n=mul(n,t);n=mul(n,t);n=mul(n,t);return mul(n,t);
}
fn edge_simplex(x:Interval,y:Interval)->Interval {
 let f2=${bounds(0.3660254037844386)};let g2=${bounds(0.21132486540518713)};
 let s=mul(add(x,y),f2);let ix=floor_i(add(s,x));let iy=floor_i(add(s,y));if(uncertain!=0u){return point(0.0);}
 let t=mul(point(f32(ix+iy)),g2);let dx=sub(x,sub(point(f32(ix)),t));let dy=sub(y,sub(point(f32(iy)),t));
 var sx=0;if(dy.hi<dx.lo){sx=1;}else if(dy.lo<dx.hi){uncertain|=4u;return point(0.0);}let sy=1-sx;
 let x1=add(sub(dx,point(f32(sx))),g2);let y1=add(sub(dy,point(f32(sy))),g2);
 let x2=add(sub(dx,point(1.0)),mul(g2,point(2.0)));let y2=add(sub(dy,point(1.0)),mul(g2,point(2.0)));let ii=u32(ix)&255u;let jj=u32(iy)&255u;
 let n0=edge_corner(dx,dy,perm_c(perm_c(jj)+ii)%12u);let n1=edge_corner(x1,y1,perm_c(perm_c(jj+u32(sy))+ii+u32(sx))%12u);let n2=edge_corner(x2,y2,perm_c(perm_c(jj+1u)+ii+1u)%12u);
 return mul(add(add(n1,n0),n2),point(70.0));
}
fn lookup_coord(scale:f32,gx:f32,gy:f32,cx:f32,cy:f32,fx:f32,fy:f32)->array<Interval,2> {
 if(!(scale>0.0)){return array<Interval,2>(point(gx),point(gy));}
 let ix=i32(floor(gx));let iy=i32(floor(gy));
 let a=add(mul(simplex(point(cx),point(cy)),point(${literal(.44999998807907104)})),point(${literal(.10000000149011612)}));
 let pv=perlin(point(fy),point(fx));var dy=mul(sub(point(1.0),a),point(${literal(.33000001311302185)}));dy=mul(add(dy,point(${literal(.11100000143051147)})),point(scale));
 let oy=add(mul(pv,dy),fraction(point(gy),iy));let vn=value_noise(point(fx),point(fy));
 let ox=add(mul(vn,mul(a,point(scale))),fraction(point(gx),ix));
 return array<Interval,2>(add(ox,point(f32(ix))),add(point(f32(iy)),oy));
}
fn density(x:f32,y:f32,ax:f32,ay:f32,cov:Interval)->Interval {
 let n1=value_noise(point(ax),point(ay));let warp=mul(n1,point(${literal(15.5)}));let scale=point(${literal(.04892750084400177)});
 let sy=mul(add(point(y),warp),scale);let sx=mul(add(point(x),warp),scale);let n2=simplex(sx,sy);
 let t=mul(sub(cov,point(0.5)),point(0.5));var m=square(t);m=mul(m,point(${literal(5.349999904632568)}));m=mul(m,point(${literal(.949999988079071)}));
 let r=add(mul(n2,m),cov);return Interval(max(0.5,r.lo),max(0.5,r.hi));
}
`;
