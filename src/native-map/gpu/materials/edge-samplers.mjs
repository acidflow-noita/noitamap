// Exact target: complete-materials/topo2.c coverage_edge/material_edge.
// Inputs bound the source f32 coordinates after any vertical/shaft transform.
// Shift/fraction intervals enclose the source f64 operations and (for type1)
// their explicit f32 casts. Only branch-invariant integer0/1 coverage is accepted.
// Caller supplies Interval helpers, cov_at, mat_at and private uncertain:u32.
export const edgeSamplersWGSL=/*wgsl*/`
fn edge_ge(a:Interval,b:Interval)->bool{
 if(a.lo>=b.hi){return true;}if(a.hi<b.lo){return false;}
 uncertain|=16u;return false;
}
fn coverage_edge(x:Interval,y:Interval)->Interval{
 let xp=add(x,point(0.5));let yp=add(y,point(0.5));let ix=floor_i(xp);let iy=floor_i(yp);
 if(uncertain!=0u){return point(0.0);}
 // The center comparison is deliberately strict; every side uses >=0.5.
 if(cov_at(ix,iy).lo>0.5){return point(1.0);}
 let fx=fraction(xp,ix);let fy=fraction(yp,iy);let omfx=sub(point(1.0),fx);
 let lower=edge_ge(fx,fy);let right=edge_ge(fy,omfx);if(uncertain!=0u){return point(0.0);}
 var nx=ix;var ny=iy;
 if(lower){if(right){nx=ix+1;}else{ny=iy-1;}}
 else{if(right){ny=iy+1;}else{nx=ix-1;}}
 if(cov_at(nx,ny).lo>=0.5){return point(1.0);}
 let sx=ix+select(-1,1,edge_ge(fx,point(0.5)));let sy=iy+select(-1,1,edge_ge(fy,point(0.5)));
 if(uncertain!=0u){return point(0.0);}
 if(cov_at(sx,sy).lo<0.5){return point(0.0);}
 if(cov_at(sx,iy).lo>=0.5){return point(1.0);}
 return point(select(0.0,1.0,cov_at(ix,sy).lo>=0.5));
}
fn material_edge(x:Interval,y:Interval)->Interval{
 let xp=add(x,point(0.5));let yp=add(y,point(0.5));let ix=floor_i(xp);let iy=floor_i(yp);
 if(uncertain!=0u){return point(0.0);}
 if(cov_at(ix,iy).lo>0.5){return point(1.0);}
 // These fractions/comparisons enclose f64 values; do not assume f32 ties.
 let fx=fraction(xp,ix);let fy=fraction(yp,iy);let lower=edge_ge(fx,fy);if(uncertain!=0u){return point(0.0);}
 let dx=select(-1,1,lower);let dy= -dx;let material=mat_at(ix,iy);
 if(cov_at(ix+dx,iy).lo>=0.5&&cov_at(ix,iy+dy).lo>=0.5&&mat_at(ix+dx,iy)==material&&mat_at(ix,iy+dy)==material){return point(1.0);}
 let d=select(1,-1,edge_ge(sub(point(1.0),fx),fy));if(uncertain!=0u){return point(0.0);}
 return point(select(0.0,1.0,cov_at(ix+d,iy).lo>=0.5&&cov_at(ix,iy+d).lo>=0.5&&mat_at(ix+d,iy)==material&&mat_at(ix,iy+d)==material));
}
`;
