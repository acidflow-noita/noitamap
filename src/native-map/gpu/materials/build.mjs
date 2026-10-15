// Node-only build/verification utility. Never imported by the browser runtime.
import{readFile,writeFile}from'node:fs/promises';
import{createHash}from'node:crypto';
import{spawnSync}from'node:child_process';
import{fileURLToPath}from'node:url';
import{resolve}from'node:path';
const directory=fileURLToPath(new URL('./',import.meta.url)),root=resolve(directory,'../../../..');
const validated=JSON.parse(await readFile(resolve(directory,'validated-scratch-identity.json'),'utf8'));
const sources=['build.mjs','index.ts','correct.c','exact-corrector.ts','exact-legacy.ts','certified-engine.ts','material-compute.mjs','axis-cache.mjs','material-shader.mjs','edge-samplers.mjs','band-kernel.mjs','topology0-inputs.mjs','topology0-shader.mjs','interval-noise.mjs','polka-hash.mjs','noise-tables.mjs','../buffers.ts','NOTICE.txt','LICENSE-telescope.txt'];
const native=Object.keys(validated.sha256.native),sha=async p=>createHash('sha256').update(await readFile(p)).digest('hex');
async function identity(){return{sources:Object.fromEntries(await Promise.all(sources.map(async p=>[p,await sha(resolve(directory,p))]))),native:Object.fromEntries(await Promise.all(native.map(async p=>[p,await sha(resolve(root,'src/native-map/complete-materials',p))]))),wasm:await sha(resolve(directory,'correct.wasm'))};}
async function verifyModule(){const module=await WebAssembly.compile(await readFile(resolve(directory,'correct.wasm')));if(WebAssembly.Module.imports(module).length)throw Error('Correction module must have no runtime imports');const{exports:w}=await WebAssembly.instantiate(module);if(w.abi_version()!==3||typeof w.correct_indices!=='function'||typeof w.configure_correction_grids!=='function')throw Error('Incorrect correction module ABI');}
if(process.argv.includes('--check')){const recorded=JSON.parse(await readFile(resolve(directory,'build-identity.json'),'utf8'));if(JSON.stringify(recorded.sha256)!==JSON.stringify(await identity()))throw Error('Production material source/artifact identity is stale');await verifyModule();console.log('Production material source/artifact identity and ABI3 verified.');}
else{
 let compiler=validated.compiler;
 if(!process.argv.includes('--record-only')){const sdk=process.env.WASI_SDK_PATH;if(!sdk)throw Error('Set WASI_SDK_PATH to the existing WASI SDK; no download is performed');const executable=resolve(sdk,'bin/clang'),result=spawnSync(executable,[...validated.flags,'correct.c','-o','correct.wasm'],{cwd:directory,encoding:'utf8'});if(result.error||result.status)throw Error(result.error??result.stderr);const version=spawnSync(executable,['--version'],{encoding:'utf8'});if(version.error||version.status)throw Error(version.error??version.stderr);compiler=version.stdout.trim();}
 await verifyModule();await writeFile(resolve(directory,'build-identity.json'),JSON.stringify({abi:3,compiler,flags:validated.flags,scope:'Production browser/worker material runtime: certified GPU candidates, batched exact C repair and optional exact legacy RGBA. Caller supplies GPUDevice and WebAssembly.Module.',promotion:'promotion.json',accuracyLimits:['Normal70-column main/vertical/shaft inputs only.','Owned-source parity; cave-state/default-input fidelity limits remain.','No browser/hardware performance claim follows from native software Vulkan validation.'],sha256:await identity()},null,2)+'\n');console.log('Recorded production material identity.');
}
