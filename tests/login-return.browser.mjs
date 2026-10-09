// Build main and Pro first, then run:
// node tests/login-return.browser.mjs <main-output> <pro-output> [result.json]
// PROBE_BROWSER=firefox selects Firefox; BROWSER_EXECUTABLE optionally selects
// a system browser. Uses a local mock provider on a separate origin: no real
// account operations. The application leaves and reloads on every login.
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
const require=createRequire(import.meta.url);
const {chromium,firefox}=require('playwright');
const root=resolve(process.argv[2]||'dist'),proRoot=resolve(process.argv[3]||'task/noitamap-pro/public');
const out=resolve(process.argv[4]||'/tmp/noitamap-login-return.json'),kind=process.env.PROBE_BROWSER||'chromium';
const mime={'.html':'text/html','.js':'text/javascript','.json':'application/json','.css':'text/css','.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp','.svg':'image/svg+xml','.wasm':'application/wasm','.dzi':'application/xml'};
const app=createServer(async(req,res)=>{
  try{
    let path=new URL(req.url,'http://local').pathname,folder=root;
    if(path==='/storage-probe'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Local storage probe</title>');return;}
    if(path.startsWith('/__pro__/')){folder=proRoot;path=path.slice('/__pro__'.length);}
    const absolute=resolve(folder,'.'+decodeURIComponent(path));if(!absolute.startsWith(folder+'/')&&absolute!==folder)throw new Error('path');
    const file=(await stat(absolute)).isDirectory()?join(absolute,'index.html'):absolute;
    res.setHeader('Content-Type',mime[extname(file)]||'application/octet-stream');res.end(await readFile(file));
  }catch{res.writeHead(404);res.end('missing');}
});
await new Promise(r=>app.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${app.address().port}`;
const authRequests=[];
const auth=createServer((req,res)=>{
  const url=new URL(req.url,'http://local');
  res.setHeader('Access-Control-Allow-Origin',base);res.setHeader('Access-Control-Allow-Headers','Authorization');
  res.setHeader('Access-Control-Allow-Methods','GET,OPTIONS');
  if(req.method==='OPTIONS'){res.end();return;}
  if(url.pathname==='/auth/check'){
    const provider=String(req.headers.authorization).includes('twitch')?'twitch':'patreon';
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify({authenticated:true,isSubscriber:true,nickname:'Local fixture',username:'Local fixture',provider}));return;
  }
  if(url.pathname==='/auth/login'||url.pathname==='/auth/twitch/login'){
    const provider=url.pathname.includes('twitch')?'twitch':'patreon',back=new URL(url.searchParams.get('redirect'));
    if(back.origin!==base){res.writeHead(400);res.end('unexpected origin');return;}
    authRequests.push({provider,checkpoint:back.searchParams.get('auth_resume')});
    const success=new URL(back),denied=new URL(back);
    success.hash=new URLSearchParams({auth:'success',token:'local-fixture-'+provider}).toString();
    denied.searchParams.set('auth_error','access_denied');
    res.setHeader('Content-Type','text/html');
    res.end(`<!doctype html><title>Local ${provider} test provider</title><button id="approve">Return as subscriber</button><button id="deny">Cancel login</button><script>
      document.getElementById('approve').onclick=()=>location.href=${JSON.stringify(success.href)};
      document.getElementById('deny').onclick=()=>location.href=${JSON.stringify(denied.href)};
    </script>`);return;
  }
  res.writeHead(404);res.end('unknown local auth route');
});
await new Promise(r=>auth.listen(0,'127.0.0.1',r));const authBase=`http://127.0.0.1:${auth.address().port}`;
const browserType=kind==='firefox'?firefox:chromium;
const executablePath=process.env.BROWSER_EXECUTABLE;
const browser=await browserType.launch({headless:true,...(executablePath?{executablePath}:{}),
  ...(kind==='firefox'&&executablePath?{channel:'moz-firefox'}:{})});
const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage(),probe=await context.newPage();
const result={root,proRoot,kind,version:browser.version(),cases:[],errors:[],logs:[],authRequests};
page.on('pageerror',e=>result.errors.push(e.stack||String(e)));
page.on('console',m=>{if(/Auth|workspace|Pro|Drawing|Sidebar|saved/i.test(m.text()))result.logs.push(m.text());});
page.on('dialog',d=>d.accept());
await context.addInitScript(({authBase,base})=>{if(location.origin!==base)return;window.addEventListener('error',e=>console.log('workspace browser-error',JSON.stringify({message:e.message,file:e.filename,line:e.lineno,column:e.colno,stack:e.error?.stack})));localStorage.setItem('noitamap_auth_worker',authBase);sessionStorage.setItem('noitamap-drop-hint-shown','true');},{authBase,base});
await page.route(/\/(current|previous)_seed\.txt/,route=>route.fulfill({status:200,body:route.request().url().includes('previous')?'3':'2',contentType:'text/plain',headers:{'access-control-allow-origin':'*'}}));
await page.route('https://noitamap-pro.acidflow.stream/pro.js?*',route=>route.fulfill({status:200,contentType:'text/javascript',headers:{'access-control-allow-origin':'*'},
  body:`import {init as actual} from ${JSON.stringify(base+'/__pro__/pro.js')};export function init(hooks){hooks.proAssetBaseUrl=${JSON.stringify(base+'/__pro__/')};return actual(hooks);}`}));
await probe.goto(base+'/storage-probe');
const readDB=(name,store,key)=>probe.evaluate(({name,store,key})=>new Promise((resolve,reject)=>{
  const request=indexedDB.open(name);
  request.onerror=()=>reject(request.error);
  request.onsuccess=()=>{
    const db=request.result;
    if(!db.objectStoreNames.contains(store)){db.close();resolve(null);return;}
    const transaction=db.transaction(store),read=key?transaction.objectStore(store).get(key):transaction.objectStore(store).getAll();
    read.onsuccess=()=>{resolve(read.result);db.close();};read.onerror=()=>{reject(read.error);db.close();};
  };
}),{name,store,key});
const frames=()=>page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
const ready=()=>page.waitForFunction(()=>window.__noitamap?.getMap()==='dynamic-main-branch'&&window.noitamap?.getGeneration()?.seed===12345&&!document.querySelector('#dynamicGenerateButton .spinner-border')&&!document.getElementById('map-loading-strip')?.classList.contains('visible'),null,{timeout:120000});
const drawingReady=()=>page.waitForFunction(()=>window.__noitamap?.isProFeatureReady?.('drawing')&&!window.__noitamap.authService.getLoginReturnState?.('drawing')&&!!document.querySelector('#drawings-list [data-id].active'),null,{timeout:90000});
const snapshot=()=>page.evaluate(()=>{
  const h=window.__noitamap,v=h.osd.viewport,c=v.getCenter(true);
  return{map:h.getMap(),seed:h.getSeedParams().seed,view:{x:c.x,y:c.y,zoom:v.getZoom(true)},overlays:h.getEnabledOverlays().sort(),
    canvas:new URL(location.href).searchParams.get('c'),open:!!document.querySelector('#drawing-sidebar.open'),
    active:document.querySelector('#drawings-list [data-id].active')?.getAttribute('data-id'),
    selectedTool:document.querySelector('input[name="drawing-tool"]:checked')?.id,
    visibility:document.querySelector('#toggle-visibility')?.innerHTML,
    color:document.querySelector('#custom-color-picker')?.value,stroke:document.querySelector('input[name="stroke-width"]:checked')?.id,fill:document.querySelector('input[name="fill-alpha"]:checked')?.id,
    rows:[...document.querySelectorAll('#drawings-list [data-id]')].map(el=>el.getAttribute('data-id')),
    authenticated:h.authService.getState().authenticated,subscriber:h.authService.getState().isSubscriber,
    ticket:!!sessionStorage.getItem('noitamap-login-return-v1'),url:location.href};
});
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const moveView=async(x,y,zoom)=>{
  await page.evaluate(({x,y,zoom})=>{
    const v=window.__noitamap.osd.viewport;v.panTo(new OpenSeadragon.Point(x,y),true);v.zoomTo(zoom,undefined,true);
  },{x,y,zoom});await frames();
};
const login=async(provider,decision='approve')=>{
  const before=await snapshot();result.errorsBeforeLogin??=result.errors.slice();
  await page.evaluate(provider=>window.__noitamap.authService[provider==='twitch'?'loginTwitch':'login'](),provider);
  await page.waitForFunction(origin=>location.origin===origin,authBase,{timeout:30000});
  const redirect=new URL(await page.evaluate(()=>location.href)).searchParams.get('redirect'),id=new URL(redirect).searchParams.get('auth_resume');
  const checkpoint=await readDB('noitamap-login-workspace','workspaces',id);
  if(!checkpoint)throw new Error('No durable drawing checkpoint before leaving the app');
  result.cases.push({name:provider+' persisted before redirect',correct:checkpoint.drawing?.id===before.active,
    drawingId:checkpoint.drawing?.id,shapes:checkpoint.drawing?.shapes.length,privateHistory:checkpoint.editor.undo.length,privateClipboard:checkpoint.editor.clipboard.length});
  // BiDi may omit navigation events for a cached Back return; observe the
  // actual document, without depending on a second DOMContentLoaded event.
  if(decision==='back')await page.evaluate(()=>history.back());
  else await page.locator('#'+decision).click();
  await page.waitForFunction(origin=>location.origin===origin,base,{timeout:45000});await ready();await drawingReady();await frames();
  const after=await snapshot(),drawings=await readDB('noitamap-drawings','drawings');
  const drawing=drawings.find(row=>row.id===checkpoint.drawing?.id);
  const sameView=['x','y','zoom'].every(key=>Math.abs(after.view[key]-before.view[key])<(key==='zoom'?1e-12:1e-7));
  const correct=after.active===before.active&&after.map===before.map&&after.seed===before.seed&&sameView
    &&JSON.stringify(after.overlays)===JSON.stringify(before.overlays)&&after.canvas===before.canvas&&after.open===before.open
    &&drawings.length===before.rows.length&&hash(drawing?.shapes)===hash(checkpoint.drawing?.shapes)&&!after.ticket;
  result.cases.push({name:provider+' '+decision+' restores exact active drawing and live view',correct,before,after,
    drawingCount:drawings.length,geometryMatches:hash(drawing?.shapes)===hash(checkpoint.drawing?.shapes),sameView,
    checkpointEditor:{...checkpoint.editor,undo:checkpoint.editor.undo.length,redo:checkpoint.editor.redo.length,clipboard:checkpoint.editor.clipboard.length}});
  console.log(JSON.stringify(result.cases.at(-1)));
  return checkpoint;
};
try{
  await page.goto(base+'/?m=dy&se=12345&lng=en',{waitUntil:'domcontentloaded'});await ready();
  await page.locator('label[for="drawToggleBtn"]').click();await page.waitForSelector('#drawing-sidebar.open #auth-login-btn',{timeout:60000});
  await page.locator('#example-drawings-list [data-file="drawing-example.webp"]').click();
  await page.waitForSelector('#drawings-list [data-id].active',{timeout:60000});await ready();await frames();
  await moveView(137.125,845.875,0.000723456789);
  await page.evaluate(()=>window.__noitamap.showOverlay('biomeBoundaries',true));
  await login('patreon','back');
  const example=await login('patreon');
  if(!await page.evaluate(()=>window.__noitamap.authService.getState().isSubscriber))throw new Error('Subscriber capability did not unlock');

  // Add an edit and sign in immediately, before the existing500ms autosave.
  await page.locator('label[for="tool-rect"]').click();
  await page.mouse.move(340,240);await page.mouse.down();await page.mouse.move(510,360,{steps:5});await page.mouse.up();
  await page.keyboard.press('KeyV');await page.mouse.click(340,285);await page.keyboard.press('Control+c');
  await moveView(-311.625,902.375,0.000923456789);
  await page.locator('label[for="canvas-white"]').click();
  const edited=await login('twitch');
  result.cases.push({name:'pending edit included in checkpoint',correct:edited.drawing.shapes.length===example.drawing.shapes.length+1,
    before:example.drawing.shapes.length,after:edited.drawing.shapes.length});
  await page.keyboard.press('Control+z');
  await page.waitForFunction(expected=>{
    const row=document.querySelector('#drawings-list [data-id].active');return row?.textContent.includes(expected+' shapes');
  },example.drawing.shapes.length,{timeout:10000});
  const afterUndo=await readDB('noitamap-drawings','drawings');
  result.cases.push({name:'undo history survives login',correct:afterUndo.find(v=>v.id===edited.drawing.id).shapes.length===example.drawing.shapes.length});

  // A separate imported Magic Screenshot must restore its own ID, not the
  // earlier example or a newly created duplicate.
  await page.evaluate(()=>window.__noitamap.authService.logout());
  await page.locator('#import-webp-input-unauth').setInputFiles({name:'login-import.webp',mimeType:'image/webp',buffer:await readFile(root+'/assets/examples/drawing-example.webp')});
  await page.waitForFunction(old=>{const id=document.querySelector('#drawings-list [data-id].active')?.getAttribute('data-id');return !!id&&id!==old;},example.drawing.id);
  await ready();await frames();await moveView(501.125,-97.875,0.001123456789);
  await login('patreon','deny');await login('patreon');

  // Hidden drawings and a closed sidebar must remain in that state, including
  // editor defaults. Reopening must not select another saved record.
  await page.locator('label[for="tool-circle"]').click();
  await page.locator('#custom-color-picker').fill('#12abcd');
  await page.locator('#custom-color-picker').dispatchEvent('change');
  await page.locator('label[for="stroke-15"]').click();
  await page.locator('label[for="fill-alpha-1"]').click();
  await page.locator('label[for="fill-alpha-none"]').click();
  await page.locator('#toggle-visibility').click();
  const hiddenBefore=await snapshot();
  const hiddenCheckpoint=await login('twitch');
  const hiddenAfter=await snapshot();
  result.cases.push({name:'hidden drawing and tool controls survive login',correct:
    hiddenCheckpoint.editor.visible===false&&hiddenCheckpoint.editor.filledOpacity===0.5&&
    ['visibility','selectedTool','color','stroke','fill'].every(key=>hiddenBefore[key]===hiddenAfter[key]),hiddenBefore,hiddenAfter});
  await page.locator('#close-sidebar').click();await frames();
  const closedCheckpoint=await login('twitch');
  result.cases.push({name:'closed menu and hidden drawing stay closed and hidden',correct:
    closedCheckpoint.sidebarOpen===false&&closedCheckpoint.editor.visible===false&&!(await snapshot()).open});
  await page.locator('label[for="drawToggleBtn"]').click();await frames();
  const reopened=await snapshot();
  result.cases.push({name:'reopening retains restored editor settings',correct:
    ['visibility','selectedTool','color','stroke','fill'].every(key=>hiddenBefore[key]===reopened[key]),reopened});

  // A failed durable save must leave the same workspace in place, never send
  // the browser to the provider with an empty/incomplete checkpoint.
  const failureBefore=await snapshot(),authCount=authRequests.length;
  await page.evaluate(()=>{
    const original=Storage.prototype.setItem;
    window.__restoreStorage=()=>{Storage.prototype.setItem=original;};
    Storage.prototype.setItem=function(key,value){
      if(this===sessionStorage&&key==='noitamap-login-return-v1')throw new DOMException('Local test quota','QuotaExceededError');
      return original.call(this,key,value);
    };
  });
  const saveFailureDialog=page.waitForEvent('dialog');
  await page.evaluate(()=>window.__noitamap.authService.loginTwitch());
  const saveError=await saveFailureDialog;await frames();
  await page.evaluate(()=>window.__restoreStorage());
  const failureAfter=await snapshot();
  result.cases.push({name:'failed save cancels login without losing workspace',correct:
    /Could not save your workspace/.test(saveError.message())&&authRequests.length===authCount&&
    failureBefore.active===failureAfter.active&&failureBefore.url===failureAfter.url&&failureAfter.open,
    message:saveError.message()});

  await page.screenshot({path:out.replace(/\.json$/,'.png')});
}catch(error){result.failure=String(error);result.failureUrl=page.url();try{result.failureState=await snapshot();}catch{}console.error(error);}
finally{result.passed=!result.failure&&!result.errors.length&&result.cases.every(c=>c.correct);if(!result.passed)process.exitCode=1;await writeFile(out,JSON.stringify(result,null,2));await browser.close();await new Promise(r=>app.close(r));await new Promise(r=>auth.close(r));}
