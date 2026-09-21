import { COLLISION_GLSL } from "./particle-collision.mjs";
// GPU-resident cosmetic-particle updates and quads. This follows the reference
// operation order, but GLSL transcendental/float precision is not a bit-exact
// substitute for the reference's mixed double/float arithmetic.
import { SIMPLEX_PERMUTATION } from "./portal-physics.mjs";

const attributes = `
layout(location=0) in vec4 motion;
layout(location=1) in vec4 appearance;
layout(location=2) in vec4 forces;
layout(location=3) in vec4 flow;
layout(location=4) in vec4 targetColor;
layout(location=5) in vec4 metadata;
layout(location=6) in vec4 contact;
`;
const noise = `
const int permutation[256] = int[256](${SIMPLEX_PERMUTATION.join(",")});
int perm(int n) { return permutation[n & 255]; }
// Compensated float pairs reduce noise error at large world coordinates.
// They are NOT IEEE float64 and do not make this shader bit-identical to x86.
// The final force is rounded to float32, as in the reference.
vec2 dsAdd(vec2 a,vec2 b) {
  float sum=a.x+b.x, v=sum-a.x;
  float error=((b.x-v)+(a.x-(sum-v)))+a.y+b.y;
  float high=sum+error;
  return vec2(high,error-(high-sum));
}
vec2 dsMul(vec2 a,vec2 b) {
  float product=a.x*b.x;
  float ca=8193.*a.x, ah=ca-(ca-a.x), al=a.x-ah;
  float cb=8193.*b.x, bh=cb-(cb-b.x), bl=b.x-bh;
  float error=(((ah*bh-product)+ah*bl)+al*bh)+al*bl;
  error+=(a.x*b.y+a.y*b.x);
  float high=product+error;
  return vec2(high,error-(high-product));
}
bool dsGreater(vec2 a,vec2 b) { return a.x>b.x||(a.x==b.x&&a.y>=b.y); }
int dsFloor(vec2 a) {
  float base=floor(a.x);
  if(a.x==base&&a.y<0.) base-=1.;
  else if((a.x-base)+a.y>=1.) base+=1.;
  return int(base);
}
vec2 dsCorner(vec2 x,vec2 y,vec2 z,int index) {
  vec2 t=dsAdd(dsAdd(dsAdd(vec2(.6,-2.384185793236071e-8),-dsMul(x,x)),-dsMul(y,y)),-dsMul(z,z));
  if(t.x<0.)return vec2(0);
  int i=index%12;
  vec3 g=i==0?vec3(1,1,0):i==1?vec3(-1,1,0):i==2?vec3(1,-1,0):i==3?vec3(-1,-1,0):
    i==4?vec3(1,0,1):i==5?vec3(-1,0,1):i==6?vec3(1,0,-1):i==7?vec3(-1,0,-1):
    i==8?vec3(0,1,1):i==9?vec3(0,-1,1):i==10?vec3(0,1,-1):vec3(0,-1,-1);
  vec2 dotValue=dsAdd(dsAdd(y*g.y,x*g.x),z*g.z);
  return dsMul(dsMul(dsMul(dsMul(dotValue,t),t),t),t);
}
float simplex(vec3 p) {
  const vec2 third=vec2(.3333333333333333,-9.934107481068821e-9);
  const vec2 sixth=vec2(.16666666666666666,-4.967053740534411e-9);
  vec2 skew=dsMul(dsAdd(dsAdd(vec2(p.x,0),vec2(p.y,0)),vec2(p.z,0)),third);
  ivec3 cell=ivec3(dsFloor(dsAdd(vec2(p.x,0),skew)),dsFloor(dsAdd(vec2(p.y,0),skew)),dsFloor(dsAdd(vec2(p.z,0),skew)));
  vec2 unskew=dsMul(vec2(float(cell.x+cell.y+cell.z),0),sixth);
  vec2 x=dsAdd(vec2(p.x,0),-dsAdd(vec2(float(cell.x),0),-unskew));
  vec2 y=dsAdd(vec2(p.y,0),-dsAdd(vec2(float(cell.y),0),-unskew));
  vec2 z=dsAdd(vec2(p.z,0),-dsAdd(vec2(float(cell.z),0),-unskew));
  ivec3 a=ivec3(0),b=ivec3(0);
  if(dsGreater(x,y)) {
    if(dsGreater(y,z)){a.x=1;b.xy=ivec2(1);}
    else if(dsGreater(x,z)){a.x=1;b.xz=ivec2(1);}
    else {a.z=1;b.xz=ivec2(1);}
  } else {
    if(!dsGreater(y,z)){a.z=1;b.yz=ivec2(1);}
    else if(!dsGreater(x,z)){a.y=1;b.yz=ivec2(1);}
    else {a.y=1;b.xy=ivec2(1);}
  }
  vec2 n0=dsCorner(x,y,z,perm(cell.x+perm(cell.y+perm(cell.z))));
  vec2 n1=dsCorner(dsAdd(dsAdd(x,vec2(-float(a.x),0)),sixth),dsAdd(dsAdd(y,vec2(-float(a.y),0)),sixth),dsAdd(dsAdd(z,vec2(-float(a.z),0)),sixth),perm(cell.x+a.x+perm(cell.y+a.y+perm(cell.z+a.z))));
  vec2 n2=dsCorner(dsAdd(dsAdd(x,vec2(-float(b.x),0)),third),dsAdd(dsAdd(y,vec2(-float(b.y),0)),third),dsAdd(dsAdd(z,vec2(-float(b.z),0)),third),perm(cell.x+b.x+perm(cell.y+b.y+perm(cell.z+b.z))));
  vec2 n3=dsCorner(dsAdd(dsAdd(x,vec2(-1,0)),vec2(.5,0)),dsAdd(dsAdd(y,vec2(-1,0)),vec2(.5,0)),dsAdd(dsAdd(z,vec2(-1,0)),vec2(.5,0)),perm(cell.x+1+perm(cell.y+1+perm(cell.z+1))));
  vec2 result=dsAdd(dsAdd(dsAdd(n1,n0),n2),n3)*32.;
  return result.x+result.y;
}
`;
export const PARTICLE_SHADERS = {
  updateVertex: `#version 300 es
precision highp float;
precision highp int;
${attributes}
${noise}
${COLLISION_GLSL}
uniform float simulationTime;
out vec4 nextMotion;
out vec4 nextAppearance;
out vec4 nextContact;
void main() {
  nextMotion=motion;nextAppearance=appearance;nextContact=contact;
  gl_Position=vec4(0,0,0,1);
  if(appearance.w<0.) return;
  const float dt=0.01666666753590107;
  nextAppearance.w=appearance.w-dt;
  if(appearance.z==0. && forces.w<=0.) return;
  vec2 position=motion.xy+motion.zw*dt;
  float alpha=clamp(appearance.z+forces.w*dt,0.,1.);
  vec2 velocity=motion.zw;
  if(flow.z>0.) velocity+=((targetColor.xy-motion.xy)*dt)*flow.z;
  velocity+=forces.xy*dt;
  if(flow.x>0.) {
    float angle=simplex(vec3(position*flow.y,simulationTime))*3.1415927410125732;
    velocity.x+=-sin(angle)*flow.x;
    velocity.y=cos(angle)*flow.x+velocity.y;
  }
  if(forces.z!=0.) velocity-=(velocity*forces.z)*dt;
  if((int(metadata.x)&8192)!=0)
    collideParticle(motion.xy,position,velocity,nextAppearance.w,nextContact,(int(metadata.x)&192)==192);
  float speed=sqrt(velocity.x*velocity.x+velocity.y*velocity.y);
  vec2 delta=motion.xy-position;
  float distance=sqrt(delta.x*delta.x+delta.y*delta.y);
  vec2 direction=distance>0. ? delta/distance : vec2(0);
  nextMotion=vec4(position,velocity);
  nextAppearance=vec4((direction*speed)*dt+position,alpha,nextAppearance.w);
}`,
  updateFragment: `#version 300 es
precision highp float;
out vec4 result;
void main(){result=vec4(0);}`,
  drawVertex: `#version 300 es
precision highp float;
precision highp int;
${attributes}
uniform vec2 origin;
uniform vec4 overrideColor;
uniform bool glowPass;
out vec4 tint;
out vec2 uv;
float byteAlpha(float a) { return float(int(a*255.) & 255)/255.; }
float roundCell(float x) { return floor(x+(x>=0. ? .5 : -.5)); }
void main() {
  uv=vec2(gl_VertexID==1||gl_VertexID==3 ? 1. : 0.,gl_VertexID>=2 ? 1. : 0.);
  gl_Position=vec4(2,2,0,1);tint=vec4(0);
  int flags=int(metadata.x);
  bool longParticle=(flags&1)!=0, grid=(flags&2)!=0, wide=(flags&4)!=0;
  vec2 center=motion.xy+origin;
  if(appearance.w<0.||appearance.z<=0.||center.x< -40.||center.y< -40.||center.x>520.||center.y>360.) return;
  if(glowPass && (flags&8)==0) return;
  uint color=uint(targetColor.z)|(uint(targetColor.w)<<16);
  vec3 rgb=overrideColor.w>0. ? overrideColor.rgb : vec3(float((color>>16)&255u),float((color>>8)&255u),float(color&255u))/255.;
  vec2 anchor, local;
  float c=1.,s=0.,alpha;
  if(!longParticle) {
    if(glowPass) {
      alpha=byteAlpha((appearance.z*min(appearance.w,1.)*.03)*((flags&16)!=0?50.:1.));
      anchor=grid ? trunc(motion.xy+.5)-12.+ceil(origin-.5) : motion.xy-12.+origin;
      local=uv*24.;
    } else {
      float width=wide?2.:1.;
      alpha=byteAlpha(appearance.z*(wide?.5:1.));
      anchor=(grid?vec2(roundCell(motion.x+.5),roundCell(motion.y+.5)):motion.xy)-vec2(width,1)+origin;
      local=uv*vec2(width,1);
    }
  } else {
    vec2 delta=motion.xy-appearance.xy;
    float distance=sqrt(delta.x*delta.x+delta.y*delta.y);
    float length=min(distance+1.,12.);
    float angle=distance==0.?0.:atan(delta.y/distance,delta.x/distance);
    c=cos(angle);s=sin(angle);
    anchor=(grid?trunc(motion.xy+.5):motion.xy)-1.;
    if(glowPass) {
      alpha=byteAlpha((appearance.z*min(appearance.w,1.)*.2)*((flags&16)!=0?3.:1.));
      float low=(length+16.)*-.5, high=((length+16.)+length)*.5;
      local=vec2(uv.x==0.?low:high,uv.y==0.?-8.:8.);
    } else {
      alpha=byteAlpha(appearance.z*min(appearance.w,1.));
      local=uv*vec2(length,1);
    }
  }
  if(alpha<=0.) return;
  vec2 position=anchor+vec2(c*local.x-s*local.y,s*local.x+c*local.y);
  if(longParticle) position+=origin;
  position=position/vec2(480,320)*2.-1.;position.y=-position.y;
  gl_Position=vec4(position,0,1);tint=vec4(rgb,alpha);
}`,
};
