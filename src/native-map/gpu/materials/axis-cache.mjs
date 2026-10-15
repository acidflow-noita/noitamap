// Runtime-only bounded1D input vectors. No pixel results, coordinate catalog,
// disk persistence, or cross-engine reuse of cave/state-dependent vectors.
export const MATERIAL_AXIS_CACHE_BYTES=64*1024*1024;
const deviceCaches=new WeakMap();
export const axisKey=(...parts)=>parts.map(v=>typeof v==='number'&&Object.is(v,-0)?'-0':String(v)).join('/');
export function createAxisVectorCache(maxBytes=MATERIAL_AXIS_CACHE_BYTES){
 if(!Number.isSafeInteger(maxBytes)||maxBytes<0||maxBytes>MATERIAL_AXIS_CACHE_BYTES)throw Error('Invalid bounded axis-cache size');
 const entries=new Map();let nextScope=0,bytes=0,payloadBytes=0,peakBytes=0;
 const counters={hits:0,misses:0,immutableHits:0,immutableMisses:0,stateHits:0,stateMisses:0,evictions:0,released:0,uncachedOversize:0,buildMs:0,lookupMs:0};
 function remove(key,entry){entries.delete(key);bytes-=entry.bytes;payloadBytes-=entry.words.byteLength;}
 function vector(scope,key,build){
  const started=performance.now(),full=scope+'/'+key,found=entries.get(full),prefix=scope===0?'immutable':'state';
  if(found){counters.hits++;counters[prefix+'Hits']++;entries.delete(full);entries.set(full,found);counters.lookupMs+=performance.now()-started;return found.words;}
  counters.misses++;counters[prefix+'Misses']++;counters.lookupMs+=performance.now()-started;const begin=performance.now(),words=build();counters.buildMs+=performance.now()-begin;
  if(!(words instanceof Uint32Array)||words.byteLength!==words.buffer.byteLength)throw Error('Axis cache requires an owned Uint32 vector');
  const entryBytes=words.byteLength+full.length*2+256; // bounded payload plus conservative per-entry metadata allowance
  if(entryBytes>maxBytes){counters.uncachedOversize++;return words;}
  const added=performance.now();while(bytes+entryBytes>maxBytes&&entries.size){const first=entries.entries().next().value;remove(first[0],first[1]);counters.evictions++;}
  entries.set(full,{scope,words,bytes:entryBytes});bytes+=entryBytes;payloadBytes+=words.byteLength;peakBytes=Math.max(peakBytes,bytes);counters.lookupMs+=performance.now()-added;return words;
 }
 function statistics(){return{...counters,bytes,payloadBytes,metadataAllowanceBytes:bytes-payloadBytes,peakBytes,entries:entries.size,maxBytes};}
 return{statistics,createScope(){const scope=++nextScope;let disposed=false;const check=()=>{if(disposed)throw Error('Disposed axis-cache scope');};return{
  immutable(key,build){check();return vector(0,key,build);},state(key,build){check();return vector(scope,key,build);},statistics,
  dispose(){if(disposed)return;disposed=true;for(const[key,entry]of entries)if(entry.scope===scope){remove(key,entry);counters.released++;}}
 };}};
}
export function createDeviceAxisScope(device){let cache=deviceCaches.get(device);if(!cache){cache=createAxisVectorCache();deviceCaches.set(device,cache);}return cache.createScope();}
export function materialAxisCacheStatistics(device){return deviceCaches.get(device)?.statistics()??null;}
export function axisCacheDelta(before,after){
 const delta={};for(const key of ['hits','misses','immutableHits','immutableMisses','stateHits','stateMisses','evictions','released','uncachedOversize','buildMs','lookupMs'])delta[key]=after[key]-before[key];
 return{...delta,bytes:after.bytes,payloadBytes:after.payloadBytes,metadataAllowanceBytes:after.metadataAllowanceBytes,peakBytes:after.peakBytes,entries:after.entries,maxBytes:after.maxBytes};
}
