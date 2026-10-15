import{readBuffer,uploadBuffer}from'../buffers.ts';
import type{LegacyColorResolver}from'../../cook-inputs/legacy.ts';
const source=/*wgsl*/`
struct Params{width:u32,height:u32,stride:u32,offset_x:u32,offset_y:u32,count:u32,pad0:u32,pad1:u32}
struct List{count:atomic<u32>,pending:atomic<u32>,pad0:u32,pad1:u32,indices:array<u32>}
@group(0)@binding(0)var<uniform>p:Params;
@group(0)@binding(1)var<storage,read>materials:array<i32>;
@group(0)@binding(2)var<storage,read_write>list:List;
@compute@workgroup_size(8,8)fn collect(@builtin(global_invocation_id)id:vec3u){
 if(id.x>=p.width||id.y>=p.height){return;}let index=id.y*p.width+id.x;
 let material=materials[(id.y+p.offset_y)*p.stride+id.x+p.offset_x];
 if(material< -1){atomicStore(&list.pending,1u);return;}
 if(material== -1){let at=atomicAdd(&list.count,1u);list.indices[at]=index;}
}`;
const patchSource=/*wgsl*/`
struct Params{count:u32,pad0:u32,pad1:u32,pad2:u32}
@group(0)@binding(0)var<uniform>p:Params;
@group(0)@binding(1)var<storage,read>patches:array<vec2u>;
@group(0)@binding(2)var<storage,read_write>colors:array<u32>;
@compute@workgroup_size(64)fn main(@builtin(global_invocation_id)id:vec3u){
 if(id.x>=p.count){return;}let value=patches[id.x];colors[value.x]=value.y;
}`;
const pipelines=new WeakMap<object,Promise<any>>();
interface MaterialJob{x:number;y:number;width:number;height:number;targetWidth:number;targetHeight:number;offsetX:number;offsetY:number;materialBuffer:any}
interface Rect{x:number;y:number;width:number;height:number}
interface ExactClassifier{correct(x:number,y:number,width:number,height:number,indices:Uint32Array):{patches:Int32Array;stats:any}}

/** Sparse exact legacy COLOR completion. Material IDs and their edge/liquid
 * meanings are untouched. Only source classifications3..7 invoke colorAt. */
export async function createExactLegacyCompute(device:any,legacy:LegacyColorResolver,exact:ExactClassifier){
 if(typeof legacy.colorAt!=='function')throw Error('An exact legacy color resolver is required');
 const begin=performance.now();let promise=pipelines.get(device);if(!promise){promise=(async()=>{const scanModule=device.createShaderModule({code:source,label:'compact legacy index collector'}),patchModule=device.createShaderModule({code:patchSource,label:'exact legacy color patcher'});return Promise.all([device.createComputePipelineAsync({layout:'auto',compute:{module:scanModule,entryPoint:'collect'}}),device.createComputePipelineAsync({layout:'auto',compute:{module:patchModule,entryPoint:'main'}})]);})();pipelines.set(device,promise);}
 const[scan,patch]=await promise,initializationMs=performance.now()-begin;
 return{initializationMs,async resolve(job:MaterialJob,region:Rect={x:job.x,y:job.y,width:job.width,height:job.height}){
  const started=performance.now(),rx=region.x-job.x,ry=region.y-job.y;
  if(![region.x,region.y,region.width,region.height].every(Number.isSafeInteger)||rx<0||ry<0||region.width<1||region.height<1||rx+region.width>job.width||ry+region.height>job.height)throw Error('Legacy color region exceeds the exact material field');
  const count=region.width*region.height,ox=job.offsetX+rx,oy=job.offsetY+ry,usage=(globalThis as any).GPUBufferUsage;
  const params=uploadBuffer(device,Uint32Array.from([region.width,region.height,job.targetWidth,ox,oy,count,0,0]),usage.UNIFORM),list=device.createBuffer({size:16+count*4,usage:usage.STORAGE|usage.COPY_SRC|usage.COPY_DST});
  let patchBuffer:any,patchParams:any,colors:any;
  try{
   const group=device.createBindGroup({layout:scan.getBindGroupLayout(0),entries:[params,job.materialBuffer,list].map((buffer,binding)=>({binding,resource:{buffer}}))}),encoder=device.createCommandEncoder();encoder.clearBuffer(list,0,16);const pass=encoder.beginComputePass();pass.setPipeline(scan);pass.setBindGroup(0,group);pass.dispatchWorkgroups(Math.ceil(region.width/8),Math.ceil(region.height/8));pass.end();let at=performance.now();device.queue.submit([encoder.finish()]);await device.queue.onSubmittedWorkDone();const scanMs=performance.now()-at;
   at=performance.now();const headerBytes=await readBuffer(device,list,16),header=new Uint32Array(headerBytes.buffer);if(header[1]||header[0]>count)throw Error('Pending or invalid material reached legacy completion');const n=header[0],indexBytes=n?await readBuffer(device,list,n*4,16):new Uint8Array(0),indices=new Uint32Array(indexBytes.buffer),readbackMs=performance.now()-at;
   // The compact list is no longer needed onGPU before patch allocation.
   const listBytes=list.size,uniformBytes=params.size;list.destroy();params.destroy();
   at=performance.now();const materialIndices=Uint32Array.from(indices,i=>(ry+Math.floor(i/region.width))*job.width+rx+i%region.width),classified=n?exact.correct(job.x,job.y,job.width,job.height,materialIndices):{patches:new Int32Array(0),stats:{queries:0,totalMs:0}},classificationMs=performance.now()-at;
   const patches=new Uint32Array(n*2);let eligible=0,nonzero=0,excluded=0;
   at=performance.now();for(let i=0;i<n;i++){
    const classification=classified.patches[i*4+2];if(classification<3||classification>7){excluded++;continue;}
    const index=indices[i],column=index%region.width,row=Math.floor(index/region.width),argb=legacy.colorAt(region.x+column,region.y+row);
    if(!Number.isInteger(argb)||argb<0||argb>0xffffffff)throw Error('Invalid exact legacy color');
    eligible++;if(argb===0)continue;nonzero++;const rgba=((argb&0xff00ff00)|((argb>>>16)&255)|((argb&255)<<16))>>>0;
    patches[(nonzero-1)*2]=(row+oy)*job.targetWidth+column+ox;patches[(nonzero-1)*2+1]=rgba;
   }const exactColorMs=performance.now()-at;let patchUploadMs=0,patchDispatchMs=0;
   if(nonzero){at=performance.now();colors=device.createBuffer({size:job.targetWidth*job.targetHeight*4,usage:usage.STORAGE|usage.COPY_SRC|usage.COPY_DST,label:'exact legacy RGBA (R low byte)'});patchBuffer=uploadBuffer(device,patches.subarray(0,nonzero*2));patchParams=uploadBuffer(device,Uint32Array.from([nonzero,0,0,0]),usage.UNIFORM);const group=device.createBindGroup({layout:patch.getBindGroupLayout(0),entries:[patchParams,patchBuffer,colors].map((buffer,binding)=>({binding,resource:{buffer}}))}),encoder=device.createCommandEncoder();encoder.clearBuffer(colors);const pass=encoder.beginComputePass();pass.setPipeline(patch);pass.setBindGroup(0,group);pass.dispatchWorkgroups(Math.ceil(nonzero/64));pass.end();patchUploadMs=performance.now()-at;at=performance.now();device.queue.submit([encoder.finish()]);await device.queue.onSubmittedWorkDone();patchDispatchMs=performance.now()-at;}
   return{buffer:colors,stats:{scanPixels:count,negativeMaterialPixels:n,classificationQueries:n,eligibleColorQueries:eligible,excludedClassifications:excluded,nonzeroColorPixels:nonzero,scanMs,readbackMs,classificationMs,classification:classified.stats,exactColorMs,patchUploadMs,patchDispatchMs,readbackBytes:16+n*4,patchUploadBytes:nonzero*8,outputBytes:colors?.size??0,peakTemporaryGpuBytes:Math.max(uniformBytes+listBytes+Math.max(16,n*4),nonzero*8+16),temporaryCpuBytes:indices.byteLength+materialIndices.byteLength+classified.patches.byteLength+patches.byteLength,totalMs:performance.now()-started,ready:true}};
  }catch(error){colors?.destroy();throw error;}finally{params.destroy();list.destroy();patchBuffer?.destroy();patchParams?.destroy();}
 }};
}
