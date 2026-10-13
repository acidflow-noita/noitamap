typedef struct {
  int32_t material,limit_y,add_perlin,rare,perlin,polka,boxed;
  double min,max,ymin,ymax,addx,addy,sx,sy,ox,oy,plo,phi,prob,rmin,rmax;
} Band;
// Derived from Lymm's Telescope (MIT); see LICENSE-telescope.txt and NOTICE.txt.
typedef struct { double min,max;int32_t start,count,topology,supported,edge_noise;uint32_t color; } Biome;
#include "bands-data.h"

static const int8_t edge_gx[12]={1,-1,1,-1,1,-1,1,-1,0,0,0,0};
static const int8_t edge_gy[12]={1,1,-1,-1,0,0,0,0,1,-1,1,-1};
static inline double edge_corner(double x,double y,int g){
  double t=(0.5-x*x)-y*y;
  if(t<0.0)return 0;
  double n=(edge_gy[g]*y)+(edge_gx[g]*x);
  n=n*t;n=n*t;n=n*t;return n*t;
}
static inline double edge_simplex(double x,double y){
  const double f2=0.3660254037844386,g2=0.21132486540518713;
  double s=(x+y)*f2;int ix=floor_d(s+x),iy=floor_d(s+y);
  double t=(ix+iy)*g2,dx=x-(ix-t),dy=y-(iy-t);
  int sx=dy<dx?1:0,sy=dx<=dy?1:0,ii=ix&255,jj=iy&255;
  double x1=(dx-sx)+g2,y1=(dy-sy)+g2;
  double x2=(dx-1.0)+g2*2.0,y2=(dy-1.0)+g2*2.0;
  double n0=edge_corner(dx,dy,classic[classic[jj]+ii]%12);
  double n1=edge_corner(x1,y1,classic[classic[jj+sy]+ii+sx]%12);
  double n2=edge_corner(x2,y2,classic[classic[jj+1]+ii+1]%12);
  return ((n1+n0)+n2)*70.0;
}
static inline float frac(float x){return (float)((double)x-floor_i(x));}
static inline float polka_base(float x,float y){
  int ix=floor_i(x*BAND_INV71),iy=floor_i(y*BAND_INV71);
  float a=(x-((float)ix*71.0f))+26.0f,b=(y-((float)iy*71.0f))+161.0f;
  return (b*b)*(a*a);
}
static inline float rare_polka(float x,float y,const Band *r){
  int ix=floor_i(x),iy=floor_i(y);
  float base=polka_base((float)ix,(float)iy);
  if(r->prob<=frac(base*BAND_SCALAR))return 0;
  float fx=(float)((double)x-ix),fy=(float)((double)y-iy);
  float h0=frac(base*BAND_V0);
  float h1=frac(base*BAND_V1);
  float h2=frac(base*BAND_V2);
  float radius=(float)((double)((float)(r->phi-r->plo)*h2)+r->plo);
  if(!(radius>0))return 0;
  float s=2.0f/radius,sm1=s-1.0f,sm2=s-2.0f;
  float dy=(sm2*h1)+((fy*s)-sm1),dx=(sm2*h0)+((fx*s)-sm1);
  dy=dy*dy;dx=dx*dx;
  float d;
  if(r->boxed){d=(dy*dy)+(dx*dx);if(d>1)return 0;}
  else{d=dy+dx;if(d>=1)d=1;}
  float u=1.0f-d;return (u*u)*u;
}
static inline int select_band(int id,double x,double y,float density){
  if(id<0||id>=BIOME_COUNT)return -1;
  const Biome *biome=biomes+id;
  if(!(biome->min<=density&&density<=biome->max))return -1;
  float fx=(float)x,fy=(float)y;
  for(int i=0;i<biome->count;i++){
    const Band *c=bands+biome->start+i;
    if(c->limit_y&&!(c->ymin<=fy&&fy<=c->ymax))continue;
    float n=density;
    if(c->add_perlin)n=(float)edge_simplex((float)(fx*c->addx),(float)(fy*c->addy))+density;
    if(!(c->min<=n&&n<c->max))continue;
    if(!c->rare)return c->material;
    float rx=(float)((double)(float)(fx*c->sx)+c->ox),ry=(float)((double)(float)(fy*c->sy)+c->oy);
    if(c->perlin){float p=(float)edge_simplex(rx,ry);if(!(c->rmin<p&&p<=c->rmax))continue;}
    if(!c->polka)return c->material;
    float k=rare_polka(rx,ry,c);
    if(c->rmin<k&&k<=c->rmax)return c->material;
  }
  return -1;
}
EXPORT("select_band_points") void select_band_points(uintptr_t xyz,uintptr_t ids,int count,uintptr_t dst){
  const double *points=(const double*)xyz;const int32_t *biome=(const int32_t*)ids;int32_t *out=(int32_t*)dst;
  for(int i=0;i<count;i++)out[i]=select_band(biome[i],points[3*i],points[3*i+1],(float)points[3*i+2]);
}
EXPORT("resolve_banded_rect") void resolve_banded_rect(double x,double y,int width,int height,uintptr_t ids,uintptr_t dst){
  const int32_t *biome=(const int32_t*)ids;int32_t *out=(int32_t*)dst;
  for(int row=0,i=0;row<height;row++)for(int col=0;col<width;col++,i++){
    Result r;resolve(x+col,y+row,&r);
    int material=r.status==1?0:r.status==2?r.material:select_band(biome[i],x+col,y+row,r.density);
    out[i]=material<0?0:material;
  }
}
