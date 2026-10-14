// Derived from Lymm's Telescope (MIT); see LICENSE-telescope.txt and NOTICE.txt.
// Biome ownership. Trig axis arrays preserve host Math.sin/Math.cos
// results while requiring O(width+height) preparation, never per-pixel calls.
static int map_width;
static const uint32_t *biome_map;
static const uint8_t *chunk_covered;
static int32_t *chunk_biome;
static const uint32_t *host_chunks;

EXPORT("configure_world") void configure_world(uintptr_t colors,int width,
                                               uintptr_t covered,uintptr_t ids){
  map_width=width;biome_map=(const uint32_t*)colors;
  chunk_covered=(const uint8_t*)covered;chunk_biome=(int32_t*)ids;
  offx=width*256.0;
  for(int cell=0;cell<width*48;cell++){
    uint32_t color=biome_map[cell]&0xffffff;int found=-1;
    // Last matching color wins, as in the reference's Map construction.
    for(int b=0;b<BIOME_COUNT;b++)if(biomes[b].color==color)found=b;
    chunk_biome[cell]=found;
  }
}
static inline int cell_at(int x,int y){
  int row=y<0?0:y>47?47:y;return row*map_width+wrap(x,map_width);
}
static inline int has_edge_noise(int cell,int host_policy){
  int id=chunk_biome[cell];return id<0?!host_policy:biomes[id].edge_noise;
}
static inline int probe_cell(int x,int y,uint32_t original,int *candidate){
  int cell=cell_at(x,y);
  if((biome_map[cell]&0xffffff)==original)return 0;
  *candidate=cell;return 1;
}
static inline int owner_cell(double x,double y,double cos_axis,double sin_axis,int host_policy){
  double sx=x+map_width*256.0,sy=y+7168.0;
  int fx=(int)sx,fy=(int)sy,cx=fx>>9,cy=fy>>9;
  int original=cell_at(cx,cy);
  if(!has_edge_noise(original,host_policy))return original;
  int subx=fx&511,suby=fy&511;
  if(subx>=42&&suby>=42&&subx<=470&&suby<=470)return original;
  uint32_t color=biome_map[original]&0xffffff;
  int neighbor=-1;
  int hit=(subx<42&&probe_cell(cx-1,cy,color,&neighbor))||
          (suby<42&&probe_cell(cx,cy-1,color,&neighbor))||
          (subx>470&&probe_cell(cx+1,cy,color,&neighbor))||
          (suby>470&&probe_cell(cx,cy+1,color,&neighbor))||
          (subx<42&&((suby<42&&probe_cell(cx-1,cy-1,color,&neighbor))||
                      (suby>470&&probe_cell(cx-1,cy+1,color,&neighbor))))||
          (subx>470&&((suby<42&&probe_cell(cx+1,cy-1,color,&neighbor))||
                       (suby>470&&probe_cell(cx+1,cy+1,color,&neighbor))));
  if(!hit||!has_edge_noise(neighbor,host_policy))return original;
  double noise=edge_simplex(sx*0.05,sy*0.05);
  double col=sin_axis*30.0+noise*11.0,row=cos_axis*30.0+noise*11.0;
  int result=cell_at(((int)(col+sx))>>9,((int)(row+sy))>>9);
  return has_edge_noise(result,host_policy)?result:original;
}
// Values outside the supported, covered topology2 path are -1, never air.
EXPORT("resolve_owned_rect") void resolve_owned_rect(double x,double y,int width,int height,
                                                      uintptr_t cos_ptr,uintptr_t sin_ptr,uintptr_t dst){
  const double *cos_axis=(const double*)cos_ptr,*sin_axis=(const double*)sin_ptr;
  int32_t *out=(int32_t*)dst;
  for(int row=0,i=0;row<height;row++)for(int col=0;col<width;col++,i++){
    double wx=x+col,wy=y+row;int cell=owner_cell(wx,wy,cos_axis[col],sin_axis[row],0),id=chunk_biome[cell];
    if(id<0||!biomes[id].supported||biomes[id].topology!=2||!chunk_covered[cell]){out[i]=-1;continue;}
    Result r;resolve(wx,wy,&r);
    int material=r.status==1?0:r.status==2?r.material:select_band(id,wx,wy,r.density);
    out[i]=material<0?0:material;
  }
}
EXPORT("resolve_owner_cells") void resolve_owner_cells(double x,double y,int width,int height,
                                                        uintptr_t cos_ptr,uintptr_t sin_ptr,uintptr_t dst){
  const double *cos_axis=(const double*)cos_ptr,*sin_axis=(const double*)sin_ptr;
  int32_t *out=(int32_t*)dst;
  for(int row=0,i=0;row<height;row++)for(int col=0;col<width;col++,i++)out[i]=owner_cell(x+col,y+row,cos_axis[col],sin_axis[row],0);
}

// Preserve cpu-terrain-core's pre-resolver policy. Unknown biome colors are
// non-noisy for this guard, whereas the underlying Telescope field treats them
// as noisy. The two lookups must not be conflated at unknown-color boundaries.
EXPORT("configure_host_chunks") void configure_host_chunks(uintptr_t chunks){host_chunks=(const uint32_t*)chunks;}
EXPORT("abi_version") int abi_version(void){return 3;}
EXPORT("resolve_cpu_rect") void resolve_cpu_rect(double x,double y,int width,int height,
                                                 uintptr_t cos_ptr,uintptr_t sin_ptr,uintptr_t dst){
  const double *cos_axis=(const double*)cos_ptr,*sin_axis=(const double*)sin_ptr;
  int32_t *out=(int32_t*)dst;
  for(int row=0,i=0;row<height;row++)for(int col=0;col<width;col++,i++){
    double wx=x+col,wy=y+row;
    if(wy < -7168.0 || wy >= 17408.0){out[i]=0;continue;}
    int guard=owner_cell(wx,wy,cos_axis[col],sin_axis[row],1);
    uint32_t flags=host_chunks[guard];
    if(flags&2048){out[i]=0;continue;}
    if(((flags>>8)&3)==2){out[i]=-1;continue;}
    int cell=owner_cell(wx,wy,cos_axis[col],sin_axis[row],0),id=chunk_biome[cell];
    if(id<0||!biomes[id].supported||biomes[id].topology!=2||!chunk_covered[cell]){out[i]=-1;continue;}
    Result r;resolve(wx,wy,&r);
    int material=r.status==1?0:r.status==2?r.material:select_band(id,wx,wy,r.density);
    out[i]=material<0?0:material;
  }
}
