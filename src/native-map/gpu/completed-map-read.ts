/// <reference types="@webgpu/types" />
import {PIXEL_STORAGE_READ_WGSL} from './pixel-storage';
import type {EncodedGpuSurface} from './pixel-storage-gpu';
import type {mipLayout} from './composition-compute';

/** Read-only presentation input. Every page slot must already be completed:
 * 0 is exact transparent; otherwise slot=(atlasIndex+1)*4+localPage(0..2). */
export interface CompletedGpuMap {
 complete:true; columns:number; rows:number; slots:Uint32Array;
 atlases:readonly EncodedGpuSurface[];
 coarse:{buffer:GPUBuffer;width:number;height:number;pageLevel:number;layout:ReturnType<typeof mipLayout>};
}
export interface CompletedMapRead {level:number;x:number;y:number;width:number;height:number}
const readPages=`
struct Parameters {width:u32,height:u32,blocksWide:u32,count:u32}
@group(0) @binding(0) var<uniform> params:Parameters;
@group(0) @binding(1) var<storage,read> directory:array<u32>;
@group(0) @binding(2) var<storage,read> payload:array<u32>;
@group(0) @binding(3) var<storage,read> pieces:array<u32>;
@group(0) @binding(4) var<storage,read_write> output:array<u32>;
${PIXEL_STORAGE_READ_WGSL}
@compute @workgroup_size(8,8)
fn read_page(@builtin(global_invocation_id) id:vec3u){
 if(id.z>=params.count){return;}let at=id.z*8u;
 if(id.x>=pieces[at+4u]||id.y>=pieces[at+5u]){return;}
 let x=pieces[at+2u]+id.x;let y=pieces[at+3u]+id.y;
 output[y*params.width+x]=readCompletedPixel(pieces[at]+id.x,pieces[at+1u]+id.y);
}`;
const readCoarse=`
struct Parameters {width:u32,height:u32,sourceWidth:u32,sourceHeight:u32,x:i32,y:i32,sourceAt:u32,unused:u32}
@group(0) @binding(0) var<uniform> p:Parameters;
@group(0) @binding(1) var<storage,read> source:array<u32>;
@group(0) @binding(2) var<storage,read_write> output:array<u32>;
@compute @workgroup_size(8,8)
fn read_coarse(@builtin(global_invocation_id) id:vec3u){
 if(id.x>=p.width||id.y>=p.height){return;}let x=p.x+i32(id.x);let y=p.y+i32(id.y);
 if(x<0||y<0||x>=i32(p.sourceWidth)||y>=i32(p.sourceHeight)){return;}
 output[id.y*p.width+id.x]=source[p.sourceAt+u32(y)*p.sourceWidth+u32(x)];
}`;
function upload(device:GPUDevice,value:Uint32Array,usage:number){
 const b=device.createBuffer({size:value.byteLength,usage:usage|GPUBufferUsage.COPY_DST});device.queue.writeBuffer(b,0,value.buffer as ArrayBuffer,value.byteOffset,value.byteLength);return b;
}
/** This reader has no seed, geometry, material resolver or scene generator.
 * Panning/zooming only reads losslessly retained final pixels and final mips. */
export async function createCompletedMapReader(device:GPUDevice,map:CompletedGpuMap){
 if(map.complete!==true||![map.columns,map.rows].every(n=>Number.isSafeInteger(n)&&n>0)||map.slots.length!==map.columns*map.rows)throw new Error('A complete map is required');
 const slots=map.slots.slice();
 const columns=map.columns,rows=map.rows,atlases=map.atlases.slice();
 for(const slot of slots)if(slot===0xffffffff||(slot!==0&&((slot&3)>2||(slot>>>2)<1||(slot>>>2)>map.atlases.length)))throw new Error('Incomplete or invalid completed map slot');
 for(const atlas of map.atlases)if(atlas.width!==1024||atlas.height!==1024)throw new Error('Unexpected completed atlas dimensions');
 const coarse=map.coarse;
 if(!Number.isInteger(coarse.pageLevel)||coarse.pageLevel<0||coarse.pageLevel>9||coarse.width!==map.columns*(512>>coarse.pageLevel)||coarse.height!==map.rows*(512>>coarse.pageLevel)||coarse.buffer.size<coarse.layout.words*4)throw new Error('Incomplete coarse map');
 const [pagePipeline,coarsePipeline]=await Promise.all([
  device.createComputePipelineAsync({layout:'auto',compute:{module:device.createShaderModule({code:readPages}),entryPoint:'read_page'}}),
  device.createComputePipelineAsync({layout:'auto',compute:{module:device.createShaderModule({code:readCoarse}),entryPoint:'read_coarse'}}),
 ]);
 return {encode(encoder:GPUCommandEncoder,view:CompletedMapRead){
  const {level,x,y,width,height}=view;
  if(![level,x,y,width,height].every(Number.isSafeInteger)||level<0||level>=coarse.pageLevel+coarse.layout.levels.length||width<1||height<1||width>8192||height>8192||width*height*4>device.limits.maxStorageBufferBindingSize||Math.abs(x)+width>0x3fffffff||Math.abs(y)+height>0x3fffffff)throw new RangeError('Invalid completed map read');
  const output=device.createBuffer({size:width*height*4,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC}),temporary:GPUBuffer[]=[];let dispatches=0,pages=0;
  if(level>=coarse.pageLevel){
   const source=coarse.layout.levels[level-coarse.pageLevel],params=upload(device,new Uint32Array([width,height,source.width,source.height,x,y,source.wordOffset,0]),GPUBufferUsage.UNIFORM);temporary.push(params);
   const group=device.createBindGroup({layout:coarsePipeline.getBindGroupLayout(0),entries:[params,coarse.buffer,output].map((buffer,binding)=>({binding,resource:{buffer}}))});
   const pass=encoder.beginComputePass();pass.setPipeline(coarsePipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(Math.ceil(width/8),Math.ceil(height/8));pass.end();dispatches++;
  }else{
   const side=512>>level,groups=new Map<number,number[]>();
   for(let row=Math.max(0,Math.floor(y/side));row<Math.min(rows,Math.ceil((y+height)/side));row++)for(let col=Math.max(0,Math.floor(x/side));col<Math.min(columns,Math.ceil((x+width)/side));col++){
    const slot=slots[row*columns+col];if(!slot)continue;const atlasID=(slot>>>2)-1;if(atlases[atlasID].kind==='zero')continue;
    const local=slot&3,left=col*side,top=row*side,x0=Math.max(x,left),y0=Math.max(y,top),w=Math.min(x+width,left+side)-x0,h=Math.min(y+height,top+side)-y0,origin=1024-side*2;
    let pieces=groups.get(atlasID);if(!pieces){pieces=[];groups.set(atlasID,pieces);}pieces.push(origin+(local===1?side:0)+x0-left,origin+(local===2?side:0)+y0-top,x0-x,y0-y,w,h,0,0);pages++;
   }
   for(const [atlasID,pieces]of groups){
    const surface=atlases[atlasID];if(surface.kind==='zero')continue;
    const count=pieces.length/8;if(count>device.limits.maxComputeWorkgroupsPerDimension)throw new RangeError('Too many completed pieces');
    const params=upload(device,new Uint32Array([width,height,128,count]),GPUBufferUsage.UNIFORM),records=upload(device,Uint32Array.from(pieces),GPUBufferUsage.STORAGE);temporary.push(params,records);
    const buffers=[params,surface.directory,surface.payload,records,output],group=device.createBindGroup({layout:pagePipeline.getBindGroupLayout(0),entries:buffers.map((buffer,binding)=>({binding,resource:{buffer}}))});
    let w=0,h=0;for(let i=0;i<count;i++){w=Math.max(w,pieces[i*8+4]);h=Math.max(h,pieces[i*8+5]);}
    const pass=encoder.beginComputePass();pass.setPipeline(pagePipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(Math.ceil(w/8),Math.ceil(h/8),count);pass.end();dispatches++;
   }
  }
  return {buffer:output,width,height,dispatches,pages,temporaryBytes:temporary.reduce((n,b)=>n+b.size,0),disposeInputs(){temporary.forEach(b=>b.destroy());}};
 }};
}
