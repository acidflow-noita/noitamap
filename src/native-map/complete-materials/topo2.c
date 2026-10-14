#include <stdint.h>
#include "constants.h"
// Derived from Lymm's Telescope (MIT); see LICENSE-telescope.txt and NOTICE.txt.

// Scalar IEEE arithmetic: compile without fast math or contraction. Each float
// expression below corresponds to an explicit Math.fround in the JS reference.
typedef struct { float scale, threshold; int32_t type, present; } Params;
typedef struct {
  float coord0x, coord0y;
  int32_t idx0;
  float coordx, coordy, coverage;
  int32_t status, material;
  float density;
} Result;
_Static_assert(sizeof(Result) == 36, "Stable packed result ABI");
_Static_assert(sizeof(Params) == 16, "Stable parameter ABI");

static int gw, gh, param_count;
static const float *coverage;
static const uint16_t *materials;
static const Params *params;
static double offx;
extern unsigned char __heap_base;
#define EXPORT(name) __attribute__((export_name(name)))
EXPORT("heap_base") uintptr_t heap_base(void) { return (uintptr_t)&__heap_base; }
EXPORT("configure") void configure(int w, int h, uintptr_t c, uintptr_t m,
                                    uintptr_t p, int count, double xshift) {
  gw=w; gh=h; coverage=(const float*)c; materials=(const uint16_t*)m;
  params=(const Params*)p; param_count=count; offx=xshift;
}
static inline int floor_i(float v) { return (int)__builtin_floorf(v); }
static inline int floor_d(double v) { return (int)__builtin_floor(v); }
static inline int wrap(int v, int n) { int r=v%n; return r<0?r+n:r; }
static inline float cval(int x, int y) {
  return gw<=0||gh<=0 ? 0 : coverage[wrap(y,gh)*gw+wrap(x,gw)];
}
static inline int mval(int x, int y) {
  return gw<=0||gh<=0 ? 0 : materials[wrap(y,gh)*gw+wrap(x,gw)];
}
static inline float fade5(float t) {
  float a=t*6.0f; a=a-15.0f; a=a*t; a=a+10.0f;
  a=a*t; a=a*t; return a*t;
}
static inline float lerp(float a,float b,float t) { return ((b-a)*t)+a; }
static const float grad_x[8]={-1,1,0,0,-1,-1,1,1};
static const float grad_y[8]={0,0,-1,1,-1,1,-1,1};
static inline float perlin(float x,float y) {
  int ix=floor_i(x),iy=floor_i(y);
  float fx=(float)((double)x-ix),fy=(float)((double)y-iy);
  int px=custom[ix&255],px1=custom[(ix+1)&255],yy=iy&255,yp=(iy+1)&255;
  int g00=custom[px+yy]&7,g01=custom[px+yp]&7;
  int g10=custom[px1+yy]&7,g11=custom[px1+yp]&7;
  float fx1=fx-1.0f,fy1=fy-1.0f;
  float n00=(grad_y[g00]*fy)+(fx*grad_x[g00]);
  float n10=(grad_y[g10]*fy)+(fx1*grad_x[g10]);
  float n01=(grad_y[g01]*fy1)+(grad_x[g01]*fx);
  float n11=(grad_y[g11]*fy1)+(grad_x[g11]*fx1);
  float dy=fade5(fy),a=lerp(n00,n01,dy),b=lerp(n10,n11,dy);
  return lerp(a,b,fade5(fx));
}
static inline float value_noise(float x,float y) {
  int ix=floor_i(x),iy=floor_i(y);
  float fx=(float)((double)x-ix),fy=(float)((double)y-iy);
  int px=custom[ix&255],px1=custom[(ix+1)&255],yy=iy&255,yp=(iy+1)&255;
  // JS divides in double before fround. Correctly rounded f32 division gives
  // identical results here (small integer / exactly represented 255).
  float v00=custom[px+yy]/255.0f,v01=custom[px+yp]/255.0f;
  float v10=custom[px1+yy]/255.0f,v11=custom[px1+yp]/255.0f;
  float dy=fade5(fy),a=lerp(v00,v01,dy),b=lerp(v10,v11,dy);
  float r=lerp(a,b,fade5(fx)); return (r-0.5f)*2.0f;
}
static inline int skew_floor(float v) { return (int)v-(v>0.0f?0:1); }
static inline float corner(float x,float y,int g) {
  float t=(0.5f-x*x)-y*y;
  if(t<0.0f)return 0.0f;
  float t2=t*t,u=g<4?x:y,v=g<4?y:x;
  if(g&1)u=-u;
  v=v*((g&2)?-2.0f:2.0f);
  return (u+v)*(t2*t2);
}
static inline float simplex(float x,float y) {
  const float f2=0.3660253882408142f,g2=0.21132487058639526f,g22=0.4226497411727905f;
  float s=(x+y)*f2;
  int i=skew_floor(x+s),j=skew_floor(s+y);
  float t=(float)(i+j)*g2;
  float x0=x-((float)i-t),y0=y-((float)j-t);
  int i1=x0>y0?1:0,j1=1-i1,ii=i&255,jj=j&255;
  float x1=(x0-(float)i1)+g2,y1=(y0-(float)j1)+g2;
  float x2=(x0-1.0f)+g22,y2=(y0-1.0f)+g22;
  float n0=corner(x0,y0,classic[classic[jj]+ii]&7);
  float n1=corner(x1,y1,classic[classic[jj+j1]+ii+i1]&7);
  float n2=corner(x2,y2,classic[classic[jj+1]+ii+1]&7);
  return ((n1+n0)+n2)*40.0f;
}
static inline float smooth(float t) { float sq=t*t,lin=t*2.0f;return (3.0f-lin)*sq; }
static inline void lookup(float scale,double x,double y,float *outx,float *outy) {
  double xx=offx+x,yy=K_worldOffY+y;
  float gx=(float)((xx+0.5)*K_tenth_d),gy=(float)((yy+0.5)*K_tenth_d);
  if(!(scale>0)){*outx=gx;*outy=gy;return;}
  int ix=floor_i(gx),iy=floor_i(gy);
  float a=simplex((float)(xx*K_warpCx),(float)(yy*K_warpCy))*K_a_mul;
  a=a+K_a_add;
  float yf=(float)(yy*K_f2),xf=(float)(xx*K_f2);
  float pv=perlin(yf,xf),fy=1.0f-a;fy=fy*K_y_mul;fy=fy+K_y_add;fy=fy*scale;
  float oy=pv*fy;oy=oy+(float)((double)gy-iy);
  float vn=value_noise(xf,yf),ax=a*scale,ox=vn*ax;
  ox=ox+(float)((double)gx-ix);ox=(float)((double)ox+ix);
  oy=(float)((double)iy+oy);*outx=ox;*outy=oy;
}
static inline int wang(float x,float y) {
  int ix=floor_i(x),iy=floor_i(y);
  float fx=(float)((double)x-ix),fy=(float)((double)y-iy);
  if(!(0.5f>smooth(fy)))iy++;
  if(!(0.5f>smooth(fx)))ix++;
  return mval(ix,iy)-1;
}
static inline float bilinear(float x,float y) {
  int ix=floor_i(x),iy=floor_i(y);
  float fx=(float)((double)x-ix),fy=(float)((double)y-iy),sx=smooth(fx);
  float tl=cval(ix,iy+1),bl=cval(ix,iy),br=cval(ix+1,iy),tr=cval(ix+1,iy+1);
  float bottom=lerp(bl,br,sx),top=lerp(tl,tr,sx);
  return lerp(bottom,top,smooth(fy));
}
static inline float coverage_edge(float x,float y) {
  double xp=(double)x+0.5,yp=(double)y+0.5;
  int ix=floor_d(xp),iy=floor_d(yp);
  if(cval(ix,iy)>0.5f)return 1;
  float fx=(float)(xp-ix),fy=(float)(yp-iy),omfx=1.0f-fx;
  int nx,ny;
  if(fx>=fy){if(omfx<=fy){nx=ix+1;ny=iy;}else{nx=ix;ny=iy-1;}}
  else{if(omfx<=fy){nx=ix;ny=iy+1;}else{nx=ix-1;ny=iy;}}
  if(cval(nx,ny)>=0.5f)return 1;
  int sx=ix+(fx>=0.5f?1:-1),sy=iy+(fy>=0.5f?1:-1);
  if(cval(sx,sy)<0.5f)return 0;
  if(cval(sx,iy)>=0.5f)return 1;
  return cval(ix,sy)>=0.5f?1:0;
}
static inline float material_edge(float x,float y) {
  double xp=(double)x+0.5,yp=(double)y+0.5;
  int ix=floor_d(xp),iy=floor_d(yp);
  if(cval(ix,iy)>0.5f)return 1;
  double fx=xp-ix,fy=yp-iy;
  int dx=fx>=fy?1:-1,dy=fx>=fy?-1:1,m=mval(ix,iy);
  if(cval(ix+dx,iy)>=0.5f&&cval(ix,iy+dy)>=0.5f&&mval(ix+dx,iy)==m&&mval(ix,iy+dy)==m)return 1;
  int d=(1.0-fx)>=fy?-1:1;
  return cval(ix+d,iy)>=0.5f&&cval(ix,iy+d)>=0.5f&&mval(ix+d,iy)==m&&mval(ix,iy+d)==m?1:0;
}
static inline float density(double x,double y,float cov) {
  float n1=value_noise((float)(x*K_dens_x),(float)(y*K_dens_y));
  float warp=n1*K_dens_warp,t=(cov-0.5f)*0.5f;
  float sy=((float)y+warp)*K_dens_scale,sx=((float)x+warp)*K_dens_scale;
  float n2=simplex(sx,sy),m=t*t;m=m*K_dens_k1;m=m*K_dens_k2;
  float r=(n2*m)+cov;return 0.5f>r?0.5f:r;
}
static inline void resolve(double x,double y,Result *r) {
  lookup(0,x,y,&r->coord0x,&r->coord0y);r->idx0=wang(r->coord0x,r->coord0y);
  Params p={1.0f,0.5f,0,1};
  if(r->idx0>=1&&r->idx0<param_count&&params[r->idx0].present)p=params[r->idx0];
  lookup(p.scale,x,y,&r->coordx,&r->coordy);
  r->coverage=p.type==1?coverage_edge(r->coordx,r->coordy):p.type==2?material_edge(r->coordx,r->coordy):bilinear(r->coordx,r->coordy);
  r->material=0;r->density=0;
  if(r->coverage<p.threshold){r->status=1;return;}
  int material=wang(r->coordx,r->coordy);
  if(material>=1){r->status=2;r->material=material;return;}
  r->status=3;r->density=density(x,y,r->coverage);
}
EXPORT("resolve_rect") void resolve_rect(double x,double y,int width,int height,uintptr_t dst) {
  Result *out=(Result*)dst;
  for(int row=0;row<height;row++)for(int col=0;col<width;col++)resolve(x+col,y+row,out++);
}
EXPORT("resolve_points") void resolve_points(uintptr_t xy,int count,uintptr_t dst) {
  const double *points=(const double*)xy;Result *out=(Result*)dst;
  for(int i=0;i<count;i++)resolve(points[2*i],points[2*i+1],out+i);
}

#ifdef INCLUDE_BANDS
#include "bands.c"
#endif

#ifdef INCLUDE_OWNERSHIP
#include "ownership.c"
#endif

#ifdef INCLUDE_VERTICAL
#include "vertical.c"
#endif

#include "classifications.h"
#include "topo0.c"
#include "complete.c"
