import { generateDynamicMap, ensurePixelSceneData, releaseParallelWorlds, getAllPixelSceneKeys } from '../../src/telescope/telescope-adapter';
import { setFullPixelTerrainForBake } from '../../src/renderer_settings';
import * as bridge from '../../src/telescope/telescope-osd-bridge';
import { pixelSceneConfig } from '../../src/telescope/telescope-osd-bridge';
import { getZip } from '../../src/data-archive';
import { decodePngToRgba } from '../../src/telescope/png-decode';
import { compositeTerrain, textureColor } from '../../src/telescope/terrain-backgrounds';
import { readRGBA, writeRGBA } from '../../src/telescope/terrain-scenes';

export async function run() {
  // Test-only exports supplied by the fixture build plugin.
  const { getScenePngIndex, compositeSceneBitmap, sceneRenderKey, __warmSceneBuild } = bridge as any;
  const fullPixels=(globalThis as any).__watercaveFullPixels !== false;
  setFullPixelTerrainForBake(fullPixels);
  window.location.search=fullPixels?'?terrain=gpu':'';
  const gen=await generateDynamicMap({seed:12726363,parallelWorlds:[0],unlocks:null});
  const selected=Object.values(gen.pixelScenesByPW).flat().find(s=>s.name.startsWith('watercave_layout'))!;
  const index=await getScenePngIndex();
  const zip=await getZip('main');
  const bg=decodePngToRgba(await zip!.file('data/weather_gfx/background_cave_04_alt.png')!.async('arraybuffer'));
  const painter=await import('noita-telescope-full-pixels/pixel_scene_generation.js');
  await painter.initPixelSceneTextures();
  const samples: any[]=[];
  try {
    for(let layout=1;layout<=5;layout++) {
      const key=`general/watercave_layout_${layout}`,name=`watercave_layout_${layout}`;
      const raw=await ensurePixelSceneData(key,{art:false});
      const before=raw.imgElement.slice();
      const scene={...selected,key,name,imgElement:new Uint8Array(raw.imgElement.length).fill(255)};
      const begin=performance.now();
      const result=await compositeSceneBitmap(key,scene,index);
      const ms=performance.now()-begin;
      if(layout===4)(globalThis as any).__watercavePreview?.(result.bitmap);
      const actual=result.bitmap.getContext('2d').getImageData(0,0,result.width,result.height).data;
      const p=painter.texturePixelSceneForBiome(name,raw.imgElement,raw.width,raw.height,'watercave',scene.x,scene.y);
      const expected=new Uint8ClampedArray(p.pixels.length);
      let mismatches=0,air=0,solid=0,translucent=0;
      const colors=new Set();
      for(let i=0;i<expected.length;i+=4) {
        const x=scene.x+(i/4)%raw.width,y=scene.y+Math.floor(i/4/raw.width);
        const forceAir=before[i+3]&&before[i]===0&&before[i+1]===0&&before[i+2]===66;
        const material=forceAir?0:readRGBA(p.pixels,i);
        const needsBg=forceAir||p.airMask?.[i+3];
        const background=needsBg?textureColor(bg,x+17920,y+7168):0;
        const color=compositeTerrain(material,background);
        writeRGBA(expected,i,color>>>24?color:0);
        for(let c=0;c<4;c++)if(expected[i+c]!==actual[i+c])mismatches++;
        if(forceAir)air++;else if(p.pixels[i+3]===255)solid++;else if(p.pixels[i+3])translucent++;
        if(actual[i+3])colors.add(readRGBA(actual,i));
      }
      if(before.some((v:number,i:number)=>v!==raw.imgElement[i]))throw new Error('Raw scene mutated');
      samples.push({layout,width:result.width,height:result.height,ms,mismatches,air,solid,translucent,colors:colors.size,
        rawVisualInIndex:index.visualByName.has(name),renderKey:sceneRenderKey(scene)});
      result.bitmap.close();
    }
    const onlyWater={...gen,pixelScenesByPW:{'0,0':[selected]}};
    // A valid old raw PNG under the previous key must not defeat the correction.
    (globalThis as any).__warmSceneStore.set(selected.key, {width:512,height:512,
      blob:new Blob([await zip!.file('data/biome_impl/'+selected.name+'.png')!.async('arraybuffer')],{type:'image/png'})});
    const first=await __warmSceneBuild(onlyWater),a=first.bitmapByKey.get(sceneRenderKey(selected));
    const begin=performance.now(),second=await __warmSceneBuild(onlyWater);
    const cache={ms:performance.now()-begin,sameBitmap:a===second.bitmapByKey.get(sceneRenderKey(selected))};
    const persistedKey=sceneRenderKey(selected);
    const revisedCached=(globalThis as any).__warmSceneStore.has(persistedKey);
    const diskBitmap=await createImageBitmap((globalThis as any).__warmSceneStore.get(persistedKey).blob);
    const diskPixels=(diskBitmap as any).getContext('2d').getImageData(0,0,512,512).data;
    const freshPixels=a.getContext('2d').getImageData(0,0,512,512).data;
    const diskMatches=freshPixels.every((v:number,i:number)=>v===diskPixels[i]);diskBitmap.close();
    first.release();
    const survivesRelease=second.bitmapByKey.get(persistedKey).width===512;
    second.release();
    const scene={...selected,x:selected.x+7,y:selected.y+11};
    const shiftedKey=sceneRenderKey(scene);
    const bgOnKey=sceneRenderKey(selected);
    pixelSceneConfig.layers.background=false;
    const bgOffKey=sceneRenderKey(selected);
    const transparent=await compositeSceneBitmap(selected.key,selected,index);
    const bytes=transparent.bitmap.getContext('2d').getImageData(0,0,512,512).data;
    const raw=await ensurePixelSceneData(selected.key,{art:false});
    let forceAirOpaque=0;
    for(let i=0;i<bytes.length;i+=4)if(raw.imgElement[i+3]&&raw.imgElement[i]===0&&raw.imgElement[i+1]===0&&raw.imgElement[i+2]===66&&bytes[i+3])forceAirOpaque++;
    transparent.bitmap.close();
    pixelSceneConfig.layers.mid=false;
    const disabled=await compositeSceneBitmap(selected.key,selected,index);
    pixelSceneConfig.layers.background=true;pixelSceneConfig.layers.mid=true;
    const unchangedKeys={frame:sceneRenderKey({key:'general/watercave',x:-2048,y:0}),
      friend:sceneRenderKey({key:'general/friendroom',x:3072,y:5632}),
      ordinary:sceneRenderKey({key:'coalmine/shop',variantKey:'biome=coalmine'} )};
    for(const key of getAllPixelSceneKeys()) if(!/watercave_layout_/.test(key))
      (globalThis as any).__warmSceneStore.set(key,{});
    const priorKeys=[...(globalThis as any).__warmSceneStore.keys()];
    await bridge.prefetchAllSceneBitmaps(()=>true);
    const addedPrefetchKeys=[...(globalThis as any).__warmSceneStore.keys()].filter(key=>!priorKeys.includes(key));
    Object.assign(cache,{revisedCached,diskMatches,survivesRelease,shiftedKeyIsSeparate:shiftedKey!==bgOnKey,
      addedPrefetchKeys,
      backgroundKeyIsSeparate:bgOnKey!==bgOffKey,forceAirOpaque,disabled:disabled===null,unchangedKeys});
    return {fullPixels,selected:{key:selected.key,x:selected.x,y:selected.y,variantKey:selected.variantKey},samples,cache};
  } finally {releaseParallelWorlds();}
}
