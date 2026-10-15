/// <reference types="@webgpu/types" />
import {compositionWGSL,mipWGSL,mipLayout,packCompositionAssets,packCompositionPage} from './composition-compute';

/** Share the tested integer composer; only address/dispatch plumbing changes. */
function replace(source:string,from:string,to:string){if(!source.includes(from))throw new Error(`Missing batch shader anchor: ${from}`);return source.replace(from,to);}
let finishSource=replace(compositionWGSL,'@group(0) @binding(0) var<uniform> p:Params;',`
struct Batch { count:u32, unused0:u32, unused1:u32, unused2:u32 }
@group(0) @binding(0) var<uniform> batch:Batch;
var<private> p:Params;
var<private> materialAt:u32;
var<private> outputAt:u32;
var<private> binAt:u32;
var<private> liquidAt:u32;`);
finishSource=replace(finishSource,' let col=invocation.x;',`
 if(invocation.z>=batch.count){return;}
 let at=invocation.z*20u;
 p=Params(page[at],page[at+1u],page[at+2u],page[at+3u],
   bitcast<i32>(page[at+4u]),bitcast<i32>(page[at+5u]),page[at+6u],page[at+7u],
   page[at+8u],page[at+9u],page[at+10u],page[at+11u],
   bitcast<i32>(page[at+12u]),bitcast<i32>(page[at+13u]),page[at+14u],page[at+15u]);
 binAt=page[at+16u];materialAt=page[at+17u];outputAt=page[at+18u];liquidAt=page[at+19u];
 let col=invocation.x;`);
finishSource=replace(finishSource,'let mi=(row+p.pad)*p.haloWidth+col+p.pad;','let mi=materialAt+(row+p.pad)*p.haloWidth+col+p.pad;');
finishSource=replace(finishSource,'let bin=((row/16u)*p.binCols+col/16u)*4u;','let bin=binAt+((row/16u)*p.binCols+col/16u)*4u;');
finishSource=replace(finishSource,'let l=page[page[bin+2u]+k]*8u;','let l=liquidAt+page[page[bin+2u]+k]*8u;');
finishSource=replace(finishSource,'output[i]=result;','output[outputAt+i]=result;');
let reduceSource=replace(mipWGSL,'outHeight:u32}','outHeight:u32,inAt:u32,outAt:u32,pitch:u32,count:u32}');
reduceSource=replace(reduceSource,'@group(0) @binding(1) var<storage,read> source:array<u32>;\n@group(0) @binding(2) var<storage,read_write> output:array<u32>;','@group(0) @binding(1) var<storage,read_write> pixels:array<u32>;');
reduceSource=replace(reduceSource,'if(id.x>=p.outWidth || id.y>=p.outHeight)','if(id.x>=p.outWidth || id.y>=p.outHeight || id.z>=p.count)');
reduceSource=replace(reduceSource,'source[y*p.width+x]','pixels[id.z*p.pitch+p.inAt+y*p.width+x]');
reduceSource=replace(reduceSource,'output[id.y*p.outWidth+id.x]','pixels[id.z*p.pitch+p.outAt+id.y*p.outWidth+id.x]');

type PackedPage=ReturnType<typeof packCompositionPage>;
function upload(device:GPUDevice,value:Uint32Array,usage=GPUBufferUsage.STORAGE){
 const size=Math.max(4,value.byteLength);if(size>device.limits.maxBufferSize||(usage===GPUBufferUsage.STORAGE&&size>device.limits.maxStorageBufferBindingSize))throw new RangeError('Batched composition input exceeds device limits');
 const result=device.createBuffer({size,usage:usage|GPUBufferUsage.COPY_DST});if(value.length)device.queue.writeBuffer(result,0,value.buffer as ArrayBuffer,value.byteOffset,value.byteLength);return result;
}
export async function createBatchedGpuComposition(device:GPUDevice,assets:ReturnType<typeof packCompositionAssets>){
 const began=performance.now();
 const [finish,reduce]=await Promise.all([
  device.createComputePipelineAsync({layout:'auto',compute:{module:device.createShaderModule({code:finishSource}),entryPoint:'finish'}}),
  device.createComputePipelineAsync({layout:'auto',compute:{module:device.createShaderModule({code:reduceSource}),entryPoint:'reduce'}}),
 ]);
 const textures=upload(device,assets.textures),fallbackScenes=upload(device,assets.scenes);
 return {initializationMs:performance.now()-began,sharedBytes:textures.size+fallbackScenes.size,
  encode(encoder:GPUCommandEncoder,pages:readonly PackedPage[],input:{materials:GPUBuffer;edges:GPUBuffer;scenes?:GPUBuffer;legacy?:GPUBuffer;materialOffsets:readonly number[];hasLegacy?:readonly boolean[]}){
   if(!pages.length||pages.length>32||input.materialOffsets.length!==pages.length)throw new RangeError('Invalid composition batch');
   const width=pages[0].params[0],height=pages[0].params[1],layout=mipLayout(width,height),pitchWords=layout.words;
   if(pages.some(p=>p.params[0]!==width||p.params[1]!==height))throw new Error('Batch pages must have identical dimensions');
   if(pitchWords*pages.length*4>device.limits.maxStorageBufferBindingSize)throw new RangeError('Batched completed pixels exceed binding limit');
   const pageData=new Uint32Array(pages.length*20+pages.reduce((n,p)=>n+p.page.length,0));
   const liquids=new Uint32Array(pages.reduce((n,p)=>n+p.liquids.length,0));let pageAt=pages.length*20,liquidAt=0;
   for(let id=0;id<pages.length;id++){
    const p=pages[id],record=id*20,materialAt=input.materialOffsets[id],haloWords=p.params[3]*(height+64);
    if(!Number.isSafeInteger(materialAt)||materialAt<0||(materialAt+haloWords)*4>input.materials.size||(materialAt+haloWords)*4>input.edges.size||
      (input.hasLegacy?.[id]&&(!input.legacy||(materialAt+haloWords)*4>input.legacy.size)))throw new RangeError('Incomplete batched material/edge/color inputs');
    pageData.set(p.params,record);pageData[record+10]+=pageAt;pageData[record+11]+=pageAt;
    pageData[record+14]=+!!input.hasLegacy?.[id];pageData.set([pageAt,materialAt,id*pitchWords,liquidAt],record+16);
    pageData.set(p.page,pageAt);const bins=p.params[8]*p.params[9];
    for(let bin=0;bin<bins;bin++){pageData[pageAt+bin*4]+=pageAt;pageData[pageAt+bin*4+2]+=pageAt;}
    liquids.set(p.liquids,liquidAt);
    // The first bottom-row payload starts immediately after the descriptor
    // array; its offset therefore gives the exact descriptor count.
    const liquidCount=p.liquids.length?p.liquids[6]/8:0;
    if(!Number.isInteger(liquidCount)||liquidCount<0||liquidCount*8>p.liquids.length)throw new Error('Invalid packed liquid descriptors');
    for(let liquid=0;liquid<liquidCount;liquid++)liquids[liquidAt+liquid*8+6]+=liquidAt;
    pageAt+=p.page.length;liquidAt+=p.liquids.length;
   }
   const parameters=upload(device,new Uint32Array([pages.length,0,0,0]),GPUBufferUsage.UNIFORM),pageBuffer=upload(device,pageData),liquidBuffer=upload(device,liquids),temporary=[parameters,pageBuffer,liquidBuffer];
   const output=device.createBuffer({size:pitchWords*pages.length*4,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC});
   const resources=[parameters,input.materials,textures,input.scenes??fallbackScenes,pageBuffer,liquidBuffer,input.edges,output,input.legacy??input.materials];
   const group=device.createBindGroup({layout:finish.getBindGroupLayout(0),entries:resources.map((buffer,binding)=>({binding,resource:{buffer}}))});
   let pass=encoder.beginComputePass();pass.setPipeline(finish);pass.setBindGroup(0,group);pass.dispatchWorkgroups(Math.ceil(width/8),Math.ceil(height/8),pages.length);pass.end();
   for(let level=1;level<layout.levels.length;level++){
    const source=layout.levels[level-1],target=layout.levels[level],params=upload(device,new Uint32Array([source.width,source.height,target.width,target.height,source.wordOffset,target.wordOffset,pitchWords,pages.length]),GPUBufferUsage.UNIFORM);temporary.push(params);
    const bindings=device.createBindGroup({layout:reduce.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:params}},{binding:1,resource:{buffer:output}}]});
    pass=encoder.beginComputePass();pass.setPipeline(reduce);pass.setBindGroup(0,bindings);pass.dispatchWorkgroups(Math.ceil(target.width/8),Math.ceil(target.height/8),pages.length);pass.end();
   }
   return {buffer:output,layout,pitchWords,pages:pages.map((_,id)=>({wordOffset:id*pitchWords,byteOffset:id*pitchWords*4})),dispatches:layout.levels.length,
    temporaryBytes:temporary.reduce((n,b)=>n+b.size,0),disposeInputs(){temporary.forEach(b=>b.destroy());}};
  },destroy(){textures.destroy();fallbackScenes.destroy();},
 };
}
