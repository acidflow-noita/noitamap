import { expect, it } from 'vitest';
import { build } from 'vite';
import { Worker } from 'node:worker_threads';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

it.skipIf(process.platform!=='linux')('matches Canvas terrain composition with GPU-owned clipping', async()=>{
  const root=resolve(import.meta.dirname,'..'),bundle=await mkdtemp(resolve(tmpdir(),'noitamap-pan-native-'));
  try {
    await build({configFile:resolve(root,'vite.config.ts'),logLevel:'error',publicDir:false,
      plugins:[{name:'pan-fixture',enforce:'pre',transform(code,id){
        if(id.replace(/\\/g,'/').endsWith('/src/telescope/telescope-osd-bridge.ts'))return code+'\nexport { instantSceneMasks as __panSceneMasks };';
      }}],build:{outDir:bundle,rollupOptions:{input:resolve(root,'tests/helpers/gpu-viewport-fixture.ts'),
        preserveEntrySignatures:'strict',output:{entryFileNames:'fixture.js',manualChunks:()=>undefined}}}});
    const result:any=await new Promise((done,reject)=>{
      const worker=new Worker(resolve(root,'tests/helpers/terrain-pan-worker.mjs'),{workerData:{root,bundle},stdout:true,stderr:true});
      let result:any,logs='';for(const stream of [worker.stdout,worker.stderr])stream!.on('data',data=>logs=(logs+data).slice(-12000));
      const timer=setTimeout(()=>{void worker.terminate();reject(new Error('Native pan test timed out\n'+logs));},90000);
      worker.on('message',data=>result=data);worker.on('error',reject);worker.on('exit',code=>{
        clearTimeout(timer);if(code||result?.error||!result)reject(new Error((result?.error||'Exit '+code)+'\n'+logs));else done(result);
      });
    });
    await writeFile('/tmp/noitamap-gpu-viewport-probe.json', JSON.stringify(result));
    expect(result.diagnostics).toEqual([]);expect(result.samples).toHaveLength(42);
    for(const s of result.samples){
      expect(s.differences,JSON.stringify(s)).toBe(0);

    }
    expect(result.samples.reduce((n:any,s:any)=>n+s.visiblePixels,0)).toBeGreaterThan(1_000_000);
  }finally{await rm(bundle,{recursive:true,force:true});}
},120000);
