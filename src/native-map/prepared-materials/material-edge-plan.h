// Seed-independent coordinate preparation for the material-edge sampler.
// Included after the owned topo2 arithmetic; attribution is in materials/NOTICE.txt.
// This is a lookup plan, not final colors or edge decals.
#define MATERIAL_EDGE_PLAN_SCALE 0.33000001311302185f
#define MATERIAL_EDGE_PLAN_INVALID 65535u

static inline void edge_plan_coords(float scale,double x,double y,double plane_y,
                                    double origin_x,int local,float *cx,float *cy) {
  lookup(scale,x,y,cx,cy);
  if(local) {
    double pw=__builtin_floor((x+offx)/(offx*2.0));
    *cx=(float)(((double)*cx-origin_x)-(pw*(offx*2.0))/10.0);
  }
  *cy=(float)((double)*cy-plane_y/10.0);
}

// Bits 0..2/3..5: edge center minus unwarped floor, biased by 2.
// Bits 6/7: the two ordered cross-stencil predicates.
// Bits 8..9/10..11: nearest material minus edge center, biased by 1.
// The nearest lookup is evaluated separately: f32 smoothstep ties must not be
// replaced by a real-number rounding identity.
static inline uint16_t make_material_edge_plan(float zx,float zy,float cx,float cy) {
  int bx=floor_i(zx),by=floor_i(zy);
  double px=(double)cx+.5,py=(double)cy+.5;
  int ix=floor_d(px),iy=floor_d(py);
  double fx=px-ix,fy=py-iy;
  int nx=floor_i(cx),ny=floor_i(cy);
  nx+=!(.5f>smooth((float)((double)cx-nx)));
  ny+=!(.5f>smooth((float)((double)cy-ny)));
  int dx=ix-bx,dy=iy-by,mx=nx-ix,my=ny-iy;
  if(dx < -2 || dx > 2 || dy < -2 || dy > 2 || mx < -1 || mx > 1 || my < -1 || my > 1)
    return MATERIAL_EDGE_PLAN_INVALID;
  return (uint16_t)((dx+2)|((dy+2)<<3)|((fx>=fy)<<6)|(((1.0-fx)>=fy)<<7)|((mx+1)<<8)|((my+1)<<10));
}

EXPORT("material_edge_plan_abi") int material_edge_plan_abi(void) { return 1; }
EXPORT("prepare_material_edge_plan") void prepare_material_edge_plan(
  double x,double y,int width,int height,double xshift,double plane_y,
  double origin_x,int local,uintptr_t dst) {
  uint16_t *out=(uint16_t*)dst;
  double previous=offx;offx=xshift;
  for(int row=0,i=0;row<height;row++)for(int col=0;col<width;col++,i++) {
    float zx,zy,cx,cy;
    edge_plan_coords(0,x+col,y+row,plane_y,origin_x,local,&zx,&zy);
    edge_plan_coords(MATERIAL_EDGE_PLAN_SCALE,x+col,y+row,plane_y,origin_x,local,&cx,&cy);
    out[i]=make_material_edge_plan(zx,zy,cx,cy);
  }
  offx=previous;
}

// Return -1 for an unsupported code. Otherwise preserve exact coverage > .5
// versus >= .5 tests and equality of stored material IDs, including air IDs.
static inline int sample_material_edge_plan(uint16_t code,int bx,int by,int *material) {
  if((code>>12) || (code&7)>4 || ((code>>3)&7)>4 || ((code>>8)&3)>2 || ((code>>10)&3)>2) return -1;
  int ix=bx+(code&7)-2,iy=by+((code>>3)&7)-2,alive=cval(ix,iy)>.5f;
  if(!alive) {
    int dx=(code&64)?1:-1,dy=-dx,m=mval(ix,iy);
    alive=cval(ix+dx,iy)>=.5f&&cval(ix,iy+dy)>=.5f&&mval(ix+dx,iy)==m&&mval(ix,iy+dy)==m;
    if(!alive) {
      int d=(code&128)?-1:1;
      alive=cval(ix+d,iy)>=.5f&&cval(ix,iy+d)>=.5f&&mval(ix+d,iy)==m&&mval(ix,iy+d)==m;
    }
  }
  if(alive)*material=mval(ix+((code>>8)&3)-1,iy+((code>>10)&3)-1)-1;
  return alive;
}

EXPORT("probe_material_edge_plan") void probe_material_edge_plan(
  float zx,float zy,float cx,float cy,uintptr_t dst) {
  int32_t *out=(int32_t*)dst;int material=0;
  out[0]=make_material_edge_plan(zx,zy,cx,cy);
  out[1]=sample_material_edge_plan((uint16_t)out[0],floor_i(zx),floor_i(zy),&material);
  out[2]=material;out[3]=(int)material_edge(cx,cy);out[4]=out[3]?wang(cx,cy):0;
}

static inline uint16_t stencil_field_code(const uint8_t *field,uint32_t index,uint32_t expected) {
  const uint32_t *header=(const uint32_t*)field;
  uint32_t count=header[2],bits=header[3];
  if(header[0]!=0x31505345u||header[1]!=expected||index>=expected||count<1||count>65536||bits>16) return MATERIAL_EDGE_PLAN_INVALID;
  const uint16_t *palette=(const uint16_t*)(field+16);
  if(!bits)return palette[0];
  uint32_t at=index*bits;
  const uint8_t *data=field+16+count*2+(at>>3);
  uint32_t symbol=((data[0]|(data[1]<<8)|(data[2]<<16))>>(at&7))&((1u<<bits)-1);
  return symbol<count?palette[symbol]:MATERIAL_EDGE_PLAN_INVALID;
}

// Common scale-.33 plans have four possible centers, two cross predicates and
// no nearest/center difference. Bind their 16 outcomes once per nominal grid
// cell, then reuse the mask for every pixel/world referring to that cell.
static inline int material_edge_common_index(uint16_t code) {
  if((code&~201u)!=0x512u)return -1;
  return (code&1)|((code>>2)&2)|((code>>4)&12);
}
EXPORT("bind_material_edge_groups") int bind_material_edge_groups(uintptr_t ids,int count,uintptr_t masks) {
  const uint32_t *cells=(const uint32_t*)ids;uint16_t *out=(uint16_t*)masks;
  int eligible=0;
  for(int i=0;i<count;i++) {
    out[i]=0;
    if(gw<=0||gh<=0||cells[i]>=(uint32_t)gw*(uint32_t)gh)continue;
    int bx=cells[i]%gw,by=cells[i]/gw,needed=0;
    for(int corner=0;corner<4;corner++) {
      int id=mval(bx+(corner&1),by+(corner>>1))-1;
      if(id>=1&&id<param_count&&params[id].present) {
        Params p=params[id];
        if(p.scale==MATERIAL_EDGE_PLAN_SCALE&&p.threshold==.5f&&p.type==2)needed=1;
      }
    }
    if(!needed)continue;
    eligible++;
    for(int k=0;k<16;k++) {
      int material=0;
      uint16_t code=(uint16_t)(0x512|(k&1)|((k&2)<<2)|((k&12)<<4));
      if(sample_material_edge_plan(code,bx,by,&material)>0)out[i]|=(uint16_t)(1u<<k);
    }
  }
  return eligible;
}
