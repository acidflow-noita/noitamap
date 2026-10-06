import { initTelescope, generateDynamicMap, releaseParallelWorlds } from '../../src/telescope/telescope-adapter';
// @ts-ignore -- the native test's build plugin injects these probe-only exports.
import { instantSceneMasks, __warmSceneBuild } from '../../src/telescope/telescope-osd-bridge';
import { isRepeatedTempleTemplate } from '../../src/telescope/terrain-policy';

export async function run() {
  window.location.search = '?terrain=gpu';
  const samples: any[] = [];
  const timed = async (name: string, work: () => any) => {
    await new Promise(resolve => setTimeout(resolve, 0));
    const begin = performance.now(); let last = begin; const gaps: number[] = [];
    const pulse = () => { const now=performance.now(); gaps.push(now-last); last=now; };
    const timer=setInterval(pulse, 1);
    try { return await work(); }
    finally { pulse(); clearInterval(timer); samples.push({name,elapsedMs:performance.now()-begin,maxGapMs:Math.max(...gaps),gapsOver50:gaps.filter(g=>g>=50),ticks:gaps.length}); }
  };
  try {
    await timed('initialization',()=>initTelescope());
    for (const seed of [74803,74804,12726363]) {
      const gen=await timed('generation '+seed,()=>generateDynamicMap({seed,unlocks:null,parallelWorlds:[-1,0,1]}));
      const masks=await timed('masks '+seed,()=>instantSceneMasks(gen)); samples.push({seed, maskHash:(globalThis as any).__hashMasks(masks), generationHash:(globalThis as any).__generationHash(gen)});
      const liveScenes={...gen,pixelScenesByPW:Object.fromEntries(Object.entries(gen.pixelScenesByPW).map(([key,scenes]:any)=>[key,scenes.filter((scene:any)=>!isRepeatedTempleTemplate(scene))]))};
      const built=await timed('bitmaps '+seed,()=>__warmSceneBuild(liveScenes));
      samples.push({seed,artworkHash:(globalThis as any).__hashSceneImages(built.bitmapByKey),bitmapCount:built.bitmapByKey.size});
      built.release();
    }
    return {samples,scope:'Native event-loop gaps; no browser, GPU or OSD measurements'};
  } finally { releaseParallelWorlds(); }
}
