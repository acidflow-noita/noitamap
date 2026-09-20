// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../src/spoiler-free',()=>({isSpoilerFree:()=>false,onSpoilerFreeChange:vi.fn()}));
const runtime=vi.hoisted(()=>({load:vi.fn(),create:vi.fn(),construct:vi.fn(),destroy:vi.fn(),enabled:vi.fn()}));
vi.mock('../src/portals/overlay',()=>({
  loadPortalResources:runtime.load,createGPURuntime:runtime.create,
  PortalGPUOverlay:class{
    constructor(...args:any[]){runtime.construct(...args);}
    setEnabled(v:boolean){runtime.enabled(v);}
    destroy(){runtime.destroy();}
    stats(){return {mode:'experimental-gpu-particles',total:1,visible:1,active:1,capped:0,particles:0,visibleParticles:0,cpuMS:0,gpuMS:null,fps:0,simFPS:0,deliveryMS:0,gpuWaitMS:0,estimatedGPUBytes:0,canvasPixels:100,device:'test GPU',suspended:false};}
  },
}));
vi.mock('../src/i18n',()=>({default:{t:(key:string)=>key.endsWith('teleport_generic')?'Portal':'EXPERIMENTAL',on:vi.fn(),off:vi.fn()}}));
import { clearPortalAnimations,getPortalGPUState,installPortalAnimations,setPortalGPUEnabled } from '../src/portals';
import { createPortalGPUControl } from '../src/portals/ui';
let control:ReturnType<typeof createPortalGPUControl>|undefined;
const viewer=()=>({addHandler:vi.fn(),removeHandler:vi.fn(),addTiledImage:vi.fn(),world:{addHandler:vi.fn(),removeHandler:vi.fn(),removeItem:vi.fn(),getItemCount:vi.fn(()=>0),getItemAt:vi.fn(),setItemIndex:vi.fn()}});
const seed={seed:42,worldSize:70,worldCenter:35,pixelScenesByPW:{'0,0':[{key:'temple/altar_top',name:'altar_top',x:0,y:984}]}};
beforeEach(()=>{setPortalGPUEnabled(false);clearPortalAnimations();vi.clearAllMocks();runtime.load.mockResolvedValue({});runtime.construct.mockReset();});
afterEach(()=>{control?.destroy();control=undefined;setPortalGPUEnabled(false);clearPortalAnimations();document.body.replaceChildren();});
describe('explicit GPU-only opt-in',()=>{
  it('does not load resources or construct a renderer when a map opens while the toggle is off',async()=>{
    installPortalAnimations(viewer(),seed);await Promise.resolve();
    expect(getPortalGPUState().enabled).toBe(false);expect(runtime.load).not.toHaveBeenCalled();expect(runtime.construct).not.toHaveBeenCalled();
  });
  it('toggles from the UI without a map reload and tears down immediately when switched off',async()=>{
    installPortalAnimations(viewer(),seed);control=createPortalGPUControl();document.body.append(control.button);
    expect(control.button.textContent).toContain('GPU');expect(control.button.title).toContain('EXPERIMENTAL');
    expect(control.button.getAttribute('aria-pressed')).toBe('false');control.button.click();
    await vi.waitFor(()=>expect(runtime.construct).toHaveBeenCalledOnce());
    expect(control.button.getAttribute('aria-pressed')).toBe('true');expect(control.diagnostic.hidden).toBe(false);
    control.button.click();expect(runtime.destroy).toHaveBeenCalledOnce();expect(control.diagnostic.hidden).toBe(true);
    expect(getPortalGPUState().status).toBe('off');
  });
  it('cancels late loading after toggling off or changing seeds',async()=>{
    let resolve!:(v:any)=>void;runtime.load.mockImplementationOnce(()=>new Promise(r=>resolve=r));
    installPortalAnimations(viewer(),seed);setPortalGPUEnabled(true);
    await vi.waitFor(()=>expect(runtime.load).toHaveBeenCalledOnce());
    const signal=runtime.load.mock.calls[0][0] as AbortSignal;
    installPortalAnimations(viewer(),{...seed,seed:43});
    await vi.waitFor(()=>expect(runtime.construct).toHaveBeenCalledOnce());
    expect(signal.aborted).toBe(true);resolve({});await Promise.resolve();await Promise.resolve();
    expect(runtime.construct).toHaveBeenCalledOnce();expect(runtime.construct.mock.calls[0][2]).toBe(43);
  });
  it('reports unavailable WebGL2 as an error, never an atlas/CPU fallback',async()=>{
    runtime.construct.mockImplementationOnce(()=>{throw new Error('WebGL 2 unavailable');});
    installPortalAnimations(viewer(),seed);setPortalGPUEnabled(true);
    await vi.waitFor(()=>expect(getPortalGPUState().status).toBe('error'));
    expect(getPortalGPUState().error).toBe('WebGL 2 unavailable');expect(runtime.construct).toHaveBeenCalledOnce();
  });
  it('restores captured room imagery when the portal toggle goes off and ignores stale frame callbacks',async()=>{
    const v=viewer();
    installPortalAnimations(v,{...seed,pixelScenesByPW:{'0,0':[{key:'excavationsite/cube_chamber',name:'cube_chamber',x:-4608,y:2048}]}});
    setPortalGPUEnabled(true);
    await vi.waitFor(()=>expect(runtime.construct).toHaveBeenCalledOnce());
    expect(v.addTiledImage).not.toHaveBeenCalled();
    const args=runtime.construct.mock.calls[0];
    const showBackgrounds=args[7] as (ids:string[])=>void;
    showBackgrounds([args[1][0].id]);
    expect(v.addTiledImage).toHaveBeenCalledOnce();
    const item={setOpacity:vi.fn()};v.addTiledImage.mock.calls[0][0].success({item});
    expect(item.setOpacity).toHaveBeenCalledWith(1);
    setPortalGPUEnabled(false);
    expect(v.world.removeItem).toHaveBeenCalledWith(item);
    showBackgrounds([args[1][0].id]);
    expect(v.addTiledImage).toHaveBeenCalledOnce();
  });
  it('can be enabled before seed metadata arrives and does not persist the opt-in',async()=>{
    const stored=JSON.stringify(window.localStorage);setPortalGPUEnabled(true);expect(getPortalGPUState().status).toBe('waiting');
    installPortalAnimations(viewer(),seed);await vi.waitFor(()=>expect(runtime.construct).toHaveBeenCalledOnce());
    expect(JSON.stringify(window.localStorage)).toBe(stored);
  });
});
