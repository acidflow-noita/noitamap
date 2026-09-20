import i18next from '../i18n';
import { getPortalGPUState, onPortalGPUChange, setPortalGPUEnabled, type PortalGPUState } from './index';
export function createPortalGPUControl(){
  const button=document.createElement('button');
  button.type='button';button.id='experimentalGpuPortalsButton';
  button.className='icon-button btn btn-sm btn-outline-warning text-nowrap';
  button.setAttribute('aria-pressed','false');
  const diagnostic=document.createElement('div');diagnostic.id='experimentalGpuPortalsStatus';
  diagnostic.className='dynamic-map-only';diagnostic.hidden=true;diagnostic.setAttribute('aria-live','off');
  Object.assign(diagnostic.style,{position:'fixed',bottom:'3rem',left:'0.5rem',zIndex:'980',maxWidth:'min(36rem, calc(100vw - 1rem))',
    padding:'0.35rem 0.5rem',fontSize:'0.72rem',lineHeight:'1.4',background:'#111e',color:'#eee',border:'1px solid #fa85',borderRadius:'4px',pointerEvents:'none'});
  document.body.append(diagnostic);
  const refresh=(state:PortalGPUState=getPortalGPUState())=>{
    // Portal and the experimental warning are the existing common.csv-backed
    // game translations. GPU / EXP are technology/status abbreviations.
    const name=String(i18next.t('gameContent.ui.teleport_generic',{defaultValue:'Portal'}));
    const warning=String(i18next.t('gameContent.ui.menuoptions_lowres_tooltip_exp',{defaultValue:'EXPERIMENTAL. Might cause minor rendering glitches.'}));
    const text=`GPU · ${name} · EXP`;if(button.textContent!==text)button.textContent=text;
    button.title=`${name} · GPU — ${warning}`;button.setAttribute('aria-label',button.title);
    button.setAttribute('aria-pressed',String(state.enabled));button.classList.toggle('active',state.enabled);
    diagnostic.hidden=!state.enabled;
    diagnostic.style.borderColor=state.error?'#f66':'#fa85';
    if(state.error)diagnostic.textContent=`GPU ✕ ${state.error}`;
    else if(state.stats){
      const s=state.stats,gpu=s.gpuMS===null?'—':s.gpuMS.toFixed(2);
      diagnostic.textContent=`GPU EXP · ${s.active}/${s.visible} (${s.total}) · ${s.particles.toLocaleString()} particles · ${s.fps.toFixed(0)} frames/s · ${s.simFPS.toFixed(0)}/60 sim/s · worker CPU ${s.cpuMS.toFixed(2)} ms · GPU ${gpu} ms · wait ${s.gpuWaitMS.toFixed(1)} ms · delivery ${s.deliveryMS.toFixed(1)} ms · ${(s.canvasPixels/1e6).toFixed(2)} MP · ~${(s.estimatedGPUBytes/1048576).toFixed(1)} MiB${s.capped?' · LIMIT':''}${s.slow?' · SIM BEHIND':''}${s.suspended?' · ⏸':''}\n${s.device}`;
    }else diagnostic.textContent=state.status==='loading'?'GPU EXP …':'GPU EXP —';
    diagnostic.style.whiteSpace='pre-line';
  };
  const unsubscribe=onPortalGPUChange(refresh);
  const click=()=>setPortalGPUEnabled(!getPortalGPUState().enabled);
  const languageChanged=()=>refresh();
  button.addEventListener('click',click);i18next.on('languageChanged',languageChanged);refresh();
  return {button,diagnostic,destroy(){unsubscribe();button.removeEventListener('click',click);i18next.off('languageChanged',languageChanged);button.remove();diagnostic.remove();}};
}
