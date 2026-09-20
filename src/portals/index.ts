import { isSpoilerFree, onSpoilerFreeChange } from '../spoiler-free';
import type { PortalSeed } from './placements';
import type { PortalGPUOverlay, PortalGPUStats } from './overlay';
import type { PortalBackgroundPatches } from './background-patches';
export interface PortalGPUState {
  enabled:boolean; status:'off'|'waiting'|'loading'|'running'|'error'; error:string|null; stats:PortalGPUStats|null;
}
let state:PortalGPUState={enabled:false,status:'off',error:null,stats:null};
const listeners=new Set<(state:PortalGPUState)=>void>();
let backgrounds:PortalBackgroundPatches|null=null;
let overlay:PortalGPUOverlay|null=null,revision=0,owner:any=null,seed:PortalSeed|null=null,request:AbortController|null=null;
function publish(next:Partial<PortalGPUState>){state={...state,...next};for(const listener of listeners)listener(state);}
export function getPortalGPUState():PortalGPUState{return state;}
export function onPortalGPUChange(listener:(state:PortalGPUState)=>void):()=>void{listeners.add(listener);return()=>listeners.delete(listener);}
function stop(){revision++;request?.abort();request=null;overlay?.destroy();overlay=null;backgrounds?.destroy();backgrounds=null;}
function fail(error:unknown){stop();publish({status:'error',error:error instanceof Error?error.message:String(error),stats:null});}
async function start(){
  stop();
  if(!state.enabled)return;
  if(!owner||!seed){publish({status:'waiting',error:null,stats:null});return;}
  const ticket=revision,viewer=owner,current=seed,controller=new AbortController();request=controller;
  publish({status:'loading',error:null,stats:null});
  try {
    const [{PortalGPUOverlay,loadPortalResources,createGPURuntime},{collectPortals},{PortalBackgroundPatches}]=await Promise.all([import('./overlay'),import('./placements'),import('./background-patches')]);
    if(ticket!==revision)return;
    const resources=await loadPortalResources(controller.signal);
    if(ticket!==revision||controller.signal.aborted)return;
    const portals=collectPortals(current);
    backgrounds=new PortalBackgroundPatches(viewer,portals,error=>{if(ticket===revision)fail(error);});
    overlay=new PortalGPUOverlay(viewer,portals,current.seed,resources,
      createGPURuntime,
      stats=>{if(ticket===revision)publish({status:'running',stats});},
      error=>{if(ticket===revision)fail(error);},
      ids=>{if(ticket===revision)backgrounds?.showForPortals(ids);});
    overlay.setEnabled(!isSpoilerFree());
    publish({status:'loading',stats:overlay.stats()});
  } catch(error){if(ticket===revision&&!controller.signal.aborted)fail(error);}
  finally {if(request===controller)request=null;}
}
/** Explicit per-page opt-in. Never persist enabled=true across reloads. */
export function setPortalGPUEnabled(enabled:boolean):void {
  if(state.enabled===enabled)return;
  publish({enabled,error:null,stats:null,status:enabled?'waiting':'off'});
  if(enabled)void start();else stop();
}
export function clearPortalAnimations():void {
  stop();owner?.removeHandler('destroy',clearPortalAnimations);owner=null;seed=null;
  publish({status:state.enabled?'waiting':'off',stats:null,error:null});
}
/** Register metadata only while off: no GPU modules, resources, context or RAF. */
export function installPortalAnimations(viewer:any,current:PortalSeed):void {
  clearPortalAnimations();owner=viewer;seed=current;owner.addHandler('destroy',clearPortalAnimations);
  if(state.enabled)void start();
}
onSpoilerFreeChange(()=>{overlay?.setEnabled(!isSpoilerFree());if(overlay)publish({stats:overlay.stats()});});
export function getPortalAnimationStats(){return overlay?.stats()??state;}
if(typeof window!=='undefined')(window as any).__portalOverlayStats=getPortalAnimationStats;
