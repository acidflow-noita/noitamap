import { expect, it } from 'vitest';
import { build } from 'vite';
import { Worker } from 'node:worker_threads';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

it('boots the deployed native worker and generates maps using emitted assets only', async () => {
 const root=resolve(import.meta.dirname,'..'),output=await mkdtemp(resolve(tmpdir(),'native-map-assets-'));
 let worker:Worker|undefined;
 try{
  const app:any=await build({configFile:resolve(root,'vite.config.ts'),logLevel:'error',build:{outDir:output}});
  expect(app.output.some((f:any)=>f.fileName==='native-world.html')).toBe(false);
  const file=app.output.find((f:any)=>/(?:^|\/)world-worker-[^/]+\.js$/.test(f.fileName));expect(file).toBeDefined();
  worker=new Worker(resolve(root,'tests/helpers/telescope-worker-runtime.mjs'),{workerData:{root,output,entry:resolve(output,file.fileName)},stdout:true,stderr:true});
  let logs='',failure:Error|undefined;const messages:any[]=[],pending:{resolve:(v:any)=>void,reject:(e:any)=>void}[]=[];
  for(const stream of [worker.stdout,worker.stderr])stream!.on('data',b=>{logs=(logs+b).slice(-8000)});
  worker.on('message',m=>pending.length?pending.shift()!.resolve(m):messages.push(m));
  worker.on('error',e=>{failure=e instanceof Error?e:new Error(String(e));for(const p of pending.splice(0))p.reject(failure)});
  const next=()=>failure?Promise.reject(failure):messages.length?Promise.resolve(messages.shift()):new Promise<any>((resolve,reject)=>pending.push({resolve,reject}));
  expect((await next()).type,logs).toBe('ready');
  worker.postMessage({id:1,type:'prepare'});let message=await next();expect(message.data?.ok,JSON.stringify(message)+logs).toBe(true);expect(message.missing).toEqual([]);
  for(const [index,parallelWorlds] of [[0,[-1,0,1]],[1,[0]]] as const){
   worker.postMessage({id:index+2,type:'generate',request:{seed:index?11033:1103,parallelWorlds}});message=await next();
   expect(message.data?.ok,JSON.stringify({error:message.data?.error,missing:message.missing})+logs).toBe(true);
   expect(message.missing).toEqual([]);expect(message.data.world.regions).toHaveLength(parallelWorlds.length*3);
   expect(message.data.world.regions.reduce((n:number,r:any)=>n+r.scenes.length,0)).toBeGreaterThan(3000);
  }
 }finally{await worker?.terminate();await rm(output,{recursive:true,force:true});}
},120000);
