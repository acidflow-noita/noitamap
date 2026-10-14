import {readFile,writeFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const directory='src/native-map/prepared-materials',artifact=directory+'/material-edge-plan.wasm';
const files=[directory+'/plan.c',directory+'/material-edge-plan.h',directory+'/stencil-codec.ts',
 'src/native-map/materials/topo2.c','src/native-map/materials/constants.h'];
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const sources=Object.fromEntries(await Promise.all(files.map(async name=>[name,hash(await readFile(resolve(root,name)))])));
const flags=['--target=wasm32-unknown-unknown','-O3','-ffp-contract=off','-fno-fast-math','-nostdlib',
 '-Wl,--no-entry','-Wl,--export-memory','-Wl,--initial-memory=262144','-Wl,--max-memory=2097152','-Wl,-z,stack-size=65536'];
if(process.argv.includes('--check')) {
 const expected=JSON.parse(await readFile(resolve(root,directory+'/material-edge-plan.json')));
 if(expected.abi!==1||JSON.stringify(expected.flags)!==JSON.stringify(flags)
  ||JSON.stringify(expected.sources)!==JSON.stringify(sources)||expected.moduleHash!==hash(await readFile(resolve(root,artifact))))
  throw Error('Native stencil artifact/source identity changed; rebuild it');
 console.log('Native stencil source and artifact identities match.');
} else {
 if(!process.argv.includes('--record')) {
  if(!process.env.WASI_SDK_PATH)throw Error('Set WASI_SDK_PATH to the installed WASI SDK');
  await new Promise((done,reject)=>{
   const child=spawn(resolve(process.env.WASI_SDK_PATH,'bin/clang'),[...flags,directory+'/plan.c','-o',artifact],{cwd:root,stdio:['ignore','ignore','pipe']});
   let errors='';child.stderr.on('data',data=>errors+=data);child.on('error',reject);
   child.on('close',code=>code?reject(Error(errors||'Stencil compiler failed')):done());
  });
 }
 const meta={abi:1,moduleHash:hash(await readFile(resolve(root,artifact))),sources,flags,
  attribution:'Arithmetic derived from Lymm Telescope (MIT); see ../materials/LICENSE-telescope.txt and NOTICE.txt.'};
 await writeFile(resolve(root,directory+'/material-edge-plan.json'),JSON.stringify(meta,null,2)+'\n');
 console.log(JSON.stringify({bytes:(await readFile(resolve(root,artifact))).length,moduleHash:meta.moduleHash}));
}
