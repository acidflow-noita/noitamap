import { BIOME_ENGINE } from '../../complete-materials/engine-data.mjs';
import { materialShader } from './material-shader.mjs';
import {packCaveTables,makeCaveAxes} from './topology0-inputs.mjs';
import {axisKey,createDeviceAxisScope,axisCacheDelta} from './axis-cache.mjs';
export {materialAxisCacheStatistics} from './axis-cache.mjs';
const pipelines=new WeakMap();

const scratch=new ArrayBuffer(4),fv=new Float32Array(scratch),uv=new Uint32Array(scratch),F=Math.fround;
export const floatBits=x=>{fv[0]=x;return uv[0];};
const floatValue=x=>{uv[0]=x;return fv[0];};
function nextUp(x){if(x===0)return floatValue(1);const b=floatBits(x);return floatValue((x>0?b+1:b-1)>>>0);}
function nextDown(x){if(x===0)return-floatValue(1);const b=floatBits(x);return floatValue((x>0?b-1:b+1)>>>0);}
const ceilF=x=>{const v=F(x);return v<x?nextUp(v):v;},floorF=x=>{const v=F(x);return v>x?nextDown(v):v;};
function bounds(x){return [floatBits(floorF(x)),floatBits(ceilF(x))];}
function upload(device,value,usage,label){const b=device.createBuffer({label,size:Math.max(4,Math.ceil(value.byteLength/4)*4),usage:usage|GPUBufferUsage.COPY_DST});if(value.byteLength)device.queue.writeBuffer(b,0,value);return b;}

export function packMaterialTables(parameters,classic,custom){
 const header=new Uint32Array(16),p=new Uint32Array(parameters.length*4),biomes=new Uint32Array(BIOME_ENGINE.length*8),bands=[],bandRecords=[];
 parameters.forEach((v,i)=>{const scale=floatBits(v.scale),threshold=floatBits(v.threshold);if([scale,threshold].some(b=>(b&0x7fffffff)!==0&&(b&0x7fffffff)<0x00800000))throw Error('Subnormal sampler parameter needs an explicit exact backend');p.set([scale,threshold,v.type,v.present===false?0:1],i*4);});
 BIOME_ENGINE.forEach((b,id)=>{
  biomes.set([floatBits(ceilF(b.setMin)),floatBits(floorF(b.setMax)),bandRecords.length,b.bands.length,b.topo,+b.supported,+b.noiseBiomeEdges,+b.paintsNothing],id*8);
  for(const entry of b.bands){
   const rare=entry.rare;const flags=(entry.limY?1:0)|(entry.addP?2:0)|(rare?4:0)|(rare?.perlin?8:0)|(rare?.polka?16:0)|(rare?.boxed?32:0);
   bands.push(entry.mat,flags,floatBits(ceilF(entry.min)),floatBits(ceilF(entry.max)),floatBits(ceilF(entry.limY?.[0]??0)),floatBits(floorF(entry.limY?.[1]??0)),floatBits(floorF(rare?.rmin??0)),floatBits(floorF(rare?.rmax??0)),floatBits(ceilF(rare?.prob??0)),...bounds(rare?.plo??0),floatBits((rare?.phi??0)-(rare?.plo??0)),0,0,0,0);
   bandRecords.push(entry);
  }
 });
 const permValue=Uint32Array.from({length:256},(_,i)=>floatBits(i/255)),fields=[p,biomes,Uint32Array.from(bands),Uint32Array.from(classic),Uint32Array.from(custom),permValue];
 let cursor=16;header[0]=cursor;header[1]=parameters.length;cursor+=p.length;header[2]=cursor;header[3]=BIOME_ENGINE.length;cursor+=biomes.length;header[4]=cursor;header[5]=bandRecords.length;cursor+=bands.length;header[6]=cursor;cursor+=classic.length;header[7]=cursor;cursor+=custom.length;header[8]=cursor;cursor+=256;
 const data=new Uint32Array(cursor);data.set(header);cursor=16;for(const field of fields){data.set(field,cursor);cursor+=field.length;}
 return {data,bandRecords,biomeRows:biomes};
}
export function makeBandAxes(tables,ids,{x,y,width,height},baseOffset=0,center=17920,axisVectors=/** @type {any} */(null)){
 function axis(length,origin,offset,isX){const out=new Uint32Array(length*10);for(let i=0;i<length;i++){
  const raw=origin+i,shifted=raw+offset,g=F((shifted+.5)*.1),floor=Math.floor(g),fraction=F(g-floor),smooth=F(F(3-F(fraction*2))*F(fraction*fraction)),nearest=floor+Number(!(.5>smooth)),at=i*10;
  out.set([floatBits(g),nearest,floatBits(shifted*(isX?.13715:.13717)),floatBits(shifted*.1111111119389534),floatBits(raw*(isX?.035:.07)),floatBits(raw),...bounds(shifted*.05),...bounds((isX?Math.cos(shifted*.005):Math.sin(shifted*.005))*30)],at);
 }return out;}
 const immutable=(key,make)=>axisVectors?axisVectors.immutable(key,make):make();
 const xAxis=immutable(axisKey('base',true,x,width,center),()=>axis(width,x,center,true)),yAxis=immutable(axisKey('base',false,y,height,7168),()=>axis(height,y,7168,false));
 const bandAxes=new Uint32Array(tables.bandRecords.length*2),chunks=[xAxis,yAxis,bandAxes];
 let cursor=xAxis.length+yAxis.length+bandAxes.length;const cache=new Map();
 for(const id of ids){const start=tables.biomeRows[id*8+2];for(let i=0;i<BIOME_ENGINE[id].bands.length;i++){
  const band=tables.bandRecords[start+i],rare=band.rare;if(!rare&&!band.addP)continue;
  const key=JSON.stringify([rare?.sx,rare?.sy,rare?.ox,rare?.oy,band.addP]);let offsets=cache.get(key);
  if(!offsets){
   const make=(length,origin,isX)=>{const values=new Uint32Array(length*4);for(let j=0;j<length;j++){
    const raw=origin+j,rx=F(F(F(raw)*(isX?rare?.sx??0:rare?.sy??0))+(isX?rare?.ox??0:rare?.oy??0)),cell=Math.floor(rx),grid=Math.floor(F(cell*floatValue(0x3c66c2b4))),residue=cell-grid*71+(isX?26:161);
    values.set([floatBits(rx),floatBits(F(rx-cell)),residue,floatBits(F(F(raw)*(band.addP?.[isX?0:1]??0)))],j*4);
   }return values;};
   const vector=(length,origin,isX)=>immutable(axisKey('band',isX,origin,length,isX?rare?.sx??0:rare?.sy??0,isX?rare?.ox??0:rare?.oy??0,band.addP?.[isX?0:1]??0),()=>make(length,origin,isX));
   const xx=vector(width,x,true),yy=vector(height,y,false);offsets=[baseOffset+cursor,baseOffset+cursor+xx.length];cursor+=xx.length+yy.length;chunks.push(xx,yy);cache.set(key,offsets);
  }
  bandAxes.set(offsets,(start+i)*2);
 }}
 const data=new Uint32Array(cursor);let at=0;for(const chunk of chunks){data.set(chunk,at);at+=chunk.length;}
 return {data,xAt:baseOffset,yAt:baseOffset+xAxis.length,bandAt:baseOffset+xAxis.length+yAxis.length,axisFamilies:cache.size};
}

export function makeAxes(input,tables,x,y,width,height,grids,columns,cave,axisVectors=/** @type {any} */(null)){
 const axisStarted=performance.now(),cacheBefore=axisVectors?.statistics();
 const ids=new Set(),mapWidth=input.mapWidth,center=mapWidth*256,slotByColor=new Map(BIOME_ENGINE.map((b,i)=>[b.color,i]));
 for(let cy=Math.floor((y+7168)/512)-1;cy<=Math.floor((y+height-1+7168)/512)+1;cy++)for(let cx=Math.floor((x+center)/512)-1;cx<=Math.floor((x+width-1+center)/512)+1;cx++){
  const at=Math.max(0,Math.min(47,cy))*mapWidth+((cx%mapWidth)+mapWidth)%mapWidth,id=slotByColor.get(input.biomePixels[at]&0xffffff);if(id!==undefined)ids.add(id);
 }
 const band=makeBandAxes(tables,ids,{x,y,width,height},0,center,axisVectors),metadata=new Uint32Array(width*4),chunks=[band.data,metadata];
 let cursor=band.data.length+metadata.length;const yOffsets=[];
 const nearest=g=>{const cell=Math.floor(g),fraction=F(g-cell),smooth=F(F(3-F(fraction*2))*F(fraction*fraction));return cell+Number(!(.5>smooth));};
 for(const grid of grids){
  if(!input.plane){yOffsets.push(band.yAt);continue;}
  const ya=band.data.slice(band.yAt,band.yAt+height*10);for(let j=0;j<height;j++)ya[j*10+1]=nearest(F(floatValue(ya[j*10])-grid.offsetY/10));
  yOffsets.push(cursor);cursor+=ya.length;chunks.push(ya);
 }
 for(let i=0;i<width;i++){
  const wx=x+i,physical=Math.floor((wx+center)/512),column=((physical%mapWidth)+mapWidth)%mapWidth,index=columns[column],grid=grids[index],pw=Math.floor((wx+center)/(mapWidth*512)),shift=(pw*mapWidth)*512/10;
  if(input.plane&&grid.shaft)band.data[i*10+1]=nearest(F((floatValue(band.data[i*10])-grid.originX)-shift));
  metadata.set([index,...bounds(shift),yOffsets[index]],i*4);
 }
 const caveIDs=new Set([...ids].filter(id=>BIOME_ENGINE[id].topo===0));
 const caveAxes=cave&&caveIDs.size?makeCaveAxes(cave,caveIDs,{x,y,width,height},cursor,axisVectors):{data:new Uint32Array(0),headerAt:0,families:0};cursor+=caveAxes.data.length;chunks.push(caveAxes.data);
 const data=new Uint32Array(cursor);let at=0;for(const chunk of chunks){data.set(chunk,at);at+=chunk.length;}
 return{...band,data,gridAt:band.data.length,caveAt:caveAxes.headerAt,caveFamilies:caveAxes.families,axisBuildMs:performance.now()-axisStarted,axisCache:axisVectors?axisCacheDelta(cacheBefore,axisVectors.statistics()):null};
}

async function materialPipeline(device,diagnostics){
 let cache=pipelines.get(device);if(!cache){cache=new Map();pipelines.set(device,cache);}let ready=cache.get(diagnostics);if(!ready){ready=(async()=>{const code=materialShader.replace('const STORE_DIAGNOSTICS:bool=true;',`const STORE_DIAGNOSTICS:bool=${diagnostics};`),shader=device.createShaderModule({code,label:'certified source material candidate'}),info=await shader.getCompilationInfo();if(info.messages.some(m=>m.type==='error'))throw Error(info.messages.map(m=>`${m.lineNum}:${m.message}`).join('\n'));return device.createComputePipelineAsync({layout:'auto',compute:{module:shader,entryPoint:'generate'}});})();cache.set(diagnostics,ready);}
 return ready;
}
/** Reusable device setup. The single outside-plane invocation needs no seed. */
export async function prepareMaterialComputeSetup(device,{diagnostics=false}={}){
 const start=performance.now(),pipeline=await materialPipeline(device,diagnostics),compileMs=performance.now()-start;
 const params=Uint32Array.from([1,1,0,-1000000,1,1,70,1,0,0,0,1,1,0,0,0,0,0,0,0]);
 const buffers=[upload(device,params,GPUBufferUsage.UNIFORM,'material setup parameters'),...Array.from({length:5},()=>upload(device,new Uint32Array(16),GPUBufferUsage.STORAGE,'material setup empty input')),device.createBuffer({size:4,usage:GPUBufferUsage.STORAGE}),device.createBuffer({size:(diagnostics?7:5)*4,usage:GPUBufferUsage.STORAGE})];
 try{const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:buffers.map((buffer,binding)=>({binding,resource:{buffer}}))}),encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(1);pass.end();const begin=performance.now();device.queue.submit([encoder.finish()]);await device.queue.onSubmittedWorkDone();return{compileMs,warmDispatchMs:performance.now()-begin,totalMs:performance.now()-start,temporaryBytes:buffers.reduce((n,b)=>n+b.size,0),seedInputs:false};}finally{buffers.forEach(b=>b.destroy());}
}

export async function createMaterialCompute(device,input,{classic,custom,diagnostics=false,cave=/** @type {any} */(null)}){
 if(input.mapWidth!==70||input.lattice.GW!==3584||input.lattice.GH!==2457)throw Error('GPU certificate requires normal70-column material inputs');
 const init=performance.now(),axisVectors=createDeviceAxisScope(device),tables=packMaterialTables(input.parameters,classic,custom),slots=new Map(BIOME_ENGINE.map((b,i)=>[b.color,i])),world=new Uint32Array(input.mapWidth*48*4);let allKnown=true;
 for(let i=0;i<input.mapWidth*48;i++){const color=input.biomePixels[i]&0xffffff,id=slots.get(color);if(id===undefined)allKnown=false;world.set([color,id??-1,input.hostChunks[i],input.lattice.chunkCovered[i]],i*4);}
 const shafts=new Map((input.plane?.shafts??[]).map(s=>[s.column,s])),columns=new Uint32Array(input.mapWidth);
 const grids=[{source:input.lattice,offsetY:input.plane?.offsetY??0,originX:0,shaft:0},...[...shafts.values()].map(s=>({source:s.lattice,offsetY:s.offsetY,originX:s.originX,shaft:1}))];
 [...shafts.keys()].forEach((column,i)=>{if(!Number.isInteger(column)||column<0||column>=input.mapWidth)throw Error('Invalid GPU shaft column');columns[column]=i+1;});
 const descriptors=new Uint32Array(grids.length*12);let coverageSize=0,labelSize=0;
 grids.forEach((g,i)=>{const s=g.source;if(s.GW<1||s.GH<1||s.GW*s.GH!==s.cov.length||s.mat.length!==s.cov.length||![g.offsetY,g.originX].every(Number.isFinite))throw Error('Invalid GPU grid');descriptors.set([s.GW,s.GH,coverageSize,labelSize,...bounds(g.offsetY/10),...bounds(g.originX),g.shaft,0,0,0],i*12);coverageSize+=s.cov.length;labelSize+=Math.ceil(s.mat.length/2);});
 const covData=new Float32Array(coverageSize),labelData=new Uint32Array(labelSize);
 grids.forEach((g,i)=>{const d=i*12;covData.set(g.source.cov,descriptors[d+2]);new Uint16Array(labelData.buffer,descriptors[d+3]*4,g.source.mat.length).set(g.source.mat);});
 const combined=new Uint32Array(tables.data.length+descriptors.length);combined.set(tables.data);combined[9]=tables.data.length;combined[10]=grids.length;combined[11]=+!!input.plane;combined[12]=input.plane?.offsetY??0;combined.set(descriptors,tables.data.length);tables.data=cave?packCaveTables(combined,cave):combined;
 const resources=[upload(device,tables.data,GPUBufferUsage.STORAGE,'material typed tables'),upload(device,covData,GPUBufferUsage.STORAGE,'material coverage lattices'),upload(device,labelData,GPUBufferUsage.STORAGE,'material ID lattices'),upload(device,world,GPUBufferUsage.STORAGE,'material biome ownership')];
 const pipeline=await materialPipeline(device,diagnostics),initialization={ms:performance.now()-init,resourceBytes:resources.reduce((n,b)=>n+b.size,0),tableBytes:tables.data.byteLength,axisCache:axisVectors.statistics()};
 return{initialization,axisCacheStatistics:axisVectors.statistics,
  encodeRect(encoder,{x,y,width,height,targetWidth=width,targetHeight=height,offsetX=0,offsetY=0}){
   if(![x,y,width,height].every(Number.isSafeInteger)||width<1||height<1||width>1024||height>1024||Math.abs(x)+width+17920>=2**24||Math.abs(y)+height+7168>=2**24)throw Error('GPU material rectangle exceeds certified coordinate range');
   if(![targetWidth,targetHeight,offsetX,offsetY].every(Number.isSafeInteger)||targetWidth<1||targetHeight<1||targetWidth>1024||targetHeight>1024||offsetX<0||offsetY<0||offsetX+width>targetWidth||offsetY+height>targetHeight)throw Error('Invalid GPU material target layout');
   const started=performance.now(),axes=makeAxes(input,tables,x,y,width,height,grids,columns,cave,axisVectors),count=width*height,params=Uint32Array.from([width,height,x,y,input.lattice.GW,input.lattice.GH,input.mapWidth,+allKnown,axes.xAt,axes.yAt,axes.bandAt,count,targetWidth,offsetX,offsetY,axes.gridAt,axes.caveAt,0,0,0]);
   const paramBuffer=upload(device,params,GPUBufferUsage.UNIFORM,'material rect parameters'),axisBuffer=upload(device,axes.data,GPUBufferUsage.STORAGE,'exact material axes');
   const materialBuffer=device.createBuffer({size:targetWidth*targetHeight*4,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC|GPUBufferUsage.COPY_DST,label:'certified and pending materials'}),diagnosticBuffer=device.createBuffer({size:(4+(diagnostics?3:1)*count)*4,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC|GPUBufferUsage.COPY_DST,label:'material correction list'});
   const all=[paramBuffer,...resources,axisBuffer,materialBuffer,diagnosticBuffer],group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:all.map((buffer,binding)=>({binding,resource:{buffer}}))});
   encoder.clearBuffer(materialBuffer);encoder.clearBuffer(diagnosticBuffer,0,16);const pass=encoder.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(Math.ceil(width/8),Math.ceil(height/8));pass.end();
   return{x,y,width,height,count,targetWidth,targetHeight,offsetX,offsetY,materialBuffer,diagnosticBuffer,diagnostics,correctionListOffsetBytes:16+(diagnostics?count*8:0),stats:{cpuAxesAndEncodeMs:performance.now()-started,axesBytes:axes.data.byteLength,axisBuildMs:axes.axisBuildMs,axisCache:axes.axisCache,axisFamilies:axes.axisFamilies,caveFamilies:axes.caveFamilies,outputBytes:materialBuffer.size+diagnosticBuffer.size,diagnostics},destroy(){for(const b of[paramBuffer,axisBuffer,materialBuffer,diagnosticBuffer])b.destroy();}};
  },destroy(){axisVectors.dispose();resources.forEach(b=>b.destroy());}};
}
