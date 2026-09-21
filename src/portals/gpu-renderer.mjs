import { GpuGridRenderer, GPU_SHADERS } from './runtime/gpu-grid-renderer.mjs';

// The upstream particle update/drawing shaders remain untouched. This final
// compositor replaces the laboratory's grid layout with actual map geometry.
export const MAP_COMPOSITE_VERTEX = `#version 300 es
uniform vec4 top;
uniform vec4 bottom;
uniform vec2 screen;
out vec2 uv;
void main(){
 vec2 p;
 if(gl_VertexID==0){p=top.xy;uv=vec2(0,1);}
 else if(gl_VertexID==1){p=top.zw;uv=vec2(1,1);}
 else if(gl_VertexID==2){p=bottom.xy;uv=vec2(0,0);}
 else{p=bottom.zw;uv=vec2(1,0);}
 p=p/screen*2.-1.;p.y=-p.y;gl_Position=vec4(p,0,1);
}`;
export class MapGpuRenderer extends GpuGridRenderer {
  constructor(canvas, resources, catalog) {
    super(resources, catalog, canvas);
    try {
      this.mapComposite=this.program(MAP_COMPOSITE_VERTEX,GPU_SHADERS.composite,['top','bottom','screen','source','previous','enableGlow']);
      this.timerExtension=this.gl.getExtension('EXT_disjoint_timer_query_webgl2');
      this.queries=[];this.gpuMS=null;
      const debug=this.gl.getExtension('WEBGL_debug_renderer_info');
      this.device=String(this.gl.getParameter(debug?debug.UNMASKED_RENDERER_WEBGL:this.gl.RENDERER));
      this.assetBytes=Object.values(resources.assets).reduce((sum,a)=>sum+a.rgba.byteLength,0);
    } catch(error){this.dispose();throw error;}
  }
  synchronize(entries) {
    this.retain([...entries.keys()]);
    for(const key of entries.keys())if(!this.histories.has(key))this.histories.set(key,this.target());
    // The only selected backend. Never call a CPU/software renderer or auto fallback.
    this.configureParticles(entries,true);
  }
  replay(key, entry, steps) {
    if(this.lost)throw new Error('Experimental GPU context lost. Toggle off and on to restart; no fallback renderer is enabled.');
    const sim=entry.simulation;
    for(let i=0;i<steps;i++)sim.step();
  }
  renderMap(entries, camera, width, height, steps) {
    if(this.lost)throw new Error('Experimental GPU context lost. Toggle off and on to restart; no fallback renderer is enabled.');
    const gl=this.gl,ext=this.timerExtension;
    if(this.canvas.width!==width||this.canvas.height!==height){this.canvas.width=width;this.canvas.height=height;}
    if(ext){
      const disjoint=gl.getParameter(ext.GPU_DISJOINT_EXT);
      while(this.queries.length&&gl.getQueryParameter(this.queries[0],gl.QUERY_RESULT_AVAILABLE)){
        const query=this.queries.shift();
        if(!disjoint)this.gpuMS=gl.getQueryParameter(query,gl.QUERY_RESULT)/1e6;
        gl.deleteQuery(query);
      }
      if(disjoint)this.gpuMS=null;
    }
    const query=ext&&this.queries.length<4?gl.createQuery():null;
    if(query)gl.beginQuery(ext.TIME_ELAPSED_EXT,query);
    try {
      this.bind(null,true);
      for(const [key,entry] of entries){
        const sim=entry.simulation,own=entry.steps??steps;
        // Each entry catches up to the shared clock; at most 2 steps per frame
        // except for the final replay steps of a portal that just entered.
        for(let i=0;i<own;i++){sim.step();this.render(sim,key,{core:true,glow:true},true);}
        if(!own)this.render(sim,key,{core:true,glow:true},false);
        this.composeMap(key,entry.portal,camera,width,height);
      }
    } finally {
      if(query){gl.endQuery(ext.TIME_ELAPSED_EXT);this.queries.push(query);}
    }
  }
  async waitForGPU() {
    const gl=this.gl, fence=gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE,0);
    if(!fence)throw new Error('Unable to fence experimental portal GPU work');
    gl.flush();
    const started=performance.now();
    try {
      for(;;){
        const status=gl.clientWaitSync(fence,0,0);
        if(status===gl.ALREADY_SIGNALED||status===gl.CONDITION_SATISFIED)return;
        if(status===gl.WAIT_FAILED||this.lost||performance.now()-started>10000)
          throw new Error('Experimental portal GPU stalled or lost its context. Toggle off and on to restart.');
        await new Promise(resolve=>setTimeout(resolve,2));
      }
    } finally {gl.deleteSync(fence);}
  }
  composeMap(key, portal, m, width, height) {
    const gl=this.gl,p=this.mapComposite;
    const project=(x,y)=>[m.a*x+m.c*y+m.e,m.b*x+m.d*y+m.f];
    const tl=project(portal.x-240,portal.y-160),tr=project(portal.x+240,portal.y-160);
    const bl=project(portal.x-240,portal.y+160),br=project(portal.x+240,portal.y+160);
    this.bind(null);gl.bindVertexArray(this.screenVAO);gl.useProgram(p.program);
    gl.uniform4f(p.uniforms.top,...tl,...tr);gl.uniform4f(p.uniforms.bottom,...bl,...br);
    gl.uniform2f(p.uniforms.screen,width,height);
    // Match upstream's nearest-neighbour presentation. Keep linear filtering
    // ONLY for the native-resolution glow/history passes, not enlarged pixels.
    const targets=[this.scene,this.histories.get(key)];
    for(const target of targets){
      gl.bindTexture(gl.TEXTURE_2D,target.texture);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
    }
    this.sample(p,'source',this.scene,0);this.sample(p,'previous',this.histories.get(key),1);
    gl.uniform1i(p.uniforms.enableGlow,1);
    // Screen blend on black, then CSS screen against the terrain. Black remains
    // neutral; there is no opaque rectangle hiding the underlying map.
    gl.enable(gl.BLEND);gl.blendFunc(gl.ONE,gl.ONE_MINUS_SRC_COLOR);
    gl.drawArrays(gl.TRIANGLE_STRIP,0,4);gl.disable(gl.BLEND);
    for(const target of targets){
      gl.bindTexture(gl.TEXTURE_2D,target.texture);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
    }
  }
  diagnostics(){
    let particles=0,visibleParticles=0,particleBytes=0;
    for(const pool of this.particles?.pools.values()??[]){particles+=pool.live;visibleParticles+=pool.visible;particleBytes+=pool.capacity*128;}
    return {device:this.device,gpuMS:this.gpuMS,particles,visibleParticles,
      estimatedGPUBytes:particleBytes+this.targets.size*480*320*4+this.canvas.width*this.canvas.height*4+this.assetBytes};
  }
  dispose(){
    for(const query of this.queries??[])this.gl.deleteQuery(query);
    this.queries=[];
    super.dispose();
    // Release ONLY this experiment's context, never the terrain/drawing context.
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
