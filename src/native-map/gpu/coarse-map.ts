/// <reference types="@webgpu/types" />
import {mipLayout} from './composition-compute';

/** Join ALREADY completed page mips into a small continuous overview. This
 * avoids visiting thousands of compressed native atlases when drawing a wide
 * view. No terrain evaluation, filtering or approximation occurs in this pass. */
const shader=`
struct Params { width:u32, height:u32, side:u32, count:u32 }
@group(0) @binding(0) var<uniform> p:Params;
@group(0) @binding(1) var<storage,read> source:array<u32>;
@group(0) @binding(2) var<storage,read> records:array<vec4u>;
@group(0) @binding(3) var<storage,read_write> pixels:array<u32>;
@compute @workgroup_size(8,8)
fn join(@builtin(global_invocation_id) id:vec3u){
 if(id.z>=p.count || id.x>=p.side || id.y>=p.side){return;}
 let record=records[id.z];
 let x=record.y*p.side+id.x;let y=record.z*p.side+id.y;
 pixels[y*p.width+x]=source[record.x+id.y*p.side+id.x];
}`;
export interface CompletedPageMipCopy {sourceWordOffset:number;column:number;row:number}
export async function createGpuCoarseMap(device:GPUDevice,columns:number,rows:number,pageLevel=6){
 if(![columns,rows].every(v=>Number.isSafeInteger(v)&&v>0)||!Number.isInteger(pageLevel)||pageLevel<0||pageLevel>9)
  throw new RangeError('Invalid completed overview dimensions');
 const side=512>>pageLevel,width=columns*side,height=rows*side,layout=mipLayout(width,height);
 if(layout.words*4>device.limits.maxStorageBufferBindingSize)throw new RangeError('Completed overview exceeds the device binding limit');
 const pipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module:device.createShaderModule({code:shader}),entryPoint:'join'}});
 const pixels=device.createBuffer({size:layout.words*4,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC|GPUBufferUsage.COPY_DST});
 let disposed=false;
 return {buffer:pixels,width,height,pageLevel,side,layout,
  /** Record before the caller's final overview reductions. Multiple placements
   * may borrow one source page, but destinations in a dispatch must be unique.
   * The caller owns the complete-map barrier and the source-buffer lifetime. */
  encodePages(encoder:GPUCommandEncoder,source:GPUBuffer,copies:readonly CompletedPageMipCopy[]){
   if(disposed)throw new Error('Completed overview disposed');
   if(!copies.length)return{temporaryBytes:0,disposeInputs(){}};
   if(copies.length>device.limits.maxComputeWorkgroupsPerDimension)throw new RangeError('Too many overview copy records');
   const words=new Uint32Array(copies.length*4),seen=new Set<number>();
   copies.forEach((copy,i)=>{
    const {sourceWordOffset:at,column,row}=copy,id=row*columns+column;
    if(![at,column,row].every(Number.isSafeInteger)||at<0||(at+side*side)*4>source.size||column<0||row<0||column>=columns||row>=rows||seen.has(id))
     throw new RangeError('Invalid or duplicate completed overview page');
    seen.add(id);words.set([at,column,row,0],i*4);
   });
   const parameters=device.createBuffer({size:16,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});device.queue.writeBuffer(parameters,0,new Uint32Array([width,height,side,copies.length]));
   const records=device.createBuffer({size:words.byteLength,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});device.queue.writeBuffer(records,0,words);
   const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[parameters,source,records,pixels].map((buffer,binding)=>({binding,resource:{buffer}}))});
   const pass=encoder.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(Math.ceil(side/8),Math.ceil(side/8),copies.length);pass.end();
   return{temporaryBytes:16+words.byteLength,disposeInputs(){parameters.destroy();records.destroy();}};
  },destroy(){if(!disposed){disposed=true;pixels.destroy();}},
 };
}
