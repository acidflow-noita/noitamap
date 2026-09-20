import { GpuScene } from "./gpu-scene.mjs";
import { GpuParticles } from "./gpu-particles.mjs";

export const GPU_SHADERS = {
  quadVertex: `#version 300 es
layout(location=0) in vec4 corners01; layout(location=1) in vec4 corners23;
layout(location=2) in vec4 color; layout(location=3) in vec4 region;
out vec4 tint; out vec2 uv;
void main(){vec2 p; vec2 t;
if(gl_VertexID==0){p=corners01.xy;t=vec2(0,0);}else if(gl_VertexID==1){p=corners01.zw;t=vec2(1,0);}
else if(gl_VertexID==2){p=corners23.zw;t=vec2(0,1);}else{p=corners23.xy;t=vec2(1,1);}
p=p/vec2(480,320)*2.-1.;p.y=-p.y;gl_Position=vec4(p,0,1);uv=mix(region.xy,region.zw,t);tint=color;}`,
  quadFragment: `#version 300 es
precision highp float; in vec4 tint; in vec2 uv; uniform sampler2D image;
uniform bool textured; out vec4 result;
void main(){result=tint;if(textured)result*=texture(image,uv);}`,
  screenVertex: `#version 300 es
out vec2 uv; void main(){vec2 p=vec2((gl_VertexID&1)*2-1,(gl_VertexID>>1)*2-1);uv=p*.5+.5;gl_Position=vec4(p,0,1);}`,
  horizontal: `#version 300 es
precision highp float; in vec2 uv; uniform sampler2D source; out vec4 result;
void main(){vec3 sum=vec3(0);for(int x=-5;x<=5;x++)sum+=texture(source,uv+vec2(float(x)*1.5/480.,0)).rgb;result=vec4(sum*.1,1);}`,
  history: `#version 300 es
precision highp float; in vec2 uv; uniform sampler2D source; uniform sampler2D previous; out vec4 result;
void main(){vec3 old=vec3(0);for(int y=-5;y<=5;y++)old+=texture(previous,uv+vec2(0,float(y)*1.5/320.)).rgb;
float weight=1.;if(uv.x>.95)weight=1.-(uv.x-.95)*2.;else if(uv.x<.05)weight=1.-(.05-uv.x)*2.;
if(uv.y>.95)weight=1.-(uv.y-.95)*2.;else if(uv.y<.05)weight=1.-(.05-uv.y)*2.;
vec3 tap=texture(source,uv).rgb*2.5;result=vec4(tap*.125+(old*(weight/12.2)*.95+tap*.05),1);}`,
  composite: `#version 300 es
precision highp float; in vec2 uv; uniform sampler2D source; uniform sampler2D previous; uniform bool enableGlow; out vec4 result;
void main(){vec3 color=texture(source,uv).rgb;if(enableGlow){vec3 g=max(texture(previous,uv).rgb-vec3(.008),vec3(0));
color=max(color+g*.6,clamp(color+g-color*g,0.,1.));}result=vec4(color,1);}`,
};

// One WebGL context and scratch target set for the whole grid. No readPixels in
// the frame loop: finished frames travel as transferable GPU-backed ImageBitmaps.
export class GpuGridRenderer {
  constructor(resources, catalog, canvas = null) {
    if (!canvas && typeof OffscreenCanvas === "undefined") throw new Error("OffscreenCanvas is unavailable");
    this.canvas = canvas ?? new OffscreenCanvas(960, 640);
    const gl = this.gl = this.canvas.getContext("webgl2", {
      alpha: false, antialias: false, premultipliedAlpha: false, depth: false, stencil: false,
    });
    if (!gl) throw new Error("WebGL 2 is unavailable; enable browser hardware acceleration");
    this.lost = false;
    this.particleMode = false;
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    this.deviceInfo = gl.getParameter(info?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER);
    this.canvas.addEventListener("webglcontextlost", event => { event.preventDefault(); this.lost = true; });
    this.sceneBuilder = new GpuScene(resources, catalog);
    this.histories = new Map(); this.textures = new Map();
    this.programs = []; this.targets = new Set();
    gl.disable(gl.DITHER); gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE);
    try {
      this.quads = this.program(GPU_SHADERS.quadVertex, GPU_SHADERS.quadFragment, ["image", "textured"]);
      this.horizontal = this.program(GPU_SHADERS.screenVertex, GPU_SHADERS.horizontal, ["source"]);
      this.historyPass = this.program(GPU_SHADERS.screenVertex, GPU_SHADERS.history, ["source", "previous"]);
      this.composite = this.program(GPU_SHADERS.screenVertex, GPU_SHADERS.composite, ["source", "previous", "enableGlow"]);
      this.quadVAO = gl.createVertexArray(); this.screenVAO = gl.createVertexArray();
      this.buffer = gl.createBuffer(); gl.bindVertexArray(this.quadVAO); gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
      for (let i=0;i<4;i++) { gl.enableVertexAttribArray(i); gl.vertexAttribPointer(i,4,gl.FLOAT,false,64,i*16); gl.vertexAttribDivisor(i,1); }
      this.white = this.texture(1,1,new Uint8Array([255,255,255,255]),false);
      this.scene = this.target(); this.source = this.target(); this.blur = this.target(); this.next = this.target();
      for (const image of Object.values(resources.assets)) {
        const texture = this.texture(image.width, image.height, image.rgba, image === this.sceneBuilder.glowTexture);
        this.textures.set(image, texture);
      }
    } catch (error) { this.dispose(); throw error; }
  }
  program(vertex, fragment, names, varyings = null) {
    const gl=this.gl, shaders=[];
    const program=gl.createProgram();
    try {
      for (const [type,text] of [[gl.VERTEX_SHADER,vertex],[gl.FRAGMENT_SHADER,fragment]]) {
        const shader=gl.createShader(type); shaders.push(shader); gl.shaderSource(shader,text); gl.compileShader(shader);
        if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
        gl.attachShader(program,shader);
      }
      if (varyings) gl.transformFeedbackVaryings(program, varyings, gl.INTERLEAVED_ATTRIBS);
      gl.linkProgram(program);
      if(!gl.getProgramParameter(program,gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
      const result={program, uniforms:Object.fromEntries(names.map(name=>[name,gl.getUniformLocation(program,name)]))};
      this.programs.push(program); return result;
    } catch(error) { gl.deleteProgram(program); throw error; }
    finally { for(const shader of shaders) gl.deleteShader(shader); }
  }
  texture(width, height, data=null, linear=true) {
    const gl=this.gl, texture=gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D,texture);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA8,width,height,0,gl.RGBA,gl.UNSIGNED_BYTE,data);
    for(const p of [gl.TEXTURE_MIN_FILTER,gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D,p,linear?gl.LINEAR:gl.NEAREST);
    for(const p of [gl.TEXTURE_WRAP_S,gl.TEXTURE_WRAP_T]) gl.texParameteri(gl.TEXTURE_2D,p,gl.CLAMP_TO_EDGE);
    return texture;
  }
  target() {
    const gl=this.gl, texture=this.texture(480,320), framebuffer=gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER,framebuffer); gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,texture,0);
    const target={texture,framebuffer}; this.targets.add(target);
    if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE) throw new Error("GPU framebuffer allocation failed");
    this.bind(target,true); return target;
  }
  bind(target,clear=false,background=0) {
    const gl=this.gl; gl.bindFramebuffer(gl.FRAMEBUFFER,target?.framebuffer??null);
    gl.viewport(0,0,target?480:this.canvas.width,target?320:this.canvas.height);
    if(clear){gl.clearColor(((background>>>16)&255)/255,((background>>>8)&255)/255,(background&255)/255,1);gl.clear(gl.COLOR_BUFFER_BIT);}
  }
  sample(program,name,target,unit) {
    const gl=this.gl;gl.activeTexture(gl.TEXTURE0+unit);gl.bindTexture(gl.TEXTURE_2D,target.texture??target);gl.uniform1i(program.uniforms[name],unit);
  }
  pass(program,target,source,previous=null) {
    const gl=this.gl;this.bind(target);gl.disable(gl.BLEND);gl.bindVertexArray(this.screenVAO);gl.useProgram(program.program);
    this.sample(program,"source",source,0);if(previous)this.sample(program,"previous",previous,1);
    gl.drawArrays(gl.TRIANGLE_STRIP,0,4);
  }
  drawBatches(list,target,background=0,clear=true) {
    const gl=this.gl,p=this.quads;this.bind(target,clear,background);gl.useProgram(p.program);gl.bindVertexArray(this.quadVAO);gl.bindBuffer(gl.ARRAY_BUFFER,this.buffer);
    gl.enable(gl.BLEND);
    for(let i=0;i<list.used;i++) {
      const batch=list[i]; if(!batch.count)continue;
      gl.blendFunc(gl.SRC_ALPHA,batch.additive?gl.ONE:gl.ONE_MINUS_SRC_ALPHA);
      gl.uniform1i(p.uniforms.textured,Number(!!batch.texture));
      this.sample(p,"image",batch.texture?this.textures.get(batch.texture):this.white,0);
      gl.bufferData(gl.ARRAY_BUFFER,batch.data.subarray(0,batch.count*16),gl.STREAM_DRAW);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP,0,4,batch.count);
    }
    gl.disable(gl.BLEND);
  }
  begin(width,height) {
    if(this.lost)throw new Error("GPU context lost");
    if(this.canvas.width!==width)this.canvas.width=width;
    if(this.canvas.height!==height)this.canvas.height=height;
    this.bind(null,true);
  }
  configureParticles(entries, enabled) {
    if (enabled && !this.particles) {
      if (this.particleFailure) throw new Error(this.particleFailure);
      try { this.particles = new GpuParticles(this, GPU_SHADERS.quadFragment); }
      catch (error) { this.particleFailure = error.message; throw error; }
    }
    this.particles?.configure(entries, enabled);
    this.particleMode = enabled;
  }
  render(sim,key,options,advance) {
    const old=this.histories.get(key);
    if(!old)throw new Error("Missing GPU tile history");
    const scene=this.sceneBuilder;scene.build(sim,options,advance,!this.particleMode);
    // Preserve spawn-order alpha blending: GPU particles first, then original
    // guide/sprite geometry. Glow/history still advance on EVERY physics step.
    if (this.particleMode) {
      this.bind(this.scene,true,options.background??0);
      this.particles.draw(sim,key,options,false);
      this.drawBatches(scene.scene,this.scene,0,false);
    } else this.drawBatches(scene.scene,this.scene,options.background??0);
    if(advance) {
      if (this.particleMode) {
        this.bind(this.source,true);
        this.particles.draw(sim,key,options,true);
        this.drawBatches(scene.glow,this.source,0,false);
      } else this.drawBatches(scene.glow,this.source);
      this.pass(this.horizontal,this.blur,old);
      this.pass(this.historyPass,this.next,this.source,this.blur);
      this.histories.set(key,this.next);this.next=old;
    }
  }
  compose(key,tile,glow) {
    const gl=this.gl,p=this.composite;this.bind(null);gl.bindVertexArray(this.screenVAO);gl.useProgram(p.program);
    gl.viewport(tile.x,this.canvas.height-tile.y-tile.imageHeight,tile.width,tile.imageHeight);
    this.sample(p,"source",this.scene,0);this.sample(p,"previous",this.histories.get(key),1);
    // Nearest presentation matches pixelated software previews. Restore linear
    // sampling before these targets are used in the next native-resolution pass.
    for(const target of [this.scene,this.histories.get(key)]) {
      gl.bindTexture(gl.TEXTURE_2D,target.texture);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
    }
    this.sample(p,"source",this.scene,0);this.sample(p,"previous",this.histories.get(key),1);
    gl.uniform1i(p.uniforms.enableGlow,Number(glow));gl.drawArrays(gl.TRIANGLE_STRIP,0,4);
    for(const target of [this.scene,this.histories.get(key)]) {
      gl.bindTexture(gl.TEXTURE_2D,target.texture);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
    }
  }
  finish(){return this.canvas.transferToImageBitmap();}
  setHistory(key,history) {
    const gl=this.gl,target=this.histories.get(key)??this.target();
    const data=new Uint8Array(480*320*4);
    for(let y=0;y<320;y++)for(let x=0;x<480;x++) {
      const src=(y*480+x)*3,dst=((319-y)*480+x)*4;
      for(let c=0;c<3;c++)data[dst+c]=Math.round(history[src+c]*255);data[dst+3]=255;
    }
    gl.bindTexture(gl.TEXTURE_2D,target.texture);gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,480,320,gl.RGBA,gl.UNSIGNED_BYTE,data);
    this.histories.set(key,target);
  }
  readHistory(key,history) {
    if(this.lost){history.fill(0);return;}
    const gl=this.gl,data=new Uint8Array(480*320*4);this.bind(this.histories.get(key));
    // Only on an explicit renderer switch, never in steady-state playback.
    gl.readPixels(0,0,480,320,gl.RGBA,gl.UNSIGNED_BYTE,data);
    for(let y=0;y<320;y++)for(let x=0;x<480;x++)for(let c=0;c<3;c++)
      history[(y*480+x)*3+c]=data[((319-y)*480+x)*4+c]/255;
  }
  retain(keys) {
    const wanted=new Set(keys);
    for(const [key,target] of this.histories)if(!wanted.has(key)) {
      this.gl.deleteTexture(target.texture);this.gl.deleteFramebuffer(target.framebuffer);this.targets.delete(target);this.histories.delete(key);
    }
  }
  dispose() {
    const gl=this.gl;
    this.particles?.dispose();
    for(const target of this.targets??[]) {gl.deleteTexture(target.texture);gl.deleteFramebuffer(target.framebuffer);}
    for(const texture of this.textures?.values()??[])gl.deleteTexture(texture);
    for(const program of this.programs??[])gl.deleteProgram(program);
    if(this.white)gl.deleteTexture(this.white);
    if(this.buffer)gl.deleteBuffer(this.buffer);if(this.quadVAO)gl.deleteVertexArray(this.quadVAO);if(this.screenVAO)gl.deleteVertexArray(this.screenVAO);
    this.targets?.clear();this.histories?.clear();
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}
