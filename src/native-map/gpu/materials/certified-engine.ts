import{createMaterialCompute,prepareMaterialComputeSetup}from'./material-compute.mjs';
import{createExactCorrector}from'./exact-corrector.ts';
import{createExactLegacyCompute}from'./exact-legacy.ts';
import{CLASSIC,CUSTOM}from'./noise-tables.mjs';
import{readBuffer,uploadBuffer}from'../buffers.ts';
import type{CompleteMaterialInputs}from'../../complete-materials/index.ts';
import type{LegacyColorResolver}from'../../cook-inputs/legacy.ts';
const patchSource=(diagnostics:boolean)=>`
struct Params{count:u32,width:u32,stride:u32,x:u32,y:u32,pixels:u32,pad0:u32,pad1:u32}
@group(0)@binding(0)var<uniform>p:Params;
@group(0)@binding(1)var<storage,read>patches:array<vec4i>;
@group(0)@binding(2)var<storage,read_write>materials:array<i32>;
${diagnostics?'@group(0)@binding(3)var<storage,read_write>diagnostics:array<u32>;':''}
@compute@workgroup_size(64)fn main(@builtin(global_invocation_id)gid:vec3u){
 let i=gid.x;if(i>=p.count){return;}let v=patches[i];let n=u32(v.x);materials[(n/p.width+p.y)*p.stride+n%p.width+p.x]=v.y;
 ${diagnostics?'diagnostics[4u+n]=bitcast<u32>(v.z);diagnostics[4u+p.pixels+n]=bitcast<u32>(v.w);':''}
}`;
const patchPipelines=new WeakMap<object,Map<boolean,Promise<any>>>();
function getPatchPipeline(device:any,diagnostics:boolean){
 let cache=patchPipelines.get(device);if(!cache){cache=new Map();patchPipelines.set(device,cache);}let pipeline=cache.get(diagnostics);if(!pipeline){pipeline=device.createComputePipelineAsync({layout:'auto',compute:{module:device.createShaderModule({code:patchSource(diagnostics)}),entryPoint:'main'}});cache.set(diagnostics,pipeline!);}return pipeline!;
}
/** Seed-free reusable shader setup, including lazy candidate/patch compilation. */
export async function prepareCertifiedMaterialSetup(device:any,{diagnostics=false}:{diagnostics?:boolean}={}){
 const start=performance.now(),candidate=await prepareMaterialComputeSetup(device,{diagnostics}),begin=performance.now(),pipeline=await getPatchPipeline(device,diagnostics),compileMs=performance.now()-begin;
 const params=uploadBuffer(device,new Uint32Array(8),(globalThis as any).GPUBufferUsage.UNIFORM),patches=uploadBuffer(device,new Int32Array(4)),materials=uploadBuffer(device,new Int32Array(1)),extra=diagnostics?uploadBuffer(device,new Uint32Array(1)):null,buffers=extra?[params,patches,materials,extra]:[params,patches,materials];
 try{const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:buffers.map((buffer,binding)=>({binding,resource:{buffer}}))}),encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(1);pass.end();const at=performance.now();device.queue.submit([encoder.finish()]);await device.queue.onSubmittedWorkDone();return{...candidate,patch:{compileMs,dispatchMs:performance.now()-at,temporaryBytes:buffers.reduce((n,b)=>n+b.size,0)},totalMs:performance.now()-start};}finally{buffers.forEach(b=>b.destroy());}
}

/** Returns only repaired GPU fields. Uses a caller-supplied GPUDevice and correction module. */
export async function createCertifiedMaterialEngine(device:any,input:CompleteMaterialInputs,{correctionModule,diagnostics=false,legacy}:{correctionModule:WebAssembly.Module,diagnostics?:boolean,legacy?:LegacyColorResolver}){
 const started=performance.now(),patchPipeline=getPatchPipeline(device,diagnostics);
 const exact=await createExactCorrector(input,correctionModule);
 const[gpu,patch,legacyGpu]=await Promise.all([createMaterialCompute(device,input,{classic:CLASSIC,custom:CUSTOM,diagnostics,cave:exact}),patchPipeline,legacy?createExactLegacyCompute(device,legacy,exact):null]);
 let destroyed=false;const initialization={totalMs:performance.now()-started,gpu:gpu.initialization,exactMemoryBytes:exact.memoryBytes,exactPreparationMs:exact.preparationMs,legacyInitializationMs:legacyGpu?.initializationMs??0};
 async function resolveRect(rect:{x:number,y:number,width:number,height:number,targetWidth?:number,targetHeight?:number,offsetX?:number,offsetY?:number,legacy?:boolean},legacyRegion?:{x:number,y:number,width:number,height:number}){
  if(destroyed)throw Error('Material engine disposed');const total=performance.now(),encoder=device.createCommandEncoder(),job=gpu.encodeRect(encoder,rect);let start=performance.now();device.queue.submit([encoder.finish()]);await device.queue.onSubmittedWorkDone();const dispatchMs=performance.now()-start;
  try{
   start=performance.now();const headerBytes=await readBuffer(device,job.diagnosticBuffer,16),header=new Uint32Array(headerBytes.buffer);if(header[1]||header[0]>job.count)throw Error('Material correction list overflow');const n=header[0];let topo0=0,unsupported=0,numeric=0;const reasons:Record<string,number>={};
   let bytes=new Uint8Array(0);if(n)bytes=await readBuffer(device,job.diagnosticBuffer,n*4,job.correctionListOffsetBytes);const list=new Uint32Array(bytes.buffer),indices=new Uint32Array(n);
   for(let i=0;i<n;i++){indices[i]=list[i]&0xfffff;const reason=list[i]>>>20;reasons[reason]=(reasons[reason]??0)+1;if(reason&512)topo0++;else if(reason&128)unsupported++;else numeric++;}
   const correctionReadbackMs=performance.now()-start;let correctionStats:any={queries:0,totalMs:0,copyAndTrigMs:0,kernelMs:0,copyAndCheckMs:0},patchUploadMs=0,patchDispatchMs=0;
   if(n){const result=exact.correct(job.x,job.y,job.width,job.height,indices);correctionStats=result.stats;
    start=performance.now();const patchBuffer=uploadBuffer(device,result.patches),params=uploadBuffer(device,Uint32Array.from([n,job.width,job.targetWidth,job.offsetX,job.offsetY,job.count,0,0]),(globalThis as any).GPUBufferUsage.UNIFORM);
    const buffers=diagnostics?[params,patchBuffer,job.materialBuffer,job.diagnosticBuffer]:[params,patchBuffer,job.materialBuffer],group=device.createBindGroup({layout:patch.getBindGroupLayout(0),entries:buffers.map((buffer,binding)=>({binding,resource:{buffer}}))}),encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();pass.setPipeline(patch);pass.setBindGroup(0,group);pass.dispatchWorkgroups(Math.ceil(n/64));pass.end();patchUploadMs=performance.now()-start;
    start=performance.now();device.queue.submit([encoder.finish()]);await device.queue.onSubmittedWorkDone();patchDispatchMs=performance.now()-start;patchBuffer.destroy();params.destroy();
   }
   const legacyJob=legacyGpu&&rect.legacy!==false?await legacyGpu.resolve(job,legacyRegion):null;
   return{...job,legacyColorBuffer:legacyJob?.buffer,bufferWidth:job.targetWidth,bufferHeight:job.targetHeight,originX:job.x-job.offsetX,originY:job.y-job.offsetY,destroy(){job.destroy();legacyJob?.buffer?.destroy();},stats:{...job.stats,outputBytes:job.stats.outputBytes+(legacyJob?.stats.outputBytes??0),queries:job.count,accepted:job.count-n,corrected:n,topo0,unsupported,numeric,reasons,dispatchMs,correctionReadbackMs,correction:correctionStats,patchUploadMs,patchDispatchMs,correctionReadbackBytes:16+n*4,patchUploadBytes:n*16,legacy:legacyJob?.stats??null,totalMs:performance.now()-total,ready:true}};
  }catch(error){job.destroy();throw error;}
 }
 return{initialization,resolveRect,resolvePage(page:{x:number,y:number,width:number,height:number},options:{legacy?:boolean}={}){return resolveRect({x:page.x-21,y:page.y-21,width:page.width+42,height:page.height+42,targetWidth:page.width+64,targetHeight:page.height+64,offsetX:11,offsetY:11,legacy:options.legacy},page);},resolveExactRect:exact.resolveExactRect,resolveCoverageBandPoints:exact.resolveCoverageBandPoints,selectBandPoints:exact.selectBandPoints,statistics:exact.statistics,axisCacheStatistics:gpu.axisCacheStatistics,destroy(){if(!destroyed){destroyed=true;gpu.destroy();}}};
}
