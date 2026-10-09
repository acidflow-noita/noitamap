import { expect, it } from 'vitest';
import { build } from 'vite';
import { Worker } from 'node:worker_threads';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

it.skipIf(process.platform!=='linux')('matches full frames while panning real terrain, scenes and vertical worlds', async()=>{
  const root=resolve(import.meta.dirname,'..'),bundle=await mkdtemp(resolve(tmpdir(),'noitamap-pan-native-'));
  try {
    await build({configFile:resolve(root,'vite.config.ts'),logLevel:'error',publicDir:false,
      plugins:[{name:'pan-fixture',enforce:'pre',transform(code,id){
        if(id.replace(/\\/g,'/').endsWith('/src/telescope/telescope-osd-bridge.ts'))return code+'\nexport { instantSceneMasks as __panSceneMasks };';
      }}],build:{outDir:bundle,rollupOptions:{input:resolve(root,'tests/helpers/terrain-pan-fixture.ts'),
        preserveEntrySignatures:'strict',output:{entryFileNames:'fixture.js',manualChunks:()=>undefined}}}});
    const result:any=await new Promise((done,reject)=>{
      const worker=new Worker(resolve(root,'tests/helpers/terrain-pan-worker.mjs'),{workerData:{root,bundle},stdout:true,stderr:true});
      let result:any,logs='';for(const stream of [worker.stdout,worker.stderr])stream!.on('data',data=>logs=(logs+data).slice(-12000));
      const timer=setTimeout(()=>{void worker.terminate();reject(new Error('Native pan test timed out\n'+logs));},90000);
      worker.on('message',data=>result=data);worker.on('error',reject);worker.on('exit',code=>{
        clearTimeout(timer);if(code||result?.error||!result)reject(new Error((result?.error||'Exit '+code)+'\n'+logs));else done(result);
      });
    });
    expect(result.diagnostics).toEqual([]);expect(result.samples).toHaveLength(30);
    for(const s of result.samples){
      expect(s.differences,JSON.stringify(s)).toBe(0);
      if(s.index){expect(s.shadedPixels).toBeLessThan(s.referencePixels/10);expect(s.draws).toBeLessThanOrEqual(4);}
    }
    console.log('[Native pan comparison]',JSON.stringify(result));
  }finally{await rm(bundle,{recursive:true,force:true});}
},120000);
