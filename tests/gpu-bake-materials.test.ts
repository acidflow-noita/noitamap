import {it,expect} from "vitest";
import {build} from "vite";
import {Worker} from "node:worker_threads";
import {mkdtemp,rm} from "node:fs/promises";
import {resolve} from "node:path";
import {tmpdir} from "node:os";

it("resolves the corrected rare-material samples through actual native GPU shaders",async()=>{
 const root=resolve(import.meta.dirname,".."),bundle=await mkdtemp(resolve(tmpdir(),"noitamap-gpu-materials-"));
 try {
  await build({configFile:resolve(root,"vite.config.ts"),logLevel:"error",build:{outDir:bundle,
   rollupOptions:{input:resolve(root,"tests/helpers/gpu-bake-material-fixture.ts"),preserveEntrySignatures:"strict",
    output:{entryFileNames:"verify.js",manualChunks:()=>undefined}}}});
  const result:any=await new Promise((done,reject)=>{
   const worker=new Worker(resolve(root,"tests/helpers/gpu-bake-material-worker.mjs"),{
    workerData:{root,bundle,entry:resolve(bundle,"verify.js")},stdout:true,stderr:true});
   let logs="";for(const stream of [worker.stdout,worker.stderr])stream.on("data",c=>logs=(logs+c).slice(-12000));
   const timeout=setTimeout(()=>{worker.terminate();reject(new Error(`GPU material test timed out\n${logs}`))},180000);
   worker.on("error",e=>{clearTimeout(timeout);worker.terminate();reject(e)});
   worker.on("message",m=>{
    clearTimeout(timeout);
    if(m.error){worker.terminate();reject(new Error(m.error+"\n"+logs));return;}
    const shutdown=setTimeout(()=>{worker.terminate();reject(new Error("Native GPU cleanup timed out"))},5000);
    worker.once("exit",()=>{clearTimeout(shutdown);done(m)});
   });
  });
  expect(result.samples.map((p:any)=>p.gpuMaterial)).toEqual([426,140,140,426]);
  for(const sample of result.samples)expect(sample.gpuMaterial).toBe(sample.cpuMaterial);
 } finally {await rm(bundle,{recursive:true,force:true})}
},210000);
