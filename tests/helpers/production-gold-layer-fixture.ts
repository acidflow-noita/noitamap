import OpenSeadragon from 'openseadragon';
import { setFullPixelTerrainForBake } from '../../src/renderer_settings';
import { generateDynamicMap, ensurePixelSceneData } from '../../src/telescope/telescope-adapter';
import { installViewportLayerDrawing } from '../../src/telescope/instant-terrain-viewport';
import { readRGBA } from '../../src/telescope/terrain-scenes';
import { createTerrainOwnership } from '../../src/telescope/terrain-policy';
import { GENERATOR_CONFIG } from '../../lib/noita-telescope-vm/js/generator_config.js';

export async function verifyProductionGoldLayer(seed: number, initialCamera?: { x:number; y:number; z:number }) {
  window.location.search = '?terrain=gpu';
  setFullPixelTerrainForBake(false);
  (globalThis as any).OpenSeadragon = OpenSeadragon;
  const {addPixelScenes} = await import('../../src/telescope/telescope-osd-bridge');
  const generation = await generateDynamicMap({ seed, ngPlus: 0, parallelWorlds: [-1, 0, 1], unlocks: null });
  const all = Object.values(generation.pixelScenesByPW).flat();
  const gold = all.find(s => s.key === 'general/solid_wall_hidden_cavern' && s.x > -17920 && s.x < 17920)!;
  if (!gold) throw new Error('Production generation dropped gold scene');
  const raw = await ensurePixelSceneData(gold.key);
  const cameraAudit = initialCamera ? {
    scenes: all.filter(s => s.x < initialCamera.x + 700 && s.x + s.width > initialCamera.x - 700 &&
      s.y < initialCamera.y + 700 && s.y + s.height > initialCamera.y - 700)
      .map(({key,name,x,y,width,height}) => ({key,name,x,y,width,height})),
    biomeColor: generation.biomeData.pixels[Math.floor((initialCamera.y + 14 * 512) / 512) * 70 + Math.floor((initialCamera.x + 35 * 512) / 512)],
    owner: (() => {const owners=createTerrainOwnership(generation.tileLayers,generation.biomeData.pixels,GENERATOR_CONFIG,70); return owners.names[owners.at(initialCamera.x,initialCamera.y)];})(),
  } : undefined;
  const entries: any[] = [];
  const screen = document.createElement('canvas'); screen.width = screen.height = 512;
  const target = screen.getContext('2d')!; target.imageSmoothingEnabled = false;
  const viewer: any = new OpenSeadragon.EventSource(), world: any = new OpenSeadragon.EventSource();
  let bounds = new OpenSeadragon.Rect(gold.x, gold.y, 512, 512);
  // URL z is logarithmic: zoomFromLogZoom(z) = 2 ** (-z / 100).
  if(initialCamera){ const width=2 ** (initialCamera.z / 100); bounds=new OpenSeadragon.Rect(initialCamera.x-width/2,initialCamera.y-width/2,width,width); }
  const viewport = {
    getBounds: () => bounds, getBoundsWithMargins: () => bounds, getBoundsNoRotate: () => bounds,
    getCenter: () => bounds.getCenter(), getRotation: () => 0, getFlip: () => false,
    getZoom: () => 1 / bounds.width, getContainerSize: () => new OpenSeadragon.Point(512,512),
    deltaPixelsFromPointsNoRotate: (p:any) => p.times(512/bounds.width),
    pixelFromPoint: (p:any) => p.minus(bounds.getTopLeft()).times(512/bounds.width),
    pixelFromPointNoRotate: (p:any) => p.minus(bounds.getTopLeft()).times(512/bounds.width),
  };
  Object.assign(world, { getItemCount: () => entries.length, getItemAt: (i:number) => entries[i].item,
    ensureTilesUpToDate() {}, removeItem(item:any) { item.source.destroy(); } });
  const drawer: any = Object.create((OpenSeadragon as any).CanvasDrawer.prototype);
  Object.assign(drawer, { _renderingTarget:screen, context:target, sketchCanvas:null, sketchContext:null,
    viewport, viewer, _imageSmoothingEnabled:false, options:{usePrivateCache:false} });
  let onFrame = () => {};
  Object.assign(viewer, { world, viewport, drawer, isAnimating:()=>false,
    tileCache:new (OpenSeadragon as any).TileCache({maxImageCacheCount:20}), tileRetryMax:0,
    forceRedraw:()=>queueMicrotask(()=>onFrame()),
    addTiledImage(options:any) {
      const item = new (OpenSeadragon as any).TiledImage({source:options.tileSource,viewer,viewport,drawer,tileCache:viewer.tileCache,
        imageLoader:new (OpenSeadragon as any).ImageLoader({jobLimit:2}),width:options.width,x:options.x,y:options.y,
        immediateRender:true,maxTilesPerFrame:16,discardLevelsBelowDownsampleRatio:1,ajaxHeaders:{}});
      item.getDrawer=()=>drawer;
      entries.push({options,item});world.raiseEvent('add-item',{item});options.success({item});
    },
  });
  installViewportLayerDrawing(viewer);
  await addPixelScenes(viewer, generation, 0, true);
  if (entries.length !== 1) throw new Error(`Production scene layer count ${entries.length}`);
  const { options, item } = entries[0], source = item.source;
  const tiles: any[] = [];
  let directGold = 0;
  const x0 = Math.floor((gold.x - options.x) / 512), y0 = Math.floor((gold.y - options.y) / 512);
  const x1 = Math.floor((gold.x + gold.width - 1 - options.x) / 512), y1 = Math.floor((gold.y + gold.height - 1 - options.y) / 512);
  try {
    if (typeof source.__drawViewport !== 'function') throw new Error('Production lazy scenes lost their direct drawer');
    const frames: any[] = [];
    const draw = async (name:string, area: OpenSeadragon.Rect) => {
      bounds=area;viewer.raiseEvent('viewport-change',{});
      await new Promise<void>((resolve,reject)=>{
        onFrame=()=>{try {target.clearRect(0,0,512,512);drawer._drawTiles(item);if(source.sceneViewportReady){onFrame=()=>{};resolve();}}catch(e){reject(e)}};
        onFrame();
      });
      const pixels=target.getImageData(0,0,512,512).data;
      let painted=0;for(let i=3;i<pixels.length;i+=4)if(pixels[i])painted++;
      frames.push({name,x:area.x,y:area.y,width:area.width,painted,stats:{...source.sceneTileStats.viewport}});
      return pixels;
    };
    if(initialCamera) await draw('reported-camera',bounds);
    const nativeBounds = new OpenSeadragon.Rect(gold.x,gold.y,512,512);
    await draw('stash-overview', new OpenSeadragon.Rect(gold.x-768,gold.y-768,2048,2048));
    const native=await draw('native-stash-after-zoom',nativeBounds);
    let goldVisible=0;for(let i=0;i<native.length;i+=4)if(readRGBA(raw.imgElement,i)===0xffebcd01 && native[i+3]===255)goldVisible++;
    directGold = goldVisible;
    if(goldVisible!==628)throw new Error(`Actual direct drawer only shows ${goldVisible} gold cells`);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const level = source.maxLevel;
      if (!source.tileExists(level, x, y)) throw new Error(`Actual layer drops gold intersection ${x},${y}`);
      const tile = await new Promise<any>((resolve, reject) => {
        new (OpenSeadragon as any).ImageJob({source, tile:{level,x,y}, src:source.getTileUrl(level,x,y),
          callback:(job:any)=>job.errorMsg?reject(new Error(job.errorMsg)):resolve(job.data)}).start();
      });
      tiles.push({x,y});
      target.drawImage(tile.canvas, options.x + x * 512 - gold.x, options.y + y * 512 - gold.y);
    }
    const pixels = target.getImageData(0,0,512,512).data;
    let goldCells=0, shownGold=0, opacity=0; const colors=new Set<number>();
    for(let i=0;i<pixels.length;i+=4) {
      if(pixels[i+3]) opacity++;
      if(readRGBA(raw.imgElement,i)===0xffebcd01){goldCells++; if(pixels[i+3]===255)shownGold++; colors.add(readRGBA(pixels,i));}
    }
    return { seed, gold:{key:gold.key,x:gold.x,y:gold.y}, scenes:all.length, layer: {x:options.x,y:options.y,width:source.width,height:source.height,maxLevel:source.maxLevel},
      cameraAudit, frames, tiles, directGold, goldCells, shownGold, colors:[...colors], opacity, stats:source.sceneTileStats };
  } finally { source.destroy(); }
}
