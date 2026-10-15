#define INCLUDE_BANDS
#define INCLUDE_OWNERSHIP
#define INCLUDE_VERTICAL
#include "../../complete-materials/topo2.c"
_Static_assert(sizeof(Topo0)==128,"Readonly cave config ABI");
_Static_assert(sizeof(Surface)==64,"Readonly cave surface ABI");

typedef struct {int32_t width,height;uint32_t coverage,materials;double offset_y,origin_x;int32_t shaft,pad;} CorrectionGrid;
_Static_assert(sizeof(CorrectionGrid)==40,"Correction grid ABI");
static const CorrectionGrid *correction_grids;
static const uint32_t *correction_columns;
static int correction_vertical;
static double correction_limit;
EXPORT("configure_correction_grids") void configure_correction_grids(uintptr_t grids,uintptr_t columns,int vertical,double limit){
 correction_grids=(const CorrectionGrid*)grids;correction_columns=(const uint32_t*)columns;correction_vertical=vertical;correction_limit=limit;
}
static inline const CorrectionGrid *correction_grid(double x){
 int physical=floor_d((x+map_width*256.0)/512.0);
 return correction_grids+correction_columns[wrap(physical,map_width)];
}
static inline void correction_select(const CorrectionGrid*g){
 gw=g->width;gh=g->height;coverage=(const float*)(uintptr_t)g->coverage;materials=(const uint16_t*)(uintptr_t)g->materials;
 if(correction_vertical)configure_vertical(g->offset_y,g->origin_x,g->shaft,correction_limit);
}
EXPORT("correction_topo0_configs") uintptr_t correction_topo0_configs(void){return (uintptr_t)configs;}
EXPORT("correction_topo0_surfaces") uintptr_t correction_topo0_surfaces(void){return (uintptr_t)surfaces;}
EXPORT("correction_topo0_config_count") int correction_topo0_config_count(void){return BIOME_COUNT;}
EXPORT("correction_topo0_surface_count") int correction_topo0_surface_count(void){return SURFACE_COUNT;}
EXPORT("prepare_correction_surfaces") void prepare_correction_surfaces(double x,int width,uintptr_t dst){
 double*out=(double*)dst;prepare_surfaces(x,width);
 for(int s=0;s<SURFACE_COUNT;s++)for(int i=0;i<width;i++){*out++=surface_top[s*MAX_WIDTH+i];*out++=surface_bottom[s*MAX_WIDTH+i];}
}

// Scratch batch wrapper only: the numerical scalar implementation is included
// unchanged. Rect-local columns preserve the existing prepared surface cache.
// Output record: local pixel index, material, classification, original owner.
EXPORT("correct_indices") void correct_indices(double x,double y,int width,int height,
 uintptr_t index_ptr,int count,uintptr_t cos_ptr,uintptr_t sin_ptr,uintptr_t output_ptr){
 const uint32_t*indices=(const uint32_t*)index_ptr;const double*cosine=(const double*)cos_ptr,*sine=(const double*)sin_ptr;int32_t*out=(int32_t*)output_ptr;
 int needs_surfaces=0;
 for(int k=0;k<count;k++){
  uint32_t index=indices[k];int col=index%width,row=index/width;double wx=x+col,wy=y+row;int32_t*r=out+k*4;r[0]=index;r[1]=-1;r[2]=CLASS_RESOLVED;r[3]=-1;
  if(index>=(uint32_t)width*(uint32_t)height)__builtin_trap();
  double local_y=wy-correction_limit;
  if(local_y< -7168.0||local_y>=17408.0){r[1]=0;r[2]=CLASS_OUTSIDE_PLANE;continue;}
  const CorrectionGrid*g=correction_grid(wx);int shaft=correction_vertical&&g->shaft;
  int guard=owner_cell(wx,wy,cosine[col],sine[row],1),owner=owner_cell(wx,wy,cosine[col],sine[row],0);r[3]=owner;
  uint32_t flags=host_chunks[guard];if(!shaft&&(flags&2048)){r[1]=0;r[2]=CLASS_FORCE_AIR;continue;}if(!shaft&&((flags>>8)&3)==2){r[2]=CLASS_LEGACY;continue;}
  int id=chunk_biome[owner];if(id<0){r[2]=CLASS_UNKNOWN_BIOME;continue;}if(!biomes[id].supported){r[2]=CLASS_RAW_BIOME;continue;}
  if((correction_vertical&&biomes[id].topology!=2)||(!correction_vertical&&biomes[id].topology!=0&&biomes[id].topology!=2)){r[2]=CLASS_UNSUPPORTED_TOPOLOGY;continue;}
  if(!correction_vertical&&biomes[id].topology==2&&!chunk_covered[owner]){r[2]=CLASS_UNOWNED;continue;}
  if(biomes[id].topology==0)needs_surfaces=1;
 }
 if(needs_surfaces)prepare_surfaces(x,width);
 for(int k=0;k<count;k++){
  int32_t*r=out+k*4;if(r[2]!=CLASS_RESOLVED)continue;int col=r[0]%width,row=r[0]/width;
  correction_select(correction_grid(x+col));query_failed=0;
  int m=correction_vertical?vertical_material(x+col,y+row,cosine[col],sine[row]):full_material(x+col,y+row,cosine[col],sine[row],col);
  if(query_failed){r[2]=query_failed;continue;}if(m<0){r[2]=CLASS_UNSUPPORTED_CONFIG;continue;}r[1]=m;
 }
}
