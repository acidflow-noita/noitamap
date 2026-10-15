/// <reference types="@webgpu/types" />
import type { NativeMaterialAtlas } from '../cook-inputs/atlas';
import type { PreparedScene, PixelImage } from '../composition/types';

export interface GpuCompositionAssets {
  atlas: NativeMaterialAtlas;
  backgroundTextures: readonly PixelImage[];
  scenes: readonly { prepared: PreparedScene; airBackgroundIndex: number }[];
}
/** CPU binning needs bounds only; prepared pixel/grid arrays can stay on GPU. */
export interface GpuCompositionSceneLayout {
  prepared: Pick<PreparedScene, 'x' | 'y' | 'width' | 'height'> & {
    backgroundArt?: Pick<PixelImage, 'width' | 'height'> | null;
  };
}
export interface GpuCompositionPage {
  page: { x: number; y: number; width: number; height: number };
  width: number; height: number;
  /** Null when the exact original field stays in a caller-supplied GPU buffer. */
  originalMaterials: Int16Array | null;
  ownsTerrain: boolean; backgroundIndex: number;
  backgroundPhase: { x: number; y: number };
  airMask: Uint8Array; ordinaryMask: Uint8Array;
  sceneIDs: readonly number[];
  liquidPasses: readonly { x0: number; x1: number; y: number; top: number;
    bottom: number; material: number; bottomMaterials: Int16Array }[];
}

// All colors are byte-exact packed RGBA: R occupies the low byte. No blending
// hardware, float arithmetic, color conversion or game rules enter the decoder.
export const compositionWGSL = `
struct Params {
 width:u32, height:u32, pad:u32, haloWidth:u32,
 x:i32, y:i32, owned:u32, background:u32,
 binCols:u32, binRows:u32, airAt:u32, solidAt:u32,
 phaseX:i32, phaseY:i32, hasLegacy:u32, unused1:u32,
}
@group(0) @binding(0) var<uniform> p:Params;
@group(0) @binding(1) var<storage,read> materials:array<i32>;
@group(0) @binding(2) var<storage,read> textures:array<u32>;
@group(0) @binding(3) var<storage,read> scenes:array<u32>;
@group(0) @binding(4) var<storage,read> page:array<u32>;
@group(0) @binding(5) var<storage,read> liquids:array<i32>;
@group(0) @binding(6) var<storage,read> edges:array<u32>;
@group(0) @binding(7) var<storage,read_write> output:array<u32>;
@group(0) @binding(8) var<storage,read> legacy:array<u32>;
fn wrap(x:i32,n:u32)->u32 { let size=i32(n); let r=x%size; return u32(select(r,r+size,r<0)); }
fn texel(id:u32,x:i32,y:i32)->u32 {
 let t=id*4u; let w=textures[t+1u]; let h=textures[t+2u];
 if(w==0u || h==0u){return textures[t+3u];}
 return textures[textures[t]+wrap(y,h)*w+wrap(x,w)];
}
fn materialColor(id:i32,x:i32,y:i32)->u32 {
 if(id<=0){return 0u;} let c=texel(u32(id),x,y); return select(c,0u,(c>>24u)==0u);
}
fn composite(f:u32,b:u32)->u32 {
 let fa=f>>24u; let ba=b>>24u;
 if(fa==255u || ba==0u){return f;} if(fa==0u){return b;}
 let weight=ba*(255u-fa); let alpha=fa*255u+weight;
 var c=((alpha+127u)/255u)<<24u;
 for(var shift=0u;shift<24u;shift+=8u){
  let num=((f>>shift)&255u)*fa*255u+((b>>shift)&255u)*weight;
  c|=((num+alpha/2u)/alpha)<<shift;
 }
 return c;
}
fn inside(x:i32,y:i32,left:i32,top:i32,w:u32,h:u32)->bool {
 return x>=left && y>=top && x<left+i32(w) && y<top+i32(h);
}
@compute @workgroup_size(8,8) fn finish(@builtin(global_invocation_id) invocation:vec3<u32>){
 let col=invocation.x; let row=invocation.y; if(col>=p.width || row>=p.height){return;}
 let i=row*p.width+col; let mi=(row+p.pad)*p.haloWidth+col+p.pad;
 let x=p.x+i32(col); let y=p.y+i32(row);
 let original=select(-1,materials[mi],p.owned!=0u);
 var foreground=select(0u,materialColor(original,x,y),p.owned!=0u);
 if(p.owned!=0u && original<0 && p.hasLegacy!=0u){foreground=legacy[mi];}
 var background=texel(p.background,x+p.phaseX,y+p.phaseY);
 var canPaint=p.owned!=0u;
 let bin=((row/16u)*p.binCols+col/16u)*4u;
 // Page-selected run order is preserved, including overlapping liquid runs.
 for(var k=0u;k<page[bin+3u];k++){
  let l=page[page[bin+2u]+k]*8u;
  if(x<liquids[l] || x>=liquids[l+1u] || y<liquids[l+3u] || y>=liquids[l+4u]){continue;}
  let mat=liquids[l+5u]; if(original!=0 && original!=mat){continue;}
  if(y<liquids[l+2u]){if(original==mat){foreground=0u;}}
  else if(original==0 && liquids[u32(liquids[l+6u])+u32(x-liquids[l])]==mat){foreground=materialColor(mat,x,y);}
 }
 // Every scene background precedes every scene foreground/erase operation.
 for(var k=0u;k<page[bin+1u];k++){
  let s=page[page[bin]+k]*16u; let left=bitcast<i32>(scenes[s]); let top=bitcast<i32>(scenes[s+1u]);
  let w=scenes[s+7u]; let h=scenes[s+8u];
  if(inside(x,y,left,top,w,h)){background=composite(scenes[scenes[s+6u]+u32(y-top)*w+u32(x-left)],background);}
 }
 for(var k=0u;k<page[bin+1u];k++){
  let s=page[page[bin]+k]*16u; let left=bitcast<i32>(scenes[s]); let top=bitcast<i32>(scenes[s+1u]);
  let w=scenes[s+2u]; let h=scenes[s+3u]; if(!inside(x,y,left,top,w,h)){continue;}
  let n=u32(y-top)*w+u32(x-left);
  let flags=(scenes[scenes[s+5u]+n/16u]>>((n%16u)*2u))&3u;
  if((flags&2u)!=0u){foreground=0u;}
  foreground=composite(scenes[scenes[s+4u]+n],foreground);
  if((flags&1u)!=0u){canPaint=true;}
  if((flags&2u)!=0u && (background>>24u)==0u){background=texel(scenes[s+9u],x+p.phaseX,y+p.phaseY);}
 }
 let decal=edges[mi]; if((decal>>24u)!=0u && canPaint){foreground=composite(decal,foreground);}
 if((page[p.airAt+i/32u]&(1u<<(i%32u)))!=0u){foreground=0u;}
 var result=composite(foreground,background);
 if((page[p.solidAt+i/32u]&(1u<<(i%32u)))!=0u){result=0u;}
 output[i]=result;
}
`;

export const mipWGSL = `
struct Size {width:u32,height:u32,outWidth:u32,outHeight:u32}
@group(0) @binding(0) var<uniform> p:Size;
@group(0) @binding(1) var<storage,read> source:array<u32>;
@group(0) @binding(2) var<storage,read_write> output:array<u32>;
@compute @workgroup_size(8,8) fn reduce(@builtin(global_invocation_id) id:vec3<u32>){
 if(id.x>=p.outWidth || id.y>=p.outHeight){return;}
 var alpha=0u; var red=0u; var green=0u; var blue=0u;
 for(var dy=0u;dy<2u;dy++){for(var dx=0u;dx<2u;dx++){
  let x=id.x*2u+dx; let y=id.y*2u+dy; if(x>=p.width || y>=p.height){continue;}
  let c=source[y*p.width+x]; let a=c>>24u; alpha+=a;
  red+=(c&255u)*a; green+=((c>>8u)&255u)*a; blue+=((c>>16u)&255u)*a;
 }}
 var c=0u;
 if(alpha!=0u){c=((red+alpha/2u)/alpha) | (((green+alpha/2u)/alpha)<<8u) | (((blue+alpha/2u)/alpha)<<16u) | (((alpha+2u)/4u)<<24u);}
 output[id.y*p.outWidth+id.x]=c;
}
`;

const inPlaceMipWGSL = mipWGSL
  .replace('outHeight:u32}', 'outHeight:u32,inAt:u32,outAt:u32,unused0:u32,unused1:u32}')
  .replace('@group(0) @binding(1) var<storage,read> source:array<u32>;\n@group(0) @binding(2) var<storage,read_write> output:array<u32>;', '@group(0) @binding(1) var<storage,read_write> pixels:array<u32>;')
  .replace('source[y*p.width+x]', 'pixels[p.inAt+y*p.width+x]')
  .replace('output[id.y*p.outWidth+id.x]', 'pixels[p.outAt+id.y*p.outWidth+id.x]');

export function mipLayout(width:number,height:number){
  if(![width,height].every(v=>Number.isSafeInteger(v)&&v>0&&v<=8192))throw new RangeError('Unsupported completed mip dimensions');
  const levels:Array<{width:number;height:number;wordOffset:number}>=[];let words=0;
  for(;;){levels.push({width,height,wordOffset:words});words+=width*height;if(width===1&&height===1)break;width=Math.ceil(width/2);height=Math.ceil(height/2);}
  return {levels,words};
}

class Words {
  size = 0;
  private chunks: Uint32Array[] = [];
  add(value: Uint32Array) { const offset=this.size; this.chunks.push(value); this.size+=value.length; return offset; }
  finish() { const out=new Uint32Array(this.size); let at=0; for(const chunk of this.chunks){out.set(chunk,at);at+=chunk.length;} return out; }
}
function rgbaWords(value: Uint8Array | Uint8ClampedArray) {
  const copy=Uint8Array.from(value); return new Uint32Array(copy.buffer);
}
function maskWords(value: Uint8Array) { const bytes=new Uint8Array(Math.ceil(value.length/4)*4);bytes.set(value);return new Uint32Array(bytes.buffer); }

export function packCompositionAssets(fixture: GpuCompositionAssets) {
  const textures=new Words(), materialCount=fixture.atlas.materialTable.length/4, backgrounds=fixture.backgroundTextures;
  const table=new Uint32Array((materialCount+backgrounds.length+1)*4);textures.add(table);
  const {atlas}=fixture;
  for(let id=0;id<materialCount;id++){
    const src=id*4, entry=atlas.materialTable[src]&255, dst=id*4;
    if(!entry){table[dst+3]=(atlas.materialTable[src]>>>8)<<24 | atlas.materialTable[src+1] | atlas.materialTable[src+2]<<8 | atlas.materialTable[src+3]<<16;continue;}
    const m=(entry-1)*4,x=atlas.meta[m],y=atlas.meta[m+1],w=atlas.meta[m+2],h=atlas.meta[m+3],pixels=new Uint8Array(w*h*4);
    for(let row=0;row<h;row++)pixels.set(atlas.data.subarray(((y+row)*atlas.width+x)*4,((y+row)*atlas.width+x+w)*4),row*w*4);
    table[dst]=textures.add(new Uint32Array(pixels.buffer));table[dst+1]=w;table[dst+2]=h;
  }
  for(let i=0;i<backgrounds.length;i++){
    const source=backgrounds[i],dst=(materialCount+i+1)*4;
    table[dst]=textures.add(rgbaWords(source.data));table[dst+1]=source.width;table[dst+2]=source.height;
  }
  return {textures:textures.finish(),scenes:packCompositionScenes(fixture.scenes,materialCount),materialCount};
}

/** Scene instances change with the seed; texture resources and pipelines do not. */
export function packCompositionScenes(records:GpuCompositionAssets['scenes'],materialCount:number){
  const scenes=new Words(),descriptors=new Uint32Array(records.length*16);scenes.add(descriptors);
  for(let id=0;id<records.length;id++){
    const record=records[id],s=record.prepared,d=id*16,flags=new Uint32Array(Math.ceil(s.width*s.height/16));
    for(let i=0;i<s.width*s.height;i++)flags[i>>4]|=((s.sourceAlpha[i]?1:0)|(s.eraseMask?.[i*4+3]?2:0))<<((i&15)*2);
    descriptors.set([s.x,s.y,s.width,s.height,scenes.add(rgbaWords(s.pixels)),scenes.add(flags)],d);
    if(s.backgroundArt){const bg=s.backgroundArt;descriptors[d+6]=scenes.add(rgbaWords(bg.data));descriptors[d+7]=bg.width;descriptors[d+8]=bg.height;}
    descriptors[d+9]=materialCount+record.airBackgroundIndex;
  }
  return scenes.finish();
}

export function packCompositionPage(fixture: {scenes:readonly GpuCompositionSceneLayout[]}, input: GpuCompositionPage, materialCount:number) {
  const {page}=input,w=page.width,h=page.height,cols=Math.ceil(w/16),rows=Math.ceil(h/16),count=cols*rows;
  if(![w,h].every(v=>Number.isSafeInteger(v)&&v>0&&v<=576)||input.width!==w+64||input.height!==h+64||
    (input.originalMaterials!==null&&input.originalMaterials.length!==input.width*input.height)||input.airMask.length!==Math.ceil(w*h/8)||input.ordinaryMask.length!==Math.ceil(w*h/8))
    throw new RangeError('Incomplete canonical composition page inputs');
  if(![page.x,page.y].every(v=>Number.isSafeInteger(v)&&Math.abs(v)<0x3ffff000))throw new RangeError('Unsupported composition origin');
  if(input.sceneIDs.some((id,i)=>!Number.isSafeInteger(id)||id<0||id>=fixture.scenes.length||(i>0&&id<=input.sceneIDs[i-1])))
    throw new RangeError('Composition scenes must preserve their unique original order');
  // Counts become write cursors after the descriptor header is copied. Bounds
  // are kept flat so counting and filling do not allocate per-bin JS arrays.
  const bins=new Uint32Array(count*4),bounds=new Float64Array((input.sceneIDs.length+input.liquidPasses.length)*4);
  const add=(range:number,channel:number,left:number,top:number,right:number,bottom:number)=>{
    const x0=Math.max(0,Math.floor((left-page.x)/16)),x1=Math.min(cols,Math.ceil((right-page.x)/16));
    const y0=Math.max(0,Math.floor((top-page.y)/16)),y1=Math.min(rows,Math.ceil((bottom-page.y)/16));
    const at=range*4;bounds[at]=x0;bounds[at+1]=x1;bounds[at+2]=y0;bounds[at+3]=y1;
    for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++)bins[(y*cols+x)*4+channel+1]++;
  };
  for(let i=0;i<input.sceneIDs.length;i++){const s=fixture.scenes[input.sceneIDs[i]].prepared;add(i,0,s.x,s.y,s.x+Math.max(s.width,s.backgroundArt?.width??0),s.y+Math.max(s.height,s.backgroundArt?.height??0));}
  let liquidWords=input.liquidPasses.length*8;
  for(const s of input.liquidPasses)liquidWords+=s.bottomMaterials.length;
  const liquids=new Uint32Array(liquidWords);let liquidAt=input.liquidPasses.length*8;
  for(let id=0;id<input.liquidPasses.length;id++){
    const s=input.liquidPasses[id],d=id*8;
    liquids[d]=s.x0;liquids[d+1]=s.x1;liquids[d+2]=s.y;liquids[d+3]=s.top;liquids[d+4]=s.bottom;liquids[d+5]=s.material;liquids[d+6]=liquidAt;
    liquids.set(s.bottomMaterials,liquidAt);liquidAt+=s.bottomMaterials.length;
    add(input.sceneIDs.length+id,2,s.x0,s.top,s.x1,s.bottom);
  }
  let wordCount=bins.length;
  for(let d=0;d<bins.length;d+=4){bins[d]=wordCount;wordCount+=bins[d+1];bins[d+2]=wordCount;wordCount+=bins[d+3];}
  const airAt=wordCount,solidAt=airAt+Math.ceil(input.airMask.length/4);
  const words=new Uint32Array(solidAt+Math.ceil(input.ordinaryMask.length/4));words.set(bins);
  const write=(range:number,channel:number,id:number)=>{
    const at=range*4,x0=bounds[at],x1=bounds[at+1],y0=bounds[at+2],y1=bounds[at+3];
    for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++)words[bins[(y*cols+x)*4+channel]++]=id;
  };
  for(let i=0;i<input.sceneIDs.length;i++)write(i,0,input.sceneIDs[i]);
  for(let i=0;i<input.liquidPasses.length;i++)write(input.sceneIDs.length+i,2,i);
  const bytes=new Uint8Array(words.buffer);
  bytes.set(input.airMask,airAt*4);bytes.set(input.ordinaryMask,solidAt*4);
  const params=new Uint32Array([w,h,32,input.width,page.x,page.y,+input.ownsTerrain,materialCount+input.backgroundIndex,cols,rows,airAt,solidAt,input.backgroundPhase.x,input.backgroundPhase.y,0,0]);
  return {params,page:words,liquids,materials:input.originalMaterials===null?null:Int32Array.from(input.originalMaterials)};
}

function buffer(device:GPUDevice,data:ArrayBufferView,usage=GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC){
  const limit=(usage&GPUBufferUsage.UNIFORM)?device.limits.maxUniformBufferBindingSize:device.limits.maxStorageBufferBindingSize;
  if(data.byteLength>limit)throw new RangeError('Composition resource exceeds the device binding limit');
  const result=device.createBuffer({size:Math.max(4,data.byteLength),usage:usage|GPUBufferUsage.COPY_DST});
  if(data.byteLength)device.queue.writeBuffer(result,0,data.buffer as ArrayBuffer,data.byteOffset,data.byteLength);return result;
}
export async function createGpuComposition(device:GPUDevice,assets:ReturnType<typeof packCompositionAssets>){
  const started=performance.now();
  const [finish,mip,inPlaceMip]=await Promise.all([
    device.createComputePipelineAsync({layout:'auto',compute:{module:device.createShaderModule({code:compositionWGSL}),entryPoint:'finish'}}),
    device.createComputePipelineAsync({layout:'auto',compute:{module:device.createShaderModule({code:mipWGSL}),entryPoint:'reduce'}}),
    device.createComputePipelineAsync({layout:'auto',compute:{module:device.createShaderModule({code:inPlaceMipWGSL}),entryPoint:'reduce'}}),
  ]);
  const textures=buffer(device,assets.textures);let scenes=buffer(device,assets.scenes);
  return {
    startupMs:performance.now()-started,get sharedBytes(){return textures.size+scenes.size;},
    async replaceScenes(data:Uint32Array){
      // Existing completed pages contain final pixels, not scene references.
      // Fence the old commands before retiring their input buffer.
      await device.queue.onSubmittedWorkDone();
      const previous=scenes;scenes=buffer(device,data);previous.destroy();
    },
    // Optional resident scene output is borrowed until the caller's submission
    // completes. It is never destroyed or retained by the composition engine.
    encode(encoder:GPUCommandEncoder,input:ReturnType<typeof packCompositionPage>,decals:GPUBuffer,originalMaterialBuffer?:GPUBuffer,sceneBuffer?:GPUBuffer,legacyColorBuffer?:GPUBuffer){
      if(!originalMaterialBuffer&&!input.materials)throw new Error('An exact original material field is required');
      const params=input.params.slice();params[14]=+!!legacyColorBuffer;
      const temporary=[buffer(device,params,GPUBufferUsage.UNIFORM),buffer(device,input.page),buffer(device,input.liquids)];
      const original=originalMaterialBuffer??buffer(device,input.materials!);if(!originalMaterialBuffer)temporary.push(original);
      if(original.size<input.params[3]*(input.params[1]+input.params[2]*2)*4)throw new RangeError('Original material buffer does not cover the page halo');
      if(legacyColorBuffer&&legacyColorBuffer.size<input.params[3]*(input.params[1]+input.params[2]*2)*4)throw new RangeError('Legacy color buffer does not cover the page halo');
      const width=input.params[0],height=input.params[1];
      const layout=mipLayout(width,height);
      if(layout.words*4>device.limits.maxStorageBufferBindingSize)throw new RangeError('Completed mip buffer exceeds the device binding limit');
      const output=device.createBuffer({size:layout.words*4,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC});
      const resources=[temporary[0],original,textures,sceneBuffer??scenes,temporary[1],temporary[2],decals,output,legacyColorBuffer??original];
      const group=device.createBindGroup({layout:finish.getBindGroupLayout(0),entries:resources.map((b,binding)=>({binding,resource:{buffer:b}}))});
      const pass=encoder.beginComputePass();pass.setPipeline(finish);pass.setBindGroup(0,group);pass.dispatchWorkgroups(Math.ceil(width/8),Math.ceil(height/8));pass.end();
      return {buffer:output,width,height,layout,temporaryBytes:temporary.reduce((sum,b)=>sum+b.size,0),disposeInputs(){for(const b of temporary)b.destroy();}};
    },
    reduceInPlace(encoder:GPUCommandEncoder,pixels:GPUBuffer,width:number,height:number){
      const layout=mipLayout(width,height),temporary:GPUBuffer[]=[];
      if(pixels.size<layout.words*4)throw new RangeError('Incomplete mip allocation');
      for(let i=1;i<layout.levels.length;i++){
        const source=layout.levels[i-1],target=layout.levels[i];
        const params=buffer(device,new Uint32Array([source.width,source.height,target.width,target.height,source.wordOffset,target.wordOffset,0,0]),GPUBufferUsage.UNIFORM);temporary.push(params);
        const group=device.createBindGroup({layout:inPlaceMip.getBindGroupLayout(0),entries:[params,pixels].map((b,binding)=>({binding,resource:{buffer:b}}))});
        const pass=encoder.beginComputePass();pass.setPipeline(inPlaceMip);pass.setBindGroup(0,group);pass.dispatchWorkgroups(Math.ceil(target.width/8),Math.ceil(target.height/8));pass.end();
      }
      return {layout,disposeInputs(){for(const b of temporary)b.destroy();}};
    },
    reduce(encoder:GPUCommandEncoder,source:GPUBuffer,width:number,height:number){
      const outWidth=Math.ceil(width/2),outHeight=Math.ceil(height/2),params=buffer(device,new Uint32Array([width,height,outWidth,outHeight]),GPUBufferUsage.UNIFORM);
      const output=device.createBuffer({size:outWidth*outHeight*4,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC});
      const group=device.createBindGroup({layout:mip.getBindGroupLayout(0),entries:[params,source,output].map((b,binding)=>({binding,resource:{buffer:b}}))});
      const pass=encoder.beginComputePass();pass.setPipeline(mip);pass.setBindGroup(0,group);pass.dispatchWorkgroups(Math.ceil(outWidth/8),Math.ceil(outHeight/8));pass.end();
      return {buffer:output,width:outWidth,height:outHeight,disposeInputs(){params.destroy();}};
    },
    dispose(){textures.destroy();scenes.destroy();},
  };
}
