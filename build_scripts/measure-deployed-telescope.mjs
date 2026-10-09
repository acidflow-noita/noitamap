import { chromium } from 'playwright';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import net from 'node:net';
import { performance as clock } from 'node:perf_hooks';

// One shared downstream schedule covers every HTTPS connection, including workers.
// TLS remains end-to-end: this proxy only transports encrypted CONNECT streams.
// Added delay is 15 ms in each direction, on top of the real network latency.
async function startShapedTunnel() {
 const rate=100000000/8, sockets=new Set(), records=[];
 let totalDown=0,totalUp=0,totalQueued=0,maxQueued=0;
 const burstBytes=256*1024;
 const streams=new Set(),lanes=Array.from({length:2},()=>({queue:[],busy:false,tokens:0,lastRefill:clock.now()}));
 const resume=()=>{for(const stream of streams)if(!stream.blocked&&stream.queued<2*1024**2&&totalQueued<16*1024**2)stream.source.resume();};
 const pump=lane=>{
  if(lane.busy||!lane.queue.length)return;const item=lane.queue[0],now=clock.now();
  lane.tokens=Math.min(burstBytes,lane.tokens+(now-lane.lastRefill)*rate/1000);lane.lastRefill=now;
  // A 256 KiB token bucket tolerates timer jitter without accumulating an
  // unbounded burst. Both directions have one bucket shared by all streams.
  const delay=Math.max(0,item.ready-now,(item.chunk.length-lane.tokens)/rate*1000);
  if(delay>0){lane.busy=true;setTimeout(()=>{lane.busy=false;pump(lane);},Math.max(1,delay));return;}
  lane.queue.shift();lane.tokens-=item.chunk.length;
   item.stream.queued-=item.chunk.length;totalQueued-=item.chunk.length;
   if(!item.dest.destroyed&&!item.dest.write(item.chunk)){
    item.stream.blocked=true;item.stream.source.pause();
    item.dest.once('drain',()=>{item.stream.blocked=false;resume();});
   }
   if(item.stream.ended&&item.stream.queued===0)item.dest.end();
   resume();pump(lane);
 };
 const shape=(source,dest,down)=>{
  const stream={source,queued:0,blocked:false,ended:false};streams.add(stream);source.once('close',()=>streams.delete(stream));
  source.once('end',()=>{stream.ended=true;if(!stream.queued)dest.end();});
  return chunk=>{
   const lane=lanes[down?0:1];stream.queued+=chunk.length;totalQueued+=chunk.length;maxQueued=Math.max(maxQueued,totalQueued);
   if(down)totalDown+=chunk.length;else totalUp+=chunk.length;
   for(let offset=0;offset<chunk.length;offset+=65536)lane.queue.push({stream,dest,chunk:chunk.subarray(offset,offset+65536),ready:clock.now()+15});
   if(stream.queued>=4*1024**2||totalQueued>=32*1024**2)source.pause();pump(lane);
  };
 };
 const server=net.createServer({allowHalfOpen:true},client=>{
  sockets.add(client);client.on('close',()=>sockets.delete(client));client.on('error',()=>{});
  let buffer=Buffer.alloc(0);
  const handshake=chunk=>{
   buffer=Buffer.concat([buffer,chunk]);const end=buffer.indexOf('\r\n\r\n');if(end<0)return;
   client.removeListener('data',handshake);client.pause();
   const match=/^CONNECT ([^: ]+):(\d+) HTTP\//.exec(buffer.toString('ascii',0,end));
   if(!match){client.end('HTTP/1.1 400 Bad Request\r\n\r\n');return;}
   const [,host,port]=match,record={host,port:Number(port),start:clock.now()};records.push(record);
   const upstream=net.connect({host,port:Number(port),allowHalfOpen:true});sockets.add(upstream);
   upstream.on('close',()=>sockets.delete(upstream));
   client.on('close',()=>upstream.destroy());upstream.on('error',e=>{record.error=e.message;client.destroy();});
   upstream.once('connect',()=>{
    record.connected=clock.now();client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    client.on('data',shape(client,upstream,false));upstream.on('data',shape(upstream,client,true));
    const rest=buffer.subarray(end+4);if(rest.length)shape(client,upstream,false)(rest);else client.resume();
   });
  };
  client.on('data',handshake);
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 return {url:`http://127.0.0.1:${server.address().port}`,stats:()=>({downstreamTLSBytes:totalDown,upstreamTLSBytes:totalUp,maxQueuedBytes:maxQueued,burstBytes,connections:records}),close:async()=>{for(const s of sockets)s.destroy();await new Promise(resolve=>server.close(resolve));}};
}
const root=process.cwd(), out=resolve(root,'task/instant-map/deployed');
await mkdir(out,{recursive:true});
if(process.argv.includes('--calibrate')){
 const payload=Buffer.alloc(16*1024**2),server=net.createServer(socket=>socket.once('data',()=>socket.end(payload)));
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const results=[];
 for(const count of [1,2]){
  const tunnel=await startShapedTunnel(),port=Number(new URL(tunnel.url).port),started=clock.now();
  await Promise.all(Array.from({length:count},()=>new Promise((resolve,reject)=>{
   const socket=net.connect({host:'127.0.0.1',port});let header=Buffer.alloc(0),ready=false,bytes=0;
   socket.on('error',reject);socket.on('connect',()=>socket.write(`CONNECT 127.0.0.1:${server.address().port} HTTP/1.1\r\n\r\n`));
   socket.on('data',chunk=>{if(!ready){header=Buffer.concat([header,chunk]);const end=header.indexOf('\r\n\r\n');if(end<0)return;ready=true;chunk=header.subarray(end+4);socket.write('go');}bytes+=chunk.length;});
   socket.on('end',()=>{socket.end();bytes===payload.length?resolve():reject(new Error(`received ${bytes}`));});
  })));
  const elapsedMs=clock.now()-started;results.push({parallelConnections:count,bytes:payload.length*count,elapsedMs,aggregateMbps:payload.length*count*8/elapsedMs/1000,...tunnel.stats()});await tunnel.close();
 }
 await new Promise(resolve=>server.close(resolve));await writeFile(resolve(out,'tunnel-calibration.json'),JSON.stringify(results,null,2));console.log(JSON.stringify(results));process.exit(0);
}
const seeds=process.argv.slice(2).length?process.argv.slice(2):['786433191','daily'];
for(let run=0;run<seeds.length;run++){
 const seed=seeds[run],label=`everything-${seed}-${Date.now()}`;
 const tunnel=await startShapedTunnel();
 const browser=await chromium.launch({headless:true,proxy:{server:tunnel.url},args:['--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-quic']});
 const context=await browser.newContext({viewport:{width:1280,height:900},deviceScaleFactor:1,ignoreHTTPSErrors:false});
 const page=await context.newPage(),cdp=await context.newCDPSession(page);
 await cdp.send('Network.enable');
 await cdp.send('Network.setCacheDisabled',{cacheDisabled:true});
 const requests=new Map(),errors=[],consoleLogs=[],hashes=[],workerTargets=[];
 let workerCommandId=0;const workerCommands=new Map();
 const workerSend=(sessionId,method,params={})=>new Promise((resolve,reject)=>{
  const id=++workerCommandId;workerCommands.set(id,{resolve,reject});
  cdp.send('Target.sendMessageToTarget',{sessionId,message:JSON.stringify({id,method,params})}).catch(reject);
 });
 cdp.on('Target.receivedMessageFromTarget',e=>{
  const msg=JSON.parse(e.message);
  if(msg.id){const pending=workerCommands.get(msg.id);if(pending){workerCommands.delete(msg.id);msg.error?pending.reject(new Error(JSON.stringify(msg.error))):pending.resolve(msg.result);}return;}
  const p=msg.params||{},key=`worker:${e.sessionId}:${p.requestId}`;
  if(msg.method==='Network.requestWillBeSent')requests.set(key,{url:p.request.url,start:p.timestamp,target:e.sessionId});
  if(msg.method==='Network.responseReceived')Object.assign(requests.get(key)||{},{status:p.response.status,mimeType:p.response.mimeType,fromDiskCache:p.response.fromDiskCache,fromServiceWorker:p.response.fromServiceWorker});
  if(msg.method==='Network.dataReceived'){const request=requests.get(key);if(request)request.decodedBytes=(request.decodedBytes||0)+p.dataLength;}
  if(msg.method==='Network.loadingFinished')Object.assign(requests.get(key)||{},{end:p.timestamp,encodedBytes:p.encodedDataLength});
  if(msg.method==='Network.loadingFailed')Object.assign(requests.get(key)||{},{failure:p.errorText});
 });
 cdp.on('Target.attachedToTarget',async e=>{
  const record={sessionId:e.sessionId,type:e.targetInfo.type,url:e.targetInfo.url};workerTargets.push(record);
  try{await workerSend(e.sessionId,'Network.enable');record.networkObserved=true;}catch(error){record.error=String(error);}
  finally{await workerSend(e.sessionId,'Runtime.runIfWaitingForDebugger').catch(error=>errors.push('worker resume: '+error));}
 });
 await cdp.send('Target.setAutoAttach',{autoAttach:true,waitForDebuggerOnStart:true,flatten:false});
 cdp.on('Network.requestWillBeSent',e=>requests.set(e.requestId,{url:e.request.url,start:e.timestamp}));
 cdp.on('Network.responseReceived',e=>Object.assign(requests.get(e.requestId)||{},{status:e.response.status,mimeType:e.response.mimeType,fromDiskCache:e.response.fromDiskCache,fromServiceWorker:e.response.fromServiceWorker}));
 cdp.on('Network.dataReceived',e=>{const request=requests.get(e.requestId);if(request)request.decodedBytes=(request.decodedBytes||0)+e.dataLength;});
 cdp.on('Network.loadingFinished',e=>Object.assign(requests.get(e.requestId)||{},{end:e.timestamp,encodedBytes:e.encodedDataLength}));
 cdp.on('Network.loadingFailed',e=>Object.assign(requests.get(e.requestId)||{},{failure:e.errorText}));
 page.on('pageerror',e=>errors.push(String(e)));
 page.on('console',m=>{if(/Generation completed|failed|error|GL terrain|Loaded .*pixel scenes/i.test(m.text()))consoleLogs.push({time:Date.now(),type:m.type(),text:m.text()});});
 page.on('response',async r=>{try{const pathname=new URL(r.url()).pathname;if(['/js/app.js','/js/gl/shaders.js','/js/gl/scene_renderer.js','/js/pixel_scene_generation.js'].includes(pathname)){
  const b=await r.body(),local=await readFile(resolve(root,'lib/noita-telescope-vm',pathname.slice(1)));
  hashes.push({path:pathname,sha256:createHash('sha256').update(b).digest('hex'),matchesFa9cd25:b.equals(local)});
 }}catch(e){errors.push('source hash: '+e.message);}});
 await page.addInitScript(()=>{
  const configure=new MutationObserver(()=>{const checkbox=document.getElementById('debug-render-everything');if(checkbox){checkbox.checked=true;configure.disconnect();}});
  configure.observe(document,{subtree:true,childList:true});
  const m=window.__measurement={started:performance.now(),events:[],draws:[],frames:[],terrainViews:[],phase:'cold',longTasks:[],generations:[],resources:[],glInfo:null};
  const mark=(type,extra={})=>m.events.push({type,t:performance.now(),phase:m.phase,...extra});
  const log=console.log;console.log=function(...a){if(String(a[0]).includes('Generation completed'))mark('generation-console',{message:a[0]});return log.apply(this,a);};
  let lastStatus='';new MutationObserver(()=>{const status=document.getElementById('status')?.textContent;if(status&&status!==lastStatus){lastStatus=status;mark('status',{text:status});}}).observe(document,{subtree:true,childList:true,characterData:true});
  try{new PerformanceObserver(l=>{for(const e of l.getEntries())m.longTasks.push({start:e.startTime,duration:e.duration});}).observe({entryTypes:['longtask']});}catch{}
  new PerformanceObserver(l=>{for(const e of l.getEntries())mark(e.name,{startTime:e.startTime});}).observe({entryTypes:['paint']});
  const proto=WebGL2RenderingContext.prototype, originals={}, shaders=new WeakMap(), programs=new WeakMap(),current=new WeakMap();
  for(const n of ['shaderSource','attachShader','useProgram','drawArrays','drawArraysInstanced']) originals[n]=proto[n];
  proto.shaderSource=function(shader,src){shaders.set(shader,src);return originals.shaderSource.call(this,shader,src);};
  proto.attachShader=function(program,shader){programs.set(program,(programs.get(program)||'')+'\n'+(shaders.get(shader)||''));return originals.attachShader.call(this,program,shader);};
  proto.useProgram=function(program){current.set(this,programs.get(program)||'');return originals.useProgram.call(this,program);};
  for(const n of ['drawArrays','drawArraysInstanced'])proto[n]=function(...args){
   const s=current.get(this)||'',role=s.includes('u_materialIdOut')?'terrain':s.includes('u_slotTex')?'backdrop':s.includes('u_air')?'scenes':'other';
   const t=performance.now(), result=originals[n].apply(this,args);
   if(m.draws.length<20000)m.draws.push({t,phase:m.phase,role,width:this.canvas.width,height:this.canvas.height,method:n});
   if(role==='terrain'&&!m.firstTerrain){m.firstTerrain=t;mark('first-terrain-submit');const ext=this.getExtension('WEBGL_debug_renderer_info');m.glInfo={vendor:ext?this.getParameter(ext.UNMASKED_VENDOR_WEBGL):this.getParameter(this.VENDOR),renderer:ext?this.getParameter(ext.UNMASKED_RENDERER_WEBGL):this.getParameter(this.RENDERER),version:this.getParameter(this.VERSION),maxTextureSize:this.getParameter(this.MAX_TEXTURE_SIZE)};requestAnimationFrame(()=>requestAnimationFrame(()=>mark('second-raf-after-first-terrain')));}
   return result;
  };
  mark('instrumentation-ready');
 });
 const wallStart=Date.now();let result={protocol:4,seed,label,renderEverything:true,url:`https://noita-telescope.obsoleet.org/?seed=${seed}&ng=0`,utc:new Date().toISOString(),browserVersion:browser.version(),viewport:{width:1280,height:900},network:{downloadMbps:100,addedLatencyMs:30,scope:'shared aggregate encrypted CONNECT tunnel with bounded receive queue, 15 ms added delay each direction; actual internet latency is additional; QUIC disabled',cacheDisabled:true},rendererPolicy:'Explicit ANGLE SwiftShader because this VM exposes no hardware GPU',errors,consoleLogs,hashes,workerTargets};
 try{
  await page.goto(result.url,{waitUntil:'domcontentloaded',timeout:90000});
  await page.evaluate(async()=>{
   const {app}=await import('/js/app.js');const cache=await import('/js/pixel_scene_generation.js');window.__app=app;window.__sceneCache=cache;
   const original=app.generate;app.generate=async function(...a){const start=performance.now();try{return await original.apply(this,a);}finally{window.__measurement.generations.push({start,end:performance.now(),args:a});}};
   const drawNow=app.drawNow;app.drawNow=function(...args){const m=window.__measurement,frame={start:performance.now(),phase:m.phase,camera:{...this.cam},worlds:[...this.worldsInView],pendingBefore:this.asyncRenderPending()};try{return drawNow.apply(this,args);}finally{frame.end=performance.now();frame.pendingAfter=this.asyncRenderPending();m.frames.push(frame);}};
   const {GLTerrainRenderer}=await import('/js/gl/terrain_renderer.js');const render=GLTerrainRenderer.prototype.render;
   GLTerrainRenderer.prototype.render=function(view){const m=window.__measurement,record={start:performance.now(),phase:m.phase,...view};const result=render.call(this,view);record.end=performance.now();m.terrainViews.push(record);return result;};
  });
  await page.waitForFunction(()=>window.__measurement.firstTerrain&&document.getElementById('status')?.textContent?.includes('Done'),{},{timeout:90000});
  result.seedReady=await page.evaluate(async()=>{const {appSettings}=await import('/js/settings.js');return{t:performance.now(),status:document.getElementById('status').textContent,seed:window.__app.seed,ng:window.__app.ngPlusCount,canvas:{width:window.__app.canvas.width,height:window.__app.canvas.height},camera:{...window.__app.cam},pending:window.__app.asyncRenderPending(),scenes:window.__sceneCache.getPixelSceneCacheStats(),settings:appSettings,toggleChecked:document.getElementById('debug-render-everything').checked,poiCounts:Object.fromEntries(Object.entries(window.__app.poisByPW).map(([k,v])=>[k,v.length])),sceneCounts:Object.fromEntries(Object.entries(window.__app.pixelScenesByPW).map(([k,v])=>[k,v.length]))};});
  if(!result.seedReady.toggleChecked||!result.seedReady.settings.renderEverything)throw new Error('Render Everything was not enabled for cold generation');
  console.log(JSON.stringify({progress:'seed-ready',seed,t:result.seedReady.t,renderEverything:result.seedReady.settings.renderEverything}));
  await page.screenshot({path:resolve(out,`${label}-initial.png`)});
  result.initialScreenshotMs=await page.evaluate(()=>performance.now());
  const snapshot=async(phase,zoom)=>{
   const before=await page.evaluate(({phase,zoom})=>{const a=window.__app,m=window.__measurement;m.phase=phase;const state={t:performance.now(),scenes:window.__sceneCache.getPixelSceneCacheStats(),drawIndex:m.draws.length};if(zoom!==null){a.cam.x=35*512;a.cam.y=14*512+1024;a.cam.z=zoom;a.checkBounds();a.draw();}return state;},{phase,zoom});
   let settled=false,stableSince=null,lastState=null;
   for(let i=0;i<240;i++){
    await page.waitForTimeout(250);
    const state=await page.evaluate(()=>({t:performance.now(),pending:window.__app.asyncRenderPending(),draws:window.__measurement.draws.length,requests:window.__sceneCache.getPixelSceneCacheStats().requests,failures:window.__sceneCache.getPixelSceneCacheStats().failures}));
    if(state.pending===0&&lastState&&state.draws===lastState.draws&&state.requests===lastState.requests){stableSince??=state.t;if(state.t-stableSince>=750){settled=true;break;}}else stableSince=null;
    lastState=state;
   }
   const after=await page.evaluate(async()=>{const a=window.__app,m=window.__measurement;let pixelHash=null;try{const image=a.ctx.getImageData(0,0,a.canvas.width,a.canvas.height);const digest=await crypto.subtle.digest('SHA-256',image.data);pixelHash=Array.from(new Uint8Array(digest),v=>v.toString(16).padStart(2,'0')).join('');}catch{}return{t:performance.now(),camera:{...a.cam},pending:a.asyncRenderPending(),scenes:window.__sceneCache.getPixelSceneCacheStats(),drawIndex:m.draws.length,pixelHash};});
   await page.screenshot({path:resolve(out,`${label}-${phase}.png`)});
   console.log(JSON.stringify({progress:phase,seed,settled,elapsedMs:after.t-before.t,pending:after.pending}));
   return{before,after,settled,elapsedMs:after.t-before.t};
  };
  result.initialSettled=await snapshot('initial-settled',null);
  result.detail=await snapshot('detail',1);
  result.zoomOut=await snapshot('zoom-out',0.04);
  result.returnDetail=await snapshot('return-detail',1);
  result.measurement=await page.evaluate(()=>({...window.__measurement,navigation:performance.getEntriesByType('navigation').map(e=>e.toJSON()),resourceSummary:performance.getEntriesByType('resource').map(e=>({name:e.name,startTime:e.startTime,duration:e.duration,transferSize:e.transferSize,encodedBodySize:e.encodedBodySize,decodedBodySize:e.decodedBodySize}))}));
  await page.locator('.debug-toggle').click();
  await page.locator('#debug-render-everything').scrollIntoViewIfNeeded();
  await page.screenshot({path:resolve(out,`${label}-control.png`)});
 }catch(e){result.failure=String(e);try{result.measurement=await page.evaluate(()=>window.__measurement);result.pageStatus=await page.locator('body').innerText();await page.screenshot({path:resolve(out,`${label}-failure.png`)});}catch{}}
 result.totalWallMs=Date.now()-wallStart;result.networkRequests=[...requests.values()];result.networkEncodedBytes=result.networkRequests.reduce((a,r)=>a+(r.encodedBytes||0),0);result.networkDecodedBytes=result.networkRequests.reduce((a,r)=>a+(r.decodedBytes||0),0);result.tunnel=tunnel.stats();
 const file=resolve(out,`${label}.json`);await writeFile(file,JSON.stringify(result,null,2));
 console.log(JSON.stringify({file,seed:result.seedReady?.seed,seedReadyMs:result.seedReady?.t,firstTerrainMs:result.measurement?.firstTerrain,gl:result.measurement?.glInfo,networkMB:result.networkEncodedBytes/1e6,errors:errors.length,failure:result.failure,phases:[result.detail?.elapsedMs,result.zoomOut?.elapsedMs,result.returnDetail?.elapsedMs]}));
 await browser.close();
 await tunnel.close();
}
