// Complete owned material dispatch. Arithmetic stays in the proven scalar
// kernels; this layer exposes the CPU host policy and unresolved reasons.
// mode 0: main plane, 1: vertical plane, 2: local shaft (before host guards).
EXPORT("resolve_complete_rect") void resolve_complete_rect(
  double x,double y,int width,int height,int mode,uintptr_t cos_ptr,
  uintptr_t sin_ptr,uintptr_t dst,uintptr_t classes,uintptr_t owners,
  uintptr_t guards){
  const double *cosine=(const double*)cos_ptr,*sine=(const double*)sin_ptr;
  int32_t *out=(int32_t*)dst,*owner_out=(int32_t*)owners,*guard_out=(int32_t*)guards;
  uint8_t *status=(uint8_t*)classes;
  if(mode==0)prepare_surfaces(x,width);
  for(int row=0,i=0;row<height;row++)for(int col=0;col<width;col++,i++){
    double wx=x+col,wy=y+row,local_y=wy-(mode?plane_limit_offset:0);
    out[i]=-1;owner_out[i]=-1;guard_out[i]=-1;
    if(local_y < -7168.0 || local_y >= 17408.0){
      out[i]=0;status[i]=CLASS_OUTSIDE_PLANE;continue;
    }
    int guard=owner_cell(wx,wy,cosine[col],sine[row],1);
    int cell=owner_cell(wx,wy,cosine[col],sine[row],0);
    owner_out[i]=cell;guard_out[i]=guard;
    if(mode!=2){
      uint32_t flags=host_chunks[guard];
      if(flags&2048){out[i]=0;status[i]=CLASS_FORCE_AIR;continue;}
      if(((flags>>8)&3)==2){status[i]=CLASS_LEGACY;continue;}
    }
    int id=chunk_biome[cell];
    if(id<0){status[i]=CLASS_UNKNOWN_BIOME;continue;}
    if(!biomes[id].supported){status[i]=CLASS_RAW_BIOME;continue;}
    int topology=biomes[id].topology;
    if((mode&&topology!=2)||(!mode&&topology!=0&&topology!=2)){
      status[i]=CLASS_UNSUPPORTED_TOPOLOGY;continue;
    }
    if(!mode&&topology==2&&!chunk_covered[cell]){
      status[i]=CLASS_UNOWNED;continue;
    }
    query_failed=0;
    int material=mode?vertical_material(wx,wy,cosine[col],sine[row]):
      full_material(wx,wy,cosine[col],sine[row],col);
    if(query_failed){status[i]=(uint8_t)query_failed;continue;}
    if(material<0){status[i]=CLASS_UNSUPPORTED_CONFIG;continue;}
    out[i]=material;status[i]=CLASS_RESOLVED;
  }
}

// Per-placement scene bands use the same scalar density noise as topology2.
// Unlike a full field query, a selector's no-match remains -1 for its caller.
EXPORT("resolve_coverage_band_points") void resolve_coverage_band_points(
  uintptr_t xyz,uintptr_t ids,int count,uintptr_t dst){
  const double *points=(const double*)xyz;const int32_t *biome=(const int32_t*)ids;
  int32_t *out=(int32_t*)dst;
  for(int i=0;i<count;i++)out[i]=select_band(biome[i],points[3*i],points[3*i+1],
    density(points[3*i],points[3*i+1],(float)points[3*i+2]));
}
EXPORT("compute_density_points") void compute_density_points(uintptr_t xyz,int count,uintptr_t dst){
  const double *points=(const double*)xyz;float *out=(float*)dst;
  for(int i=0;i<count;i++)out[i]=density(points[3*i],points[3*i+1],(float)points[3*i+2]);
}
