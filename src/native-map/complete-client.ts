import CompleteWorker from './complete-worker?worker';
import type {NativeWorldDescription,WorldRequest} from './world';
import type {CompletedMapRead} from './gpu/completed-map-read';

export interface CompleteMapDescription {
 generationId:number;world:NativeWorldDescription;
 grid:{x:number;y:number;columns:number;rows:number;pageSize:number};
 timings:Record<string,unknown>;memory:Record<string,unknown>;
}
interface Pending {resolve(value:any):void;reject(error:Error):void;cleanup():void;progress?:(value:any)=>void}
/** One worker/device/current map. Reseeding retains reusable inputs/pipelines. */
export class CompleteMapClient {
 private worker:Worker|undefined;private nextId=1;private pending=new Map<number,Pending>();
 constructor(private readonly createWorker:()=>Worker=()=>new CompleteWorker()){}
 private ensureWorker(){
  if(this.worker)return this.worker;
  const worker=this.worker=this.createWorker();
  worker.onmessage=({data})=>{
   if(this.worker!==worker)return;if(data.type==='fatal'){this.fail(new Error(data.error??'Native GPU device lost'));return;}const pending=this.pending.get(data.id);if(!pending)return;
   if(data.type==='progress'){pending.progress?.(data.progress);return;}
   this.pending.delete(data.id);pending.cleanup();
   if(data.ok)pending.resolve(data.result);else{const error=new Error(data.error??'Native map failed');error.name=data.name??'Error';pending.reject(error);}
  };
  worker.onerror=event=>{if(this.worker===worker)this.fail(new Error(event.message||'Native complete-map worker failed'));};
  worker.onmessageerror=()=>{if(this.worker===worker)this.fail(new Error('Invalid native complete-map worker response'));};
  return worker;
 }
 private call(type:string,values:Record<string,unknown>,signal?:AbortSignal,progress?:(value:any)=>void):Promise<any>{
  signal?.throwIfAborted();const worker=this.ensureWorker(),id=this.nextId++;
  return new Promise((resolve,reject)=>{
   const abort=()=>{this.pending.delete(id);signal?.removeEventListener('abort',abort);worker.postMessage({type:'cancel',id});reject(signal?.reason??new DOMException('Cancelled','AbortError'));};
   this.pending.set(id,{resolve,reject,progress,cleanup:()=>signal?.removeEventListener('abort',abort)});signal?.addEventListener('abort',abort,{once:true});
   try{worker.postMessage({id,type,...values});}catch(error){this.pending.delete(id);signal?.removeEventListener('abort',abort);reject(error);}
  });
 }
 generate(request:WorldRequest,signal?:AbortSignal,onProgress?:(value:any)=>void):Promise<CompleteMapDescription>{return this.call('generate',{request},signal,onProgress);}
 read(generationId:number,view:CompletedMapRead,signal?:AbortSignal):Promise<{pixels:ArrayBuffer;width:number;height:number}>{return this.call('read',{generationId,view},signal);}
 private fail(error:Error){this.worker?.terminate();this.worker=undefined;for(const p of this.pending.values()){p.cleanup();p.reject(error);}this.pending.clear();}
 dispose(){this.fail(new Error('Native complete map disposed'));}
}

export const completeMapClient=new CompleteMapClient();
export function isCompleteNativeMapEnabled(search=typeof location==='undefined'?'':location.search){return new URLSearchParams(search).get('native')==='1';}
