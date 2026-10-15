// Exact batched owned edge core. See EDGE-BATCH.txt and LICENSE-telescope.txt.
import { prepareGpuEdgeTables } from './edge-compute.mjs';
import { batchEdgeShader, sceneCopyShader } from './edge-batch-shader.mjs';

const SIDE=640,WORDS=24,MAX_PAGES=8;
const integer=(n,lo,hi)=>Number.isSafeInteger(n)&&n>=lo&&n<=hi;
function upload(device,data,usage,label){const b=device.createBuffer({label,size:Math.max(4,data.byteLength),usage:usage|GPUBufferUsage.COPY_DST});if(data.byteLength)device.queue.writeBuffer(b,0,data);return b;}
function seamIntervals(origin,first,end){const out=[];for(let boundary=Math.floor((origin+first)/512)*512-512;boundary<origin+end+512;boundary+=512){const left=Math.max(first,boundary-8-origin),right=Math.min(end,boundary+8-origin);if(right>left)out.push([left,right]);}return out;}
function seamRectangles(ox,oy,left,top,right,bottom){
 if(right<=left||bottom<=top)return[];const xs=seamIntervals(ox,left,right),ys=seamIntervals(oy,top,bottom),out=[];
 for(const[y0,y1]of ys)out.push([left,y0,right-left,y1-y0]);let begin=top;
 for(const[y0,y1]of[...ys,[bottom,bottom]]){if(y0>begin)for(const[x0,x1]of xs)out.push([x0,begin,x1-x0,y0-begin]);begin=y1;}return out;
}
const pipelineCache=new WeakMap();
function getPipelines(device){let result=pipelineCache.get(device);if(result)return result;
 result=(async()=>{
  const shader=device.createShaderModule({label:'batched exact ordered edges',code:batchEdgeShader});
  const info=await shader.getCompilationInfo();if(info.messages.some(m=>m.type==='error'))throw Error(info.messages.map(m=>`${m.lineNum}:${m.linePos} ${m.message}`).join('\n'));
  const entries=[{binding:0,visibility:GPUShaderStage.COMPUTE,buffer:{type:'uniform',hasDynamicOffset:true,minBindingSize:32}},
   {binding:1,visibility:GPUShaderStage.COMPUTE,buffer:{type:'read-only-storage'}},
   ...[2,3,4,5,6].map(binding=>({binding,visibility:GPUShaderStage.COMPUTE,buffer:{type:'storage'}})),
   {binding:7,visibility:GPUShaderStage.COMPUTE,buffer:{type:'read-only-storage'}},
   {binding:8,visibility:GPUShaderStage.COMPUTE,buffer:{type:'storage'}}];
  const layout=device.createBindGroupLayout({entries}),resolveLayout=device.createBindGroupLayout({entries:entries.slice(0,8)});
  const mainLayout=device.createPipelineLayout({bindGroupLayouts:[layout]}),resolvePipelineLayout=device.createPipelineLayout({bindGroupLayouts:[resolveLayout]});
  const names=['prepare_phase','mutate_only','scatter','resolve_winners'];
  const pipelines=Object.fromEntries(await Promise.all(names.map(async entryPoint=>[entryPoint,await device.createComputePipelineAsync({layout:entryPoint==='resolve_winners'?resolvePipelineLayout:mainLayout,compute:{module:shader,entryPoint}})])));
  const clipLayout=device.createBindGroupLayout({entries:[{binding:0,visibility:GPUShaderStage.COMPUTE,buffer:{type:'uniform',hasDynamicOffset:true,minBindingSize:48}},
   {binding:1,visibility:GPUShaderStage.COMPUTE,buffer:{type:'read-only-storage'}},{binding:2,visibility:GPUShaderStage.COMPUTE,buffer:{type:'storage'}}]});
  const clip=await device.createComputePipelineAsync({layout:device.createPipelineLayout({bindGroupLayouts:[clipLayout]}),compute:{module:device.createShaderModule({code:sceneCopyShader}),entryPoint:'copy_scene'}});
  return{layout,resolveLayout,pipelines,clipLayout,clip};
 })();pipelineCache.set(device,result);return result;
}

/** Bounded batch entry. The caller submits, consumes the shared page offsets,
 * and destroys the job only after its final GPU consumers complete. */
export async function createBatchedGpuEdgeEngine(device,resources,{maxPages=MAX_PAGES}={}){
 if(!integer(maxPages,1,MAX_PAGES))throw Error('Batched edges support one through eight pages');
 const begin=performance.now(),prepared=prepareGpuEdgeTables(resources),prepareMs=performance.now()-begin;
 const pipelineAt=performance.now(),code=await getPipelines(device),pipelineMs=performance.now()-pipelineAt;
 const table=upload(device,prepared.data,GPUBufferUsage.STORAGE,'batched immutable edge tables');
 const canonicalMaxPages=Math.min(maxPages,Math.floor(device.limits.maxStorageBufferBindingSize/(576*576*prepared.maxEntries*8)),Math.floor((device.limits.maxStorageBufferBindingSize-24)/(576*576*12)));
 let destroyed=false;
 return{
  maxPages:canonicalMaxPages,stampReach:prepared.stampReach,
  initialization:{prepareMs,pipelineMs,totalMs:performance.now()-begin,resourceBytes:table.size,maxEntries:prepared.maxEntries,canonicalMaxPages},
  encodeBatch(encoder,{pages}){
   if(destroyed)throw Error('Batched edge engine disposed');if(!Array.isArray(pages)||!integer(pages.length,1,maxPages))throw Error('Invalid batched edge page count');
   const started=performance.now(),uploads=[],clips=[],pageData=[];let updateWords=0,totalPixels=0,sceneCount=0;
   const add=data=>{const at=updateWords;uploads.push({at,data});updateWords+=data.length;return at;};
   const reserve=n=>{const at=updateWords;updateWords+=n;return at;};
   for(let pageIndex=0;pageIndex<pages.length;pageIndex++){
    const input=pages[pageIndex],{width,height,x,y,seed}=input,shiftX=input.chunkShiftX??0,shiftY=input.chunkShiftY??0,inset=input.inset??0;
    const scenes=input.scenes??[],skipSeamAt=input.skipSeamAt,n=width*height;
    if(![width,height].every(v=>integer(v,1,SIDE))||![x,y].every(v=>integer(v,-0x3fffefff,0x3fffefff))||!integer(seed,-Number.MAX_SAFE_INTEGER,Number.MAX_SAFE_INTEGER)||
      ![shiftX,shiftY].every(v=>integer(v,-511,511))||!integer(inset,-640,640)||!Array.isArray(scenes)||typeof skipSeamAt!=='function')throw Error('Unsupported batched edge page');
    const materialOffsetWords=input.materialOffsetWords??0;
    if(input.materialBuffer){if(input.materials||!(input.materialBuffer.usage&GPUBufferUsage.COPY_SRC)||!integer(materialOffsetWords,0,0xffffffff)||(materialOffsetWords+n)*4>input.materialBuffer.size)throw Error('Invalid borrowed batch material source');}
    else if(!(input.materials instanceof Int16Array)||input.materials.length!==n||materialOffsetWords!==0)throw Error('Missing batch material source');
    const pixelOffsetWords=totalPixels;totalPixels+=n;
    const margin=Math.max(1,inset-prepared.stampReach),endX=Math.max(margin,width-margin),endY=Math.max(margin,height-margin),base=[width,height,x,y,seed>>>0,shiftX,shiftY,margin];
    const skip=new Uint32Array(16),skipAt=add(skip),baseX=Math.floor((x+shiftX)/512),baseY=Math.floor((y+shiftY)/512);
    for(let cy=baseY;cy<=Math.floor((y+height-1+shiftY)/512);cy++)for(let cx=baseX;cx<=Math.floor((x+width-1+shiftX)/512);cx++){
     const value=skipSeamAt(cx,cy);if(typeof value!=='boolean')throw Error('Unresolved batch seam policy');skip[(cy-baseY)*4+cx-baseX]=+value;
    }
    const rectangles=seamRectangles(x+shiftX,y+shiftY,margin,margin,endX,endY),seams=new Uint32Array(1+rectangles.length*5);seams[0]=rectangles.length;let seamCandidates=0;
    rectangles.forEach((r,i)=>{seamCandidates+=r[2]*r[3];seams.set([...r,seamCandidates],1+i*5);});const seamAt=add(seams);
    const phases=[{words:[...base,0,0,0,0,0,0,0,0,0,0,1,0],candidates:(endX-margin)*(endY-margin)},
     {words:[...base,1,0,0,0,0,0,0,0,0,0,1,seamAt],candidates:seamCandidates}];
    for(const scene of scenes){
     const count=scene.width*scene.height,resident=scene.gpu;
     if(![scene.x,scene.y].every(v=>integer(v,-0x3fffefff,0x3fffefff))||![scene.width,scene.height].every(v=>integer(v,0,0x3fffefff))||!Number.isSafeInteger(count))throw Error('Unsupported batch scene');
     if(resident){if(scene.grid||scene.artMask||!resident.buffer||!(resident.buffer.usage&GPUBufferUsage.STORAGE)||
       !integer(resident.edgeOffset,0,0xffffffff)||!integer(resident.edgeEligibilityOffset,0,0xffffffff)||
       (resident.edgeOffset+count)*4>resident.buffer.size||(resident.edgeEligibilityOffset+1)*4>resident.buffer.size||resident.buffer===input.materialBuffer)throw Error('Invalid resident batch scene');}
     else if(!(scene.grid instanceof Int16Array)||scene.grid.length!==count||(scene.artMask&&(!(scene.artMask instanceof Uint8Array)||scene.artMask.length!==Math.ceil(count/8))))throw Error('Invalid CPU batch scene');
     const bx=scene.x-x,by=scene.y-y,left=Math.max(0,bx),top=Math.max(0,by),right=Math.min(width,bx+scene.width),bottom=Math.min(height,by+scene.height),cw=right-left,ch=bottom-top;
     if(cw<=0||ch<=0)continue;let eligible=resident?2:scene.edgeEligible;
     if(!resident&&eligible===undefined){eligible=false;for(let i=0;i<count;i++){const id=scene.grid[i];if(id>0&&id<prepared.materialCount&&prepared.materialTable[id*3+1]&&!(scene.artMask&&(scene.artMask[i>>3]&(0x80>>(i&7))))){eligible=true;break;}}}
     eligible=scene.skipEdges?0:resident?2:+!!eligible;let eligibleAt=0,valuesAt;
     if(resident){eligibleAt=reserve(1);valuesAt=reserve(cw*ch);clips.push({buffer:resident.buffer,words:[resident.edgeOffset,scene.width,left-bx,top-by,cw,ch,valuesAt,resident.edgeEligibilityOffset,eligibleAt,0,0,0]});}
     else{const values=new Uint32Array(cw*ch);for(let row=0;row<ch;row++)for(let col=0;col<cw;col++){const p=(top-by+row)*scene.width+left-bx+col;values[row*cw+col]=(scene.grid[p]&65535)|((scene.artMask&&(scene.artMask[p>>3]&(0x80>>(p&7))))?65536:0);}valuesAt=add(values);}
     const candidateWidth=Math.max(0,Math.min(endX,bx+scene.width-1)-Math.max(margin,bx+1)),candidateHeight=Math.max(0,Math.min(endY,by+scene.height-1)-Math.max(margin,by+1));
     phases.push({words:[...base,2,bx,by,scene.width,scene.height,left,top,cw,ch,valuesAt,eligible,eligibleAt],candidates:eligible?candidateWidth*candidateHeight:0});sceneCount++;
    }
    pageData.push({input,phases,pixelOffsetWords,skipAt,count:n,materialOffsetWords,base,rectangles:rectangles.length});
   }
   const phaseCount=Math.max(...pageData.map(p=>p.phases.length)),phaseRows=[],phaseInfo=[];
   for(let phase=0;phase<phaseCount;phase++){
    const data=new Uint32Array(pages.length*WORDS);let candidates=0,clipWidth=0,clipHeight=0;
    pageData.forEach((p,i)=>{const value=p.phases[phase]??{words:[...p.base,3,0,0,0,0,0,0,0,0,0,0,0],candidates:0};candidates+=value.candidates;
     data.set([...value.words,candidates,p.pixelOffsetWords,p.skipAt,0],i*WORDS);
     if(value.words[8]===2){clipWidth=Math.max(clipWidth,value.words[15]);clipHeight=Math.max(clipHeight,value.words[16]);}
    });const phaseAt=add(data);phaseRows.push([pages.length,phase,phaseAt,candidates,totalPixels,0,0,0]);phaseInfo.push({candidates,clipWidth,clipHeight});
   }
   const actionBytes=totalPixels*prepared.maxEntries*8,winnerBytes=totalPixels*12+24;
   if(pageData.some(p=>p.count*prepared.maxEntries>=0x7fffffff)||[actionBytes,winnerBytes,totalPixels*4,updateWords*4].some(n=>n>device.limits.maxStorageBufferBindingSize)||
     phaseInfo.some(p=>Math.ceil(p.candidates/64)>device.limits.maxComputeWorkgroupsPerDimension)||Math.ceil(totalPixels/64)>device.limits.maxComputeWorkgroupsPerDimension)throw Error('Batched edge allocation/dispatch exceeds device bounds');
   const buffers=[],own=b=>(buffers.push(b),b),storage=(size,label)=>own(device.createBuffer({size:Math.max(4,size),label,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC|GPUBufferUsage.COPY_DST}));
   const material=storage(totalPixels*4,'batched mutable materials'),rgba=storage(totalPixels*4,'batched edge RGBA'),painted=storage(totalPixels*4,'batched painted flags');
   const winner=storage(winnerBytes,'batched sparse winners and worklist'),action=storage(actionBytes,'batched edge actions'),updates=storage(updateWords*4,'batched page phases and scene clips');
   const indirect=own(device.createBuffer({size:12,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.INDIRECT}));
   for(const p of pageData){const source=p.input.materialBuffer??own(upload(device,Int32Array.from(p.input.materials),GPUBufferUsage.COPY_SRC,'batch CPU materials'));
    encoder.copyBufferToBuffer(source,p.materialOffsetWords*4,material,p.pixelOffsetWords*4,p.count*4);}
   for(const u of uploads)if(u.data.length)device.queue.writeBuffer(updates,u.at*4,u.data);
   const alignment=device.limits.minUniformBufferOffsetAlignment,stride=Math.ceil(48/alignment)*alignment;
   const uniformData=new Uint32Array(phaseCount*stride/4);phaseRows.forEach((r,i)=>uniformData.set(r,i*stride/4));
   const uniforms=own(upload(device,uniformData,GPUBufferUsage.UNIFORM,'batched edge phases'));
   if(clips.length){
    const values=new Uint32Array(clips.length*stride/4);clips.forEach((c,i)=>values.set(c.words,i*stride/4));const clipParams=own(upload(device,values,GPUBufferUsage.UNIFORM,'batch resident clips'));
    const groups=new Map(),pass=encoder.beginComputePass({label:'copy resident scene grids across pages'});pass.setPipeline(code.clip);
    clips.forEach((c,i)=>{let group=groups.get(c.buffer);if(!group){group=device.createBindGroup({layout:code.clipLayout,entries:[{binding:0,resource:{buffer:clipParams,size:48}},{binding:1,resource:{buffer:c.buffer}},{binding:2,resource:{buffer:updates}}]});groups.set(c.buffer,group);}
     pass.setBindGroup(0,group,[i*stride]);pass.dispatchWorkgroups(Math.ceil(c.words[4]/8),Math.ceil(c.words[5]/8));});pass.end();
   }
   const all=[uniforms,table,material,rgba,painted,winner,action,updates,indirect],entries=all.map((buffer,binding)=>({binding,resource:{buffer,...(binding===0?{size:32}:{})}}));
   const group=device.createBindGroup({layout:code.layout,entries}),resolveGroup=device.createBindGroup({layout:code.resolveLayout,entries:entries.slice(0,8)});
   let dispatches=clips.length,computePasses=+(clips.length>0),mutationDispatches=0,scatterDispatches=0,resolveDispatches=0;
   for(let phase=0;phase<phaseCount;phase++){
    const info=phaseInfo[phase],pass=encoder.beginComputePass({label:'batched ordered edge phase'});computePasses++;pass.setBindGroup(0,group,[phase*stride]);
    pass.setPipeline(code.pipelines.prepare_phase);pass.dispatchWorkgroups(1);dispatches++;
    if(phase>=2&&info.clipWidth&&info.clipHeight){pass.setPipeline(code.pipelines.mutate_only);pass.dispatchWorkgroups(Math.ceil(info.clipWidth/8),Math.ceil(info.clipHeight/8),pages.length);dispatches++;mutationDispatches++;}
    if(info.candidates){pass.setPipeline(code.pipelines.scatter);pass.dispatchWorkgroups(Math.ceil(info.candidates/64));dispatches++;scatterDispatches++;}pass.end();
    if(info.candidates){const resolve=encoder.beginComputePass({label:'batched sparse edge resolve'});computePasses++;resolve.setBindGroup(0,resolveGroup,[phase*stride]);resolve.setPipeline(code.pipelines.resolve_winners);resolve.dispatchWorkgroupsIndirect(indirect,0);resolve.end();dispatches++;resolveDispatches++;}
   }
   let disposed=false;
   return{materialBuffer:material,rgbaBuffer:rgba,paintedBuffer:painted,diagnosticBuffer:winner,
    pages:pageData.map((p,index)=>({index,x:p.input.x,y:p.input.y,width:p.input.width,height:p.input.height,pixelOffsetWords:p.pixelOffsetWords,materialOffsetWords:p.pixelOffsetWords,edgeOffsetWords:p.pixelOffsetWords,byteOffset:p.pixelOffsetWords*4})),
    stats:{pages:pages.length,pixels:totalPixels,phases:phaseCount,sceneOrdinalPhases:phaseCount-2,sceneInstances:sceneCount,
     baselinePagePhases:pageData.reduce((n,p)=>n+p.phases.length,0),cpuPreparationMs:performance.now()-started,dispatches,computePasses,mutationDispatches,scatterDispatches,indirectDispatches:resolveDispatches,
     residentClipDispatches:clips.length,candidateInvocations:phaseInfo.reduce((n,p)=>n+p.candidates,0),actionBytes,winnerBytes,ownedBufferBytes:buffers.reduce((n,b)=>n+b.size,0),sceneUpdateBytes:updateWords*4,sceneUploadBytes:uploads.reduce((n,u)=>n+u.data.byteLength,0),materialGatherBytes:totalPixels*4},
    destroy(){if(!disposed){disposed=true;buffers.forEach(b=>b.destroy());}},
   };
  },
  destroy(){if(!destroyed){destroyed=true;table.destroy();}},
 };
}
