import {it,expect} from 'vitest';
import {Worker} from 'node:worker_threads';
import {writeFile} from 'node:fs/promises';
const entry=new URL('./helpers/native-world-runner.ts',import.meta.url);
function spawn(role:string,requests:any[]=[]){
 // tsx's worker bootstrap registers TS before evaluating the owned engine.
 const worker=new Worker(new URL('./helpers/native-world-bootstrap.mjs',import.meta.url),{workerData:{role,requests,entry:entry.href},stdout:true,stderr:true});
 let errorText='';worker.stderr!.on('data',b=>{errorText+=b});worker.stdout!.resume();
 const queued:any[]=[],waiting:{resolve:(v:any)=>void,reject:(e:any)=>void}[]=[];let failure:Error|undefined;
 worker.on('message',v=>waiting.length?waiting.shift()!.resolve(v):queued.push(v));
 const fail=(e:Error)=>{failure=e;for(const p of waiting.splice(0))p.reject(e);};
 worker.on('error',fail);worker.on('exit',c=>{if(c)fail(new Error(errorText||`Worker exited ${c}`));});
 return{worker,next:()=>failure?Promise.reject(failure):queued.length?Promise.resolve(queued.shift()):new Promise<any>((resolve,reject)=>waiting.push({resolve,reject}))};
}
it('generates nine regions without browser globals, preserves spawn/scene rules, and survives buffer transfers/reseeding',async()=>{
 const requests=[{seed:1103},{seed:11033,unlocks:[]},{seed:1337,ngPlus:1,calendar:{month:2,day:14}},{seed:333,gameMode:'nightmare'}];
 const native=spawn('native',requests),reference=spawn('reference');
 try{
  await reference.next();let preparedReads=-1;
  for(const request of requests){
   const n=await native.next();expect(n.request).toEqual(request);expect(n.world.regions).toHaveLength(9);
   expect(n.world.kind).toBe('native-world-description');
   if(preparedReads<0)preparedReads=n.reads;else expect(n.reads).toBe(preparedReads);
   reference.worker.postMessage({world:n.world,request});const r=await reference.next();
   if(r.hash!==n.hash)await writeFile('task/native-engine/parity-difference.json',JSON.stringify({request,native:n.world.regions,reference:r.regions}));
   expect(n.world.regions.map((v:any)=>[v.pois.length,v.scenes.length])).toEqual(r.counts);
   expect(n.hash,JSON.stringify(request)).toBe(r.hash);
  }
 }finally{await Promise.all([native.worker.terminate(),reference.worker.terminate()]);}
},60000);
