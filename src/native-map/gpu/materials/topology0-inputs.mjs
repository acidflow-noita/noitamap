import{axisKey}from'./axis-cache.mjs';
// Typed data is read from the unchanged C structures by exact-corrector.ts.
// Per-rectangle arrays contain separable coordinates and exact surface axes,
// never rendered pixels. The original finite hash and modifier grids are shared.
const storage=new ArrayBuffer(4),fv=new Float32Array(storage),uv=new Uint32Array(storage),F=Math.fround;
const bits=x=>{fv[0]=x;return uv[0];},value=x=>{uv[0]=x;return fv[0];};
const bounds=x=>{const b=bits(x),f=fv[0];return[f>x?(f>0?b-1:b+1)>>>0:b,f<x?(f>=0?b+1:b-1)>>>0:b];};
const keys=['$biome_desert','$biome_pyramid','$biome_winter','_EMPTY_'];
export function packCaveTables(base,cave){
 if(!cave.seedData)return base;
 const configs=new Uint32Array(cave.configRows.length*36),modifiers=new Uint32Array(16),surfaces=Uint32Array.from(cave.surfaceRows.map(s=>s.edge)),parts=[];
 cave.configRows.forEach((r,i)=>{configs.set(r.integers,i*36);r.values.forEach((v,j)=>configs.set(bounds(v),i*36+12+j*2));configs[i*36+32]=bits(r.values[8]-r.values[7]);});
 const headerAt=base.length,configAt=headerAt+8,modifierAt=configAt+configs.length,surfaceAt=modifierAt+modifiers.length;let cursor=surfaceAt+surfaces.length;
 for(let i=0;i<keys.length;i++){const g=cave.seedData.modifiers[keys[i]];if(!g)continue;modifiers.set([cursor,g.W,g.H,1],i*4);const words=new Uint32Array(g.data.buffer,g.data.byteOffset,g.data.length);parts.push(words);cursor+=words.length;}
 const hashAt=cursor,hash=cave.tables?.hash??new Float32Array(0);cursor+=hash.length;
 const data=new Uint32Array(cursor);data.set(base);data[13]=headerAt;data.set([configAt,cave.configRows.length,modifierAt,4,hashAt,cave.tables?.hashMin??0,hash.length,surfaceAt],headerAt);data.set(configs,configAt);data.set(modifiers,modifierAt);data.set(surfaces,surfaceAt);cursor=surfaceAt+surfaces.length;for(const part of parts){data.set(part,cursor);cursor+=part.length;}data.set(new Uint32Array(hash.buffer,hash.byteOffset,hash.length),hashAt);return data;
}
export function makeCaveAxes(cave,ids,{x,y,width,height},baseOffset,axisVectors=/** @type {any} */(null)){
 if(!cave.seedData)return{data:new Uint32Array(0),headerAt:0,families:0};
 const state=(key,make)=>axisVectors?axisVectors.state(key,make):make();
 const header=new Uint32Array(4),configAxes=new Uint32Array(cave.configRows.length*2),surfaceWords=state(axisKey('surfaces',x,width),()=>{const surface=cave.prepareSurfaceAxes(x,width),words=new Uint32Array(surface.length*2);for(let i=0;i<surface.length;i++)words.set(bounds(surface[i]),i*2);return words;});
 const carve=(out,length,origin,isX)=>{const table=isX?cave.tables.cosine:cave.tables.sine,minimum=isX?cave.tables.xMin:cave.tables.yMin;for(let i=0;i<length;i++){
  const raw=origin+i+.5,f=F(raw),prefix=table[origin+i-minimum],subx=((origin+i+17920)%512+512)%512;
  let prefixBounds=prefix===undefined?[0x7fc00000,0x7fc00000]:bounds(prefix);
  if(prefixBounds.some(b=>{const m=b&0x7fffffff;return m!==0&&m<0x00800000;}))prefixBounds=[0x7fc00000,0x7fc00000];
  out.set([bits(raw*(isX?.02:.021)),bits(F(f*F(.025))),bits(F(F(f*.5)*F(.02))),...prefixBounds,bits(F(1-F(subx/41)))],i*6);
 }};
 const carveVector=(length,origin,isX)=>state(axisKey('carve',isX,origin,length),()=>{const words=new Uint32Array(length*6);carve(words,length,origin,isX);return words;});
 const carveX=carveVector(width,x,true),carveY=carveVector(height,y,false);
 header[0]=baseOffset+4;header[1]=header[0]+configAxes.length;header[2]=header[1]+surfaceWords.length;header[3]=header[2]+carveX.length;
 let cursor=header[3]+carveY.length;const chunks=[header,configAxes,surfaceWords,carveX,carveY],cache=new Map();
 for(const id of ids){const r=cave.configRows[id],k=r.integers,v=r.values;if(k[1])continue;
  const kind=k[10],g=k[11]>=0?cave.seedData.modifiers[keys[k[11]]]:null,off=kind===2?cave.seedData.bitmapNoiseOffset:kind===3?g?.node94??0:0;
  const key=JSON.stringify([v[3],v[4],v[5],v[6],k[8],kind,off]);let pair=cache.get(key);
  if(!pair){const make=(length,origin,isX)=>{const words=new Uint32Array(length*2);for(let i=0;i<length;i++){
   const raw=origin+i+.5,scale=v[isX?3:4],offset=v[isX?5:6];let n=(raw*.05243442)*scale+.1+offset;if(k[8])n+=(cave.seedData.seed|0)*(isX?1.312e-5:2.331e-5);
   const term=isX?raw*.49162514+off:off*(kind===3?6.86035959282328e-7:6.86e-7)+raw*.49162514;
   const modifier=kind===3?F(F(term)*F(.1)):F(term*F(.1));words.set([bits(n),bits(modifier)],i*2);
  }return words;};const vector=(length,origin,isX)=>state(axisKey('cave-family',isX,origin,length,v[isX?3:4],v[isX?5:6],k[8],kind,off),()=>make(length,origin,isX));const xx=vector(width,x,true),yy=vector(height,y,false);pair=[cursor,cursor+xx.length];cursor+=xx.length+yy.length;chunks.push(xx,yy);cache.set(key,pair);}
  configAxes.set(pair,id*2);
 }
 const data=new Uint32Array(cursor-baseOffset);let at=0;for(const chunk of chunks){data.set(chunk,at);at+=chunk.length;}return{data,headerAt:baseOffset,families:cache.size};
}
