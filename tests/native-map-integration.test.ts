import { expect, it } from 'vitest';
import { build } from 'vite';
import { Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

it('feeds the existing map renderer with equivalent native generation output',async()=>{
 const root=resolve(import.meta.dirname,'..'),directory=await mkdtemp(resolve(tmpdir(),'native-map-integration-'));
 const capture=process.env.NOITAMAP_CAPTURE_MAP_REFERENCE;
 const oldAdapter=capture?await readFile(capture,'utf8'):'';
 const referenceFile=resolve(root,'tests/fixtures/native-map-integration.json');
 const results:any[]=[];
 try{
  for(const reference of [!!capture]){
   const bundle=resolve(directory,reference?'reference':'native');
   await build({configFile:resolve(root,'vite.config.ts'),logLevel:'error',publicDir:false,
    plugins:reference?[{name:'reference-deployed-generation',enforce:'pre',transform(code,id){if(id.replace(/\\/g,'/').endsWith('/src/telescope/telescope-adapter.ts'))return oldAdapter;}}]:[],
    build:{outDir:bundle,minify:false,rollupOptions:{input:resolve(root,'tests/helpers/native-map-integration-fixture.ts'),preserveEntrySignatures:'strict',output:{entryFileNames:'fixture.js',manualChunks:()=>undefined}}}});
   const result:any=await new Promise((done,reject)=>{
    const worker=new Worker(resolve(root,'tests/helpers/watercave-scene-worker.mjs'),{workerData:{root,bundle,fullPixels:true,fixedDate:Date.UTC(2026,9,13,12)},stdout:true,stderr:true});
    let result:any,logs='';for(const stream of [worker.stdout,worker.stderr])stream!.on('data',b=>{logs=(logs+b).slice(-12000)});
    const timer=setTimeout(()=>{void worker.terminate();reject(new Error('Map integration timeout\n'+logs));},90000);
    worker.on('message',r=>result=r);worker.on('error',e=>{clearTimeout(timer);reject(e)});worker.on('exit',code=>{clearTimeout(timer);if(code||result?.error||!result)reject(new Error((result?.error??`Worker exit ${code}`)+'\n'+logs));else done(result);});
   });
   expect(result.diagnostics).toEqual([]);results.push(result.cases);
  }
  if(capture)await writeFile(referenceFile,JSON.stringify({scope:'Prior deployed generator, unchanged map presentation. Canonical metadata plus completed native CPU tiles. Current outputs are compared to these frozen reference hashes.',sourceSha256:createHash('sha256').update(oldAdapter).digest('hex'),fixedDate:'2026-10-13T12:00:00Z',cases:results[0]},null,2)+'\n');
  else expect(results[0]).toEqual(JSON.parse(await readFile(referenceFile,'utf8')).cases);
 }finally{await rm(directory,{recursive:true,force:true});}
},180000);
