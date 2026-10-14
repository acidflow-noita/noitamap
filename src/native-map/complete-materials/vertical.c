// Derived from Telescope (MIT); see LICENSE-telescope.txt and NOTICE.txt.
// Exact createPlaneMaterialField port. Absolute coordinates enter noise/bands;
// only the returned f32 lattice coordinates are translated into local storage.
static double plane_offset_y,region_origin_x,plane_limit_offset;
static int has_region_origin;
EXPORT("configure_vertical") void configure_vertical(double offset_y,double origin_x,int has_origin,double limit_offset){
  plane_offset_y=offset_y;region_origin_x=origin_x;has_region_origin=has_origin;plane_limit_offset=limit_offset;
}
static inline void vertical_coords(float scale,double x,double y,float *cx,float *cy){
  lookup(scale,x,y,cx,cy);
  if(has_region_origin){
    double pw=__builtin_floor((x+map_width*256.0)/(map_width*512.0));
    *cx=(float)(((double)*cx-region_origin_x)-((pw*map_width)*512.0)/10.0);
  }
  *cy=(float)((double)*cy-plane_offset_y/10.0);
}
static inline int vertical_material(double x,double y,double cosine,double sine){
  int cell=owner_cell(x,y,cosine,sine,0),id=chunk_biome[cell];
  // Deliberately no chunkCovered guard: the TS plane/local-grid helper has none.
  if(id<0||!biomes[id].supported||biomes[id].topology!=2)return -1;
  float zx,zy,cx,cy;vertical_coords(0,x,y,&zx,&zy);int idx=wang(zx,zy);
  Params p={1.0f,0.5f,0,1};if(idx>=1&&idx<param_count&&params[idx].present)p=params[idx];
  vertical_coords(p.scale,x,y,&cx,&cy);
  float cov=p.type==1?coverage_edge(cx,cy):p.type==2?material_edge(cx,cy):bilinear(cx,cy);
  if(cov<p.threshold)return 0;
  int direct=wang(cx,cy);if(direct>=1)return direct;
  int material=select_band(id,x,y,density(x,y,cov));return material<0?0:material;
}
EXPORT("resolve_vertical_rect") void resolve_vertical_rect(double x,double y,int width,int height,uintptr_t cos_ptr,uintptr_t sin_ptr,uintptr_t dst){
  const double *cosine=(const double*)cos_ptr,*sine=(const double*)sin_ptr;int32_t *out=(int32_t*)dst;
  for(int row=0,i=0;row<height;row++)for(int col=0;col<width;col++,i++)out[i]=vertical_material(x+col,y+row,cosine[col],sine[row]);
}
EXPORT("resolve_vertical_cpu_rect") void resolve_vertical_cpu_rect(double x,double y,int width,int height,uintptr_t cos_ptr,uintptr_t sin_ptr,uintptr_t dst){
  const double *cosine=(const double*)cos_ptr,*sine=(const double*)sin_ptr;int32_t *out=(int32_t*)dst;
  for(int row=0,i=0;row<height;row++)for(int col=0;col<width;col++,i++){
    double wx=x+col,wy=y+row,local_y=wy-plane_limit_offset;
    if(local_y < -7168.0 || local_y >= 17408.0){out[i]=0;continue;}
    int guard=owner_cell(wx,wy,cosine[col],sine[row],1);uint32_t flags=host_chunks[guard];
    if(flags&2048){out[i]=0;continue;}if(((flags>>8)&3)==2){out[i]=-1;continue;}
    out[i]=vertical_material(wx,wy,cosine[col],sine[row]);
  }
}
