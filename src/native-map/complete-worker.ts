/// <reference types="@webgpu/types" />
import {browserNativeAssets} from './browser-assets';
import {createCompleteMapRuntime} from './gpu/runtime/complete-map';
import {createCompletedMapReader} from './gpu/completed-map-read';
import {readBuffer} from './gpu/buffers';
import materialUrl from './complete-materials/complete-materials.wasm?url';
import edgeUrl from './edges/core.wasm?url';
import correctionUrl from './gpu/materials/correct.wasm?url';

const worker=self as unknown as DedicatedWorkerGlobalScope;
let setup:Promise<{device:GPUDevice;runtime:Awaited<ReturnType<typeof createCompleteMapRuntime>>}>|undefined;
let current:{generationId:number;reader:Awaited<ReturnType<typeof createCompletedMapReader>>}|undefined;
let queue:Promise<unknown>=Promise.resolve();const requests=new Map<number,AbortController>();
async function prepare(){
 return setup??=(async()=>{
  const gpu=(worker.navigator as WorkerNavigator&{gpu?:GPU}).gpu;
  if(!gpu)throw new Error('The native complete-map test requires WebGPU in this browser.');
  const adapter=await gpu.requestAdapter({powerPreference:'high-performance'});if(!adapter)throw new Error('No WebGPU adapter is available.');
  if(adapter.limits.maxStorageBuffersPerShaderStage<8)throw new Error('The GPU does not support eight compute storage buffers.');
  const device=await adapter.requestDevice({requiredLimits:{maxStorageBuffersPerShaderStage:8,maxStorageBufferBindingSize:adapter.limits.maxStorageBufferBindingSize,maxBufferSize:adapter.limits.maxBufferSize}});
  const errors:string[]=[];device.addEventListener('uncapturederror',event=>{errors.push(event.error.message);console.error('[Native complete] GPU error',event.error.message);});
  device.lost.then(info=>{current=undefined;worker.postMessage({type:'fatal',error:`Native GPU device lost: ${info.message}`});});
  const [materialModule,edgeModule,correctionModule]=await Promise.all([materialUrl,edgeUrl,correctionUrl].map(async url=>{
   const response=await fetch(url);if(!response.ok)throw new Error(`Native map input failed: ${response.status}`);return WebAssembly.compile(await response.arrayBuffer());
  }));
  const runtime=await createCompleteMapRuntime({device,assets:browserNativeAssets,materialModule,edgeModule,correctionModule});
  if(errors.length)throw new Error(errors.join('\n'));
  console.info('[Native complete] Runtime ready',{adapter:adapter.info.description||adapter.info.architecture});
  return{device,runtime};
 })().catch(error=>{setup=undefined;throw error;});
}
worker.onmessage=({data})=>{
 if(data.type==='cancel'){requests.get(data.id)?.abort();return;}
 const controller=new AbortController();requests.set(data.id,controller);
 const work=queue.then(async()=>{
  controller.signal.throwIfAborted();const {device,runtime}=await prepare();controller.signal.throwIfAborted();
  if(data.type==='generate'){
   current=undefined;let last=-1;
   device.pushErrorScope('validation');device.pushErrorScope('out-of-memory');
   let result:Awaited<ReturnType<typeof runtime.generate>>;
   try{result=await runtime.generate(data.request,{signal:controller.signal,onProgress:progress=>{
     worker.postMessage({id:data.id,type:'progress',progress});
     const step=Math.floor(10*progress.completedPages/Math.max(1,progress.totalPages));if(step!==last){last=step;console.info('[Native complete] Progress',progress);}
    }});
   }finally{
    const allocationError=await device.popErrorScope(),validationError=await device.popErrorScope();
    if(allocationError||validationError)throw new Error((allocationError??validationError)!.message);
   }
   controller.signal.throwIfAborted();const reader=await createCompletedMapReader(device,result.map);controller.signal.throwIfAborted();current={generationId:data.id,reader};
   console.info('[Native complete] All nine regions complete',{seed:result.world.seed,timings:result.timings,memory:result.memory});
   // Scene metadata can share immutable authored arrays. Structured-clone the
   // description; never detach a reusable source image or modifier table.
   worker.postMessage({id:data.id,ok:true,result:{generationId:data.id,world:result.world,grid:result.grid,timings:result.timings,memory:result.memory}});
  }else if(data.type==='read'){
   if(!current||current.generationId!==data.generationId)throw new DOMException('Map replaced','AbortError');
   const encoder=device.createCommandEncoder(),job=current.reader.encode(encoder,data.view);
   try{device.queue.submit([encoder.finish()]);const pixels=await readBuffer(device,job.buffer,job.buffer.size);controller.signal.throwIfAborted();
    worker.postMessage({id:data.id,ok:true,result:{pixels:pixels.buffer,width:job.width,height:job.height}},[pixels.buffer]);
   }finally{job.disposeInputs();job.buffer.destroy();}
  }else throw new Error('Unknown native map request');
 }).catch(error=>worker.postMessage({id:data.id,ok:false,error:error instanceof Error?error.message:String(error),name:error?.name??'Error'})).finally(()=>requests.delete(data.id));
 queue=work.then(()=>undefined,()=>undefined);
};
