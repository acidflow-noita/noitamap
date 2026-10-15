import {completeMapClient,type CompleteMapDescription} from './complete-client';
import {createInstantTerrainViewport,type InstantTerrainViewportPlan} from '../telescope/instant-terrain-viewport';

let lifetime:AbortController|undefined;
/** Freeze the outgoing complete frame while the next map cooks. */
export function stopCompletedNativePresentation(){lifetime?.abort();lifetime=undefined;}
async function readFrame(description:CompleteMapDescription,plan:InstantTerrainViewportPlan,signal:AbortSignal){
 const {grid}=description,maxLevel=Math.ceil(Math.log2(Math.max(grid.columns*grid.pageSize,grid.rows*grid.pageSize)));
 const level=Math.min(maxLevel,Math.max(0,Math.floor(Math.log2(plan.scale)))),scale=2**level;
 const x=Math.floor((plan.x-grid.x)/scale),y=Math.floor((plan.y-grid.y)/scale),right=Math.ceil((plan.x+plan.width-grid.x)/scale),bottom=Math.ceil((plan.y+plan.height-grid.y)/scale);
 const raw=await completeMapClient.read(description.generationId,{level,x,y,width:Math.max(1,right-x),height:Math.max(1,bottom-y)},signal);signal.throwIfAborted();
 const source=document.createElement('canvas');source.width=raw.width;source.height=raw.height;
 const sourceContext=source.getContext('2d');if(!sourceContext)throw new Error('Native map canvas unavailable');
 const image=sourceContext.createImageData(raw.width,raw.height);image.data.set(new Uint8Array(raw.pixels));sourceContext.putImageData(image,0,0);
 const output=document.createElement('canvas');output.width=plan.pixelWidth;output.height=plan.pixelHeight;
 const context=output.getContext('2d');if(!context)throw new Error('Native map presentation unavailable');context.imageSmoothingEnabled=false;
 context.drawImage(source,(grid.x+x*scale-plan.x)/plan.scale,(grid.y+y*scale-plan.y)/plan.scale,raw.width*scale/plan.scale,raw.height*scale/plan.scale);
 source.width=source.height=0;return output;
}
/** Attach only after all native pages/mips have completed in the worker. */
export function completedNativePresentation(description:CompleteMapDescription,lightMode=false){
 return async(viewer:any,isCurrent:()=>boolean,onItem:(item:any)=>void,onFirstPaint:()=>void)=>{
  stopCompletedNativePresentation();const controller=lifetime=new AbortController(),osd=viewer.viewer||viewer,{grid}=description;
  const bounds={x:lightMode?-17920:grid.x,y:grid.y,width:lightMode?35840:grid.columns*grid.pageSize,height:grid.rows*grid.pageSize};
  let fail:(error:unknown)=>void=()=>{};
  const ready=new Promise<void>((resolve,reject)=>{fail=reject;let added=false,frameReady=false,finished=false;
   const complete=()=>{if(added&&frameReady&&!finished&&isCurrent()&&!controller.signal.aborted){finished=true;onFirstPaint();resolve();}};
   controller.signal.addEventListener('abort',()=>reject(controller.signal.reason??new DOMException('Map replaced','AbortError')),{once:true});
   const viewport=createInstantTerrainViewport({viewer:osd,bounds,signal:controller.signal,initialOverview:true,maxRetainedPixels:1024*1024,
    renderFrame:(plan,signal)=>readFrame(description,plan,signal),
    firstPaint(){frameReady=true;complete();},emptyView(){frameReady=true;complete();},
    onFailure(error){console.error('[Native complete] Presentation failed',error);reject(error);controller.abort();},
   });
   viewport.source.__instantTerrain=true;viewport.source.__nativeComplete=true;
   osd.addTiledImage({tileSource:viewport.source,x:bounds.x,y:bounds.y,width:bounds.width,blendTime:0,opacity:1,
    success(event:any){if(!isCurrent()||controller.signal.aborted){osd.world.removeItem(event.item);resolve();return;}onItem(event.item);added=true;complete();},
    error(error:any){reject(new Error(error?.message??'Native map layer could not be attached'));controller.abort();},
   });
  });
  if(!isCurrent()){controller.abort();fail(new DOMException('Map replaced','AbortError'));}
  await ready;
 };
}
