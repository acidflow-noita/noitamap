// Scratch extension of the MIT-attributed owned resolver. Source-parity target,
// not a claim that inherited JS modifier grids reproduce all game runtime RNG.
typedef struct { int edge;double start_y,end_y,freq,low,high,slope_x,slope_delta; } Surface;
typedef struct {
  int surface,paints_nothing,noise_type,inside_noise,fbm,squared,clamped,scaled,seed_offset,depth_blend,mod_kind,grid;
  double gradient,perlin,add,scale_x,scale_y,off_x,off_y,scale_min,scale_max,mod_value;
} Topo0;
typedef struct { uint32_t pointer;int width,height;double offset; } Modifier;
_Static_assert(sizeof(Modifier)==24,"Modifier descriptor ABI");
#include "topo0-data.h"
static const Modifier *modifiers;
static double surface_phase,empty_offset;
static int32_t world_seed;
static const float *hash_table;
static const double *cos_prefix,*sin_prefix;
static int hash_min,hash_count,axis_x_min,axis_x_count,axis_y_min,axis_y_count;
static int query_failed;
#define MAX_WIDTH 1024
static double surface_top[SURFACE_COUNT*MAX_WIDTH],surface_bottom[SURFACE_COUNT*MAX_WIDTH];
static int prepared_width;

EXPORT("configure_topo0_immutable") void configure_topo0_immutable(uintptr_t hash,int hmin,int hcount,uintptr_t cosine,int xmin,int xcount,uintptr_t sine,int ymin,int ycount){
  hash_table=(const float*)hash;hash_min=hmin;hash_count=hcount;
  cos_prefix=(const double*)cosine;axis_x_min=xmin;axis_x_count=xcount;
  sin_prefix=(const double*)sine;axis_y_min=ymin;axis_y_count=ycount;
}
EXPORT("configure_topo0_seed") void configure_topo0_seed(double phase,double empty,uint32_t seed,uintptr_t grids){
  surface_phase=phase;empty_offset=empty;world_seed=(int32_t)seed;modifiers=(const Modifier*)grids;
}
static inline float sin_hash(float n){
  int index=(int)n-hash_min;
  if(index<0||index>=hash_count||(float)(int)n!=n){query_failed=CLASS_OUTSIDE_TABLES;return 0;}
  return hash_table[index];
}
static inline float value_sin(float x,float y,int parity){
  int ix=floor_i(x),iy=floor_i(y);
  float fx=x-(float)ix,fy=y-(float)iy,u=smooth(fx),v=smooth(fy);
  if(parity){
    float u0=(ix&1)?fx:u,u1=((ix+1)&1)?fx:u;
    float v0=(iy&1)?fy:v,v1=((iy+1)&1)?fy:v;
    u=((u1-u0)*fx)+u0;v=((v1-v0)*fy)+v0;
  }
  float n=((float)iy*57.0f)+(float)ix;
  float htop=((sin_hash(n+58.0f)-sin_hash(n+57.0f))*u)+sin_hash(n+57.0f);
  float hbot=((sin_hash(n+1.0f)-sin_hash(n))*u)+sin_hash(n);
  return ((htop-hbot)*v)+hbot;
}
static inline float carved(double x,double y,float d,int type){
  const float amp=0.05000000074505806f,gate=0.8500000238418579f,divisor=0.10000000149011612f;
  double noise;
  if(type==0){
    float fx=(float)x,fy=(float)y;
    float v=value_sin(fx*0.02500000037252903f,fy*0.02500000037252903f,1),a=v*amp+amp;
    float sx=a*((fx*0.5f)*0.019999999552965164f),sy=((fy*0.5f)*0.019999999552965164f)*a;
    noise=simplex(sx,sy);
  }else if(type==3){
    float v=value_sin((float)(x*0.02),(float)(y*0.021),0),a=v*amp+amp;
    int ix=(int)(x-0.5)-axis_x_min,iy=(int)(y-0.5)-axis_y_min;
    if(x-0.5!=(int)(x-0.5)||y-0.5!=(int)(y-0.5)||ix<0||ix>=axis_x_count||iy<0||iy>=axis_y_count){query_failed=CLASS_OUTSIDE_TABLES;return 0;}
    noise=edge_simplex(cos_prefix[ix]*(double)a,sin_prefix[iy]*(double)a);
  }else{query_failed=CLASS_UNSUPPORTED_CONFIG;return 0;}
  float cave=(float)(noise*d),t=(d-gate)/divisor;
  return ((cave-d)*t)+d;
}
static inline void surface_line(int id,double x,double *top,double *bottom){
  const Surface *c=surfaces+id;
  if(c->edge==0){*top=c->start_y;*bottom=c->end_y;return;}
  if(c->edge==3){double d=(x-c->slope_x)*c->slope_delta;*top=c->start_y+d;*bottom=c->end_y+d;return;}
  if(c->edge!=1){query_failed=CLASS_UNSUPPORTED_CONFIG;*top=0;*bottom=0;return;}
  double sx=c->freq*(surface_phase+x);
  *top=edge_simplex(sx,c->start_y*c->freq)*c->low+c->start_y;
  *bottom=edge_simplex(sx,c->end_y*c->freq)*c->high+c->end_y;
}
static inline void prepare_surfaces(double x,int width){
  prepared_width=width;
  for(int s=0;s<SURFACE_COUNT;s++)for(int col=0;col<width;col++){
    // Unsupported edge2 records are flagged only if actually selected later.
    if(surfaces[s].edge==2){surface_top[s*MAX_WIDTH+col]=0;surface_bottom[s*MAX_WIDTH+col]=0;continue;}
    surface_line(s,x+col+0.5,&surface_top[s*MAX_WIDTH+col],&surface_bottom[s*MAX_WIDTH+col]);
  }
}
static inline float depth_ratio(int owner,int physical,int left,double x,double y,double subx,int column){
  int chosen=y<=380.0&&physical>=0?physical:owner,s=configs[chosen].surface;
  double top,bottom;
  if(surfaces[s].edge==2){query_failed=CLASS_UNSUPPORTED_CONFIG;return 0;}
  if(column>=0){top=surface_top[s*MAX_WIDTH+column];bottom=surface_bottom[s*MAX_WIDTH+column];}
  else surface_line(s,x,&top,&bottom);
  if(y<=380.0&&left>=0&&subx<42.0){
    s=configs[left].surface;double ltop,lbottom;
    if(surfaces[s].edge==2){query_failed=CLASS_UNSUPPORTED_CONFIG;return 0;}
    if(column>=0){ltop=surface_top[s*MAX_WIDTH+column];lbottom=surface_bottom[s*MAX_WIDTH+column];}
    else surface_line(s,x,&ltop,&lbottom);
    float f=1.0f-(float)(subx/41.0);
    top=(ltop-top)*(double)f+top;bottom=(lbottom-bottom)*(double)f+bottom;
  }
  if(y<=top)return 0;if(bottom<=y||bottom==top)return 1;
  return (float)((y-top)/(bottom-top));
}
static inline float modifier_cell(const Modifier *m,int x,int y){
  return ((const float*)(uintptr_t)m->pointer)[wrap(y,m->height)*m->width+wrap(x,m->width)];
}
static inline float modifier_bilinear(const Modifier *m,float sx,float sy){
  int ix=floor_i(sx),iy=floor_i(sy);double fx=(double)sx-ix,fy=(double)sy-iy;
  float wx=(float)(((3.0-2.0*fx)*fx)*fx),wy=(float)(((3.0-2.0*fy)*fy)*fy);
  float c00=modifier_cell(m,ix,iy),c10=modifier_cell(m,ix+1,iy),c01=modifier_cell(m,ix,iy+1),c11=modifier_cell(m,ix+1,iy+1);
  float top=c00+wx*(c10-c00),bottom=c01+wx*(c11-c01);
  return top+wy*(bottom-top);
}
static inline double density_modifier(const Topo0 *c,double x,double y){
  const float mul=0.10000000149011612f,blend=0.4950000047683716f;
  if(c->mod_kind==0)return 1;
  if(c->mod_kind==3){
    if(c->grid<0){query_failed=CLASS_MISSING_MODIFIER;return 0;}
    const Modifier *g=modifiers+c->grid;
    if(!g->pointer||g->width<=0||g->height<=0){query_failed=CLASS_MISSING_MODIFIER;return 0;}
    float gx=(float)(x*0.49162514+g->offset)*mul;
    float gy=(float)(g->offset*6.86035959282328e-7+y*0.49162514)*mul;
    float m=modifier_bilinear(g,gx,gy);
    if(m<1.0f){float noise=(float)edge_simplex(gx,gy),weight=(1.0f-m)*blend;m=(float)((double)m+(double)noise*weight);}
    return m>0?m:0;
  }
  double m=c->mod_kind==2?0:c->mod_value;
  if(c->mod_kind==1&&!(m<1))return m>0?m:0;
  if(c->mod_kind!=1&&c->mod_kind!=2){query_failed=CLASS_UNSUPPORTED_CONFIG;return 0;}
  double off=c->mod_kind==2?empty_offset:0;
  float gx=(float)((x*0.49162514+off)*(double)mul),gy=(float)((off*6.86e-7+y*0.49162514)*(double)mul);
  float noise=(float)edge_simplex(gx,gy),weight=(float)(1.0-m),term=(noise*weight)*blend;
  m=(float)(m+term);return m>0?m:0;
}
static inline float base_material_noise(float x,float y,int type){
  if(type==5)return (float)edge_simplex(x,y);
  if(type==8)return simplex(x,y);
  query_failed=CLASS_UNSUPPORTED_CONFIG;return 0;
}
static inline float fbm4(float x,float y,int type){
  const float m0=0.84147f,m1=0.5403f;
  float acc=base_material_noise(x,y,type)*0.5f;
  float u=((m0*x)+(m1*y))*2.02f,v=((m1*x)+(-m0*y))*2.02f;
  acc=acc+base_material_noise(u,v,type)*0.25f;
  float u2=((m0*u)+(m1*v))*2.33f,v2=((m1*u)+(-m0*v))*2.33f;
  acc=acc+base_material_noise(u2,v2,type)*0.125f;
  float u3=((m0*u2)+(m1*v2))*2.01f,v3=((m1*u2)+(-m0*v2))*2.01f;
  acc=acc+base_material_noise(u3,v3,type)*0.0625f;return acc/0.9375f;
}
static inline double material_noise(const Topo0 *c,double x,double y){
  double sx=(x*0.05243442)*c->scale_x+0.1+c->off_x,sy=(y*0.05243442)*c->scale_y+0.1+c->off_y;
  if(c->seed_offset){sx+=(double)world_seed*1.312e-05;sy+=(double)world_seed*2.331e-05;}
  float fx=(float)sx,fy=(float)sy;
  double n=c->fbm?fbm4(fx,fy,c->inside_noise):base_material_noise(fx,fy,c->inside_noise);
  if(c->squared)n=(float)(n*n);
  if(c->clamped){if(n<c->scale_min)n=c->scale_min;if(n>c->scale_max)n=c->scale_max;}
  if(c->scaled){float a=(float)(c->scale_max-c->scale_min),b=(float)((float)(n*0.5)+0.5f);n=(float)((double)(a*b)+c->scale_min);}
  return n;
}
static inline float cave_material(int id,int physical,int left,double x,double y,double subx,int column){
  const Topo0 *c=configs+id;double modifier=density_modifier(c,x,y);
  if(!(modifier>0))return 0;
  float ratio=depth_ratio(id,physical,left,x,y,subx,column),d=(float)(ratio*modifier);
  if(d<=0)return 0;
  float weight=0;double noise=0;
  if(0.5099999904632568f<d&&c->perlin!=0){weight=(d-0.5f)*2.0f;noise=material_noise(c,x,y);}
  double add=0;
  if(d>0.8500000238418579f){add=c->add;d=carved(x,y,d,c->noise_type);}
  if(c->depth_blend){query_failed=CLASS_UNSUPPORTED_CONFIG;return 0;}
  float first=(float)((double)(float)(c->perlin*weight)*noise),second=(float)(c->gradient*d);
  return (float)((double)(first+second)+add);
}
static inline int full_material(double x,double y,double cosine,double sine,int column){
  int cell=owner_cell(x,y,cosine,sine,0),id=chunk_biome[cell];
  if(id<0||!biomes[id].supported)return -1;
  query_failed=0;
  if(biomes[id].topology==2){
    if(!chunk_covered[cell])return -1;
#if MATERIAL_ONLY
    return resolve_material_only(id,x,y);
#else
    Result r;resolve(x,y,&r);int result=r.status==1?0:r.status==2?r.material:select_band(id,x,y,r.density);return result<0?0:result;
#endif
  }
  if(configs[id].paints_nothing||biomes[id].count==0)return 0;
  double sx=x+map_width*256.0;int px=((int)sx)>>9,py=((int)(y+7168.0))>>9;
  int physical=chunk_biome[cell_at(px,py)],left=chunk_biome[cell_at(px-1,py)];
  double subx=sx-(double)floor_d(sx/512.0)*512.0;
  float density=cave_material(id,physical,left,x+0.5,y+0.5,subx,column);
  if(query_failed)return -1;int material=select_band(id,x,y,density);return material<0?0:material;
}
EXPORT("resolve_full_rect") void resolve_full_rect(double x,double y,int width,int height,uintptr_t cos_ptr,uintptr_t sin_ptr,uintptr_t dst){
  const double *cosine=(const double*)cos_ptr,*sine=(const double*)sin_ptr;int32_t *out=(int32_t*)dst;
  if(width>MAX_WIDTH)return;
  prepare_surfaces(x,width);
  for(int row=0,i=0;row<height;row++)for(int col=0;col<width;col++,i++)out[i]=full_material(x+col,y+row,cosine[col],sine[row],col);
}
typedef struct {int32_t material,failed;double modifier;float depth,noise,density,padding;} Probe;
EXPORT("probe_topo0") void probe_topo0(uintptr_t points,int count,uintptr_t dst){
  const double *p=(const double*)points;Probe *out=(Probe*)dst;
  for(int i=0;i<count;i++,p+=6){int id=(int)p[0],physical=(int)p[3],left=(int)p[4];double x=p[1]+0.5,y=p[2]+0.5;query_failed=0;
    out[i].modifier=density_modifier(configs+id,x,y);out[i].depth=depth_ratio(id,physical,left,x,y,p[5],-1);
    out[i].noise=(float)material_noise(configs+id,x,y);out[i].density=cave_material(id,physical,left,x,y,p[5],-1);
    out[i].failed=query_failed;out[i].material=query_failed?-1:select_band(id,p[1],p[2],out[i].density);out[i].padding=0;
  }
}

EXPORT("resolve_full_cpu_rect") void resolve_full_cpu_rect(double x,double y,int width,int height,uintptr_t cos_ptr,uintptr_t sin_ptr,uintptr_t dst){
  const double *cosine=(const double*)cos_ptr,*sine=(const double*)sin_ptr;int32_t *out=(int32_t*)dst;
  if(width>MAX_WIDTH)return;
  prepare_surfaces(x,width);
  for(int row=0,i=0;row<height;row++)for(int col=0;col<width;col++,i++){
    double wx=x+col,wy=y+row;
    if(wy < -7168.0 || wy >= 17408.0){out[i]=0;continue;}
    int cell=owner_cell(wx,wy,cosine[col],sine[row],1);uint32_t flags=host_chunks[cell];
    if(flags&2048){out[i]=0;continue;}if(((flags>>8)&3)==2){out[i]=-1;continue;}
    out[i]=full_material(wx,wy,cosine[col],sine[row],col);
  }
}
