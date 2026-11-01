import { GpuScene } from "./gpu-scene.mjs";
import { GpuParticles } from "./gpu-particles.mjs";
import { GLOW_DITHER_GLSL, GLOW_DITHER_SIZE, GLOW_DITHER_TILE } from "./glow-dither.mjs";
import { resolveLighting, NOITA_LIGHTING_GLSL } from "./noita-lighting.mjs";

export const GPU_SHADERS = {
  quadVertex: `#version 300 es
layout(location=0) in vec4 corners01; layout(location=1) in vec4 corners23;
layout(location=2) in vec4 color; layout(location=3) in vec4 region;
uniform vec2 viewSize;
out vec4 tint; out vec2 uv;
void main(){vec2 p; vec2 t;
if(gl_VertexID==0){p=corners01.xy;t=vec2(0,0);}else if(gl_VertexID==1){p=corners01.zw;t=vec2(1,0);}
else if(gl_VertexID==2){p=corners23.zw;t=vec2(0,1);}else{p=corners23.xy;t=vec2(1,1);}
p=p/viewSize*2.-1.;p.y=-p.y;gl_Position=vec4(p,0,1);uv=mix(region.xy,region.zw,t);tint=color;}`,
  quadFragment: `#version 300 es
precision highp float; in vec4 tint; in vec2 uv; uniform sampler2D image;
uniform bool textured; uniform bool monochrome; out vec4 result;
void main(){result=tint;if(textured)result*=texture(image,uv);
if(monochrome)result.rgb=vec3(dot(result.rgb,vec3(.2126,.7152,.0722)));}`,
  screenVertex: `#version 300 es
out vec2 uv; void main(){vec2 p=vec2((gl_VertexID&1)*2-1,(gl_VertexID>>1)*2-1);uv=p*.5+.5;gl_Position=vec4(p,0,1);}`,
  horizontal: `#version 300 es
precision highp float; in vec2 uv; uniform sampler2D source; uniform vec2 viewSize; out vec4 result;
void main(){vec3 sum=vec3(0);for(int x=-5;x<=5;x++)sum+=texture(source,uv+vec2(float(x)*1.5/viewSize.x,0)).rgb;result=vec4(sum*.1,1);}`,
  history: `#version 300 es
precision highp float; in vec2 uv; uniform sampler2D source; uniform sampler2D cells; uniform sampler2D previous; uniform vec2 viewSize; out vec4 result;
void main(){vec3 old=vec3(0);for(int y=-5;y<=5;y++)old+=texture(previous,uv+vec2(0,float(y)*1.5/viewSize.y)).rgb;
float weight=1.;if(uv.x>.95)weight=1.-(uv.x-.95)*2.;else if(uv.x<.05)weight=1.-(.05-uv.x)*2.;
if(uv.y>.95)weight=1.-(uv.y-.95)*2.;else if(uv.y<.05)weight=1.-(.05-uv.y)*2.;
vec3 tap=texture(cells,uv).rgb*4.+texture(source,uv).rgb*2.5;result=vec4(tap*.125+(old*(weight/12.2)*.95+tap*.05),1);}`,
  composite: `#version 300 es
precision highp float; precision highp int;
in vec2 uv; uniform sampler2D source; uniform sampler2D previous; uniform bool enableGlow; uniform bool monochrome;
uniform bool smoothGlow; uniform bool transparent; uniform bool finalizeAlpha; uniform vec3 backgroundColor; uniform vec2 ditherOrigin; uniform float ditherHeight;
uniform bool scenePass; uniform bool lightingEnabled; uniform vec3 worldLight; uniform vec3 skyLight; uniform float ambientLight; uniform vec3 glowModulation;
uniform vec4 cropWindow; uniform vec2 outputTexelSize;
out vec4 result;
${GLOW_DITHER_GLSL}
${NOITA_LIGHTING_GLSL}
void main(){vec2 localUV=(gl_FragCoord.xy-ditherOrigin)*outputTexelSize;vec2 sampleUV=cropWindow.xy+localUV*cropWindow.zw;vec4 scene=texture(source,sampleUV);vec3 base=scene.rgb;vec3 color=base;if(scenePass){vec3 g=enableGlow?max(texture(previous,sampleUV).rgb-vec3(.008),vec3(0)):vec3(0);
if(monochrome)g=vec3(dot(g,vec3(.2126,.7152,.0722)));
// Light only the foreground. Background composition happens once, before the
// late emissive layer; its presentation pass already contains the final color.
color=noitaComposite(scene,g,backgroundColor,lightingEnabled,worldLight,skyLight,ambientLight,glowModulation);
if(smoothGlow&&enableGlow&&any(lessThan(backgroundColor,vec3(1)))&&scene.a<.5/255.&&all(lessThan(abs(base),vec3(.5/255.)))){
float amount=min(1.,max(g.r,max(g.g,g.b))*255.);
if(amount>0.){uvec2 pixel=uvec2(gl_FragCoord.xy-ditherOrigin);pixel.y=uint(ditherHeight)-1u-pixel.y;color+=vec3(glowDither(pixel)*amount/255.);}
}}
float alpha=transparent?scene.a:1.;
if(transparent&&finalizeAlpha){color=floor(clamp(color,0.,1.)*255.+.5)/255.;vec3 matte=floor(backgroundColor*255.+.5)/255.;for(int c=0;c<3;c++){
if(color[c]>matte[c])alpha=max(alpha,(color[c]-matte[c])/(1.-matte[c]));
else if(color[c]<matte[c])alpha=max(alpha,(matte[c]-color[c])/matte[c]);
}alpha=clamp(ceil(alpha*255.-.000001)/255.,0.,1.);color=alpha>0.?clamp((color-matte*(1.-alpha))/alpha,0.,1.):vec3(0);if(monochrome)color=vec3(max(color.r,max(color.g,color.b)));}
result=vec4(transparent&&finalizeAlpha?color*alpha:color,alpha);}`,
};

// One WebGL context and scratch target set for the whole grid. No readPixels in
// the frame loop: finished frames travel as transferable GPU-backed ImageBitmaps.
export class GpuGridRenderer {
  constructor(resources, catalog) {
    if (typeof OffscreenCanvas === "undefined") throw new Error("OffscreenCanvas is unavailable");
    this.canvas = new OffscreenCanvas(960, 640);
    const gl = this.gl = this.canvas.getContext("webgl2", {
      alpha: true, antialias: false, premultipliedAlpha: true, depth: false, stencil: false,
    });
    if (!gl) throw new Error("WebGL 2 is unavailable; enable browser hardware acceleration");
    this.lost = false;
    this.particleMode = false;
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    this.deviceInfo = gl.getParameter(info?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER);
    this.canvas.addEventListener("webglcontextlost", event => { event.preventDefault(); this.lost = true; });
    this.sceneBuilder = new GpuScene(resources, catalog);
    this.lighting = resolveLighting();
    this.width = 480; this.height = 320; this.detail = 1;
    this.maxTextureSize = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), ...gl.getParameter(gl.MAX_VIEWPORT_DIMS));
    this.histories = new Map(); this.textures = new Map();
    this.programs = []; this.targets = new Set();
    gl.disable(gl.DITHER); gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE);
    try {
      this.quads = this.program(GPU_SHADERS.quadVertex, GPU_SHADERS.quadFragment, ["image", "textured", "viewSize", "monochrome"]);
      this.horizontal = this.program(GPU_SHADERS.screenVertex, GPU_SHADERS.horizontal, ["source", "viewSize"]);
      this.historyPass = this.program(GPU_SHADERS.screenVertex, GPU_SHADERS.history, ["source", "cells", "previous", "viewSize"]);
      this.composite = this.program(GPU_SHADERS.screenVertex, GPU_SHADERS.composite, ["source", "previous", "enableGlow", "monochrome", "smoothGlow", "transparent", "finalizeAlpha", "backgroundColor", "ditherOrigin", "ditherHeight", "glowDitherTexture", "cropWindow", "outputTexelSize", "scenePass", "lightingEnabled", "worldLight", "skyLight", "ambientLight", "glowModulation"]);
      this.quadVAO = gl.createVertexArray(); this.screenVAO = gl.createVertexArray();
      this.buffer = gl.createBuffer(); gl.bindVertexArray(this.quadVAO); gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
      for (let i=0;i<4;i++) { gl.enableVertexAttribArray(i); gl.vertexAttribPointer(i,4,gl.FLOAT,false,64,i*16); gl.vertexAttribDivisor(i,1); }
      this.white = this.texture(1,1,new Uint8Array([255,255,255,255]),false);
      this.scene = this.target(); this.source = this.target(); this.cells = this.target(); this.blur = this.target(); this.next = this.target();
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
  getGlowDitherTexture() {
    if (!this.glowDitherTexture) {
      const gl = this.gl, texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      // R32F sampling with NEAREST is WebGL 2 core; no float render target or
      // float-linear extension is required. Upload once and keep it cached.
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, GLOW_DITHER_SIZE, GLOW_DITHER_SIZE, 0, gl.RED, gl.FLOAT, GLOW_DITHER_TILE);
      for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, p, gl.NEAREST);
      for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) gl.texParameteri(gl.TEXTURE_2D, p, gl.CLAMP_TO_EDGE);
      this.glowDitherTexture = texture;
      this.glowDitherBytes = GLOW_DITHER_TILE.byteLength;
    }
    return this.glowDitherTexture;
  }
  target(width=this.width,height=this.height) {
    const gl=this.gl, texture=this.texture(width,height), framebuffer=gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER,framebuffer); gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,texture,0);
    const target={texture,framebuffer,width,height}; this.targets.add(target);
    if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE) throw new Error("GPU framebuffer allocation failed");
    this.bind(target,true); return target;
  }
  resizeTarget(target,width,height) {
    if(target.width===width&&target.height===height)return;
    const gl=this.gl;
    gl.bindTexture(gl.TEXTURE_2D,target.texture);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA8,width,height,0,gl.RGBA,gl.UNSIGNED_BYTE,null);
    target.width=width;target.height=height;
  }
  setDetail(detail=1) {
    if(!Number.isInteger(detail)||detail<1||detail>4)throw new RangeError("Invalid render detail");
    const previousDetail = this.detail;
    this.detail=detail=Math.min(detail,Math.max(1,Math.floor(this.maxTextureSize/Math.max(this.width,this.height))));
    this.resizeTarget(this.scene,this.width*detail,this.height*detail);
    if(this.emissiveTarget && previousDetail !== detail)this.resizeTarget(this.emissiveTarget,this.width*detail,this.height*detail);
    // Glow remains at its original resolution and sampling scale. Raising
    // geometry detail must not change the native blur radius or decay physics.
  }
  setView(width,height,centerX=0,centerY=0,preserveCenteredHistory=false) {
    const scene=this.sceneBuilder;
    const changed=this.width!==width||this.height!==height||(scene.centerX??0)!==centerX||(scene.centerY??0)!==centerY;
    this.width=width;this.height=height;
    this.detail=Math.min(this.detail,Math.max(1,Math.floor(this.maxTextureSize/Math.max(width,height))));
    Object.assign(scene,{width,height,centerX,centerY});
    const histories=preserveCenteredHistory?new Set(this.histories.values()):new Set();
    if(changed)for(const target of this.targets){
      if(histories.has(target))continue;
      const scale=target===this.scene||target===this.emissiveTarget?this.detail:1;
      this.resizeTarget(target,width*scale,height*scale);this.bind(target,true);
    }
    // Resize retained figure histories on the GPU. The world stays at the
    // buffer's center; no particle/history readback is needed during refitting.
    if(changed&&preserveCenteredHistory)for(const [key,old] of this.histories){
      const gl=this.gl,next=this.target(width,height),w=Math.min(old.width,width),h=Math.min(old.height,height);
      const sx=Math.max(0,(old.width-width)/2),sy=Math.max(0,(old.height-height)/2);
      const dx=Math.max(0,(width-old.width)/2),dy=Math.max(0,(height-old.height)/2);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER,old.framebuffer);gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER,next.framebuffer);
      gl.blitFramebuffer(sx,sy,sx+w,sy+h,dx,dy,dx+w,dy+h,gl.COLOR_BUFFER_BIT,gl.NEAREST);
      this.histories.set(key,next);this.targets.delete(old);gl.deleteTexture(old.texture);gl.deleteFramebuffer(old.framebuffer);
    }
  }
  bind(target,clear=false,background=0,alpha=1) {
    const gl=this.gl; gl.bindFramebuffer(gl.FRAMEBUFFER,target?.framebuffer??null);
    gl.viewport(0,0,target?target.width:this.canvas.width,target?target.height:this.canvas.height);
    if(clear){gl.clearColor(((background>>>16)&255)/255,((background>>>8)&255)/255,(background&255)/255,alpha);gl.clear(gl.COLOR_BUFFER_BIT);}
  }
  sample(program,name,target,unit) {
    const gl=this.gl;gl.activeTexture(gl.TEXTURE0+unit);gl.bindTexture(gl.TEXTURE_2D,target.texture??target);gl.uniform1i(program.uniforms[name],unit);
  }
  pass(program,target,source,previous=null,cells=null) {
    const gl=this.gl;this.bind(target);gl.disable(gl.BLEND);gl.bindVertexArray(this.screenVAO);gl.useProgram(program.program);
    this.sample(program,"source",source,0);if(previous)this.sample(program,"previous",previous,1);
    if(cells)this.sample(program,"cells",cells,2);
    if(program.uniforms.viewSize)this.gl.uniform2f(program.uniforms.viewSize,this.width,this.height);
    gl.drawArrays(gl.TRIANGLE_STRIP,0,4);
  }
  drawBatches(list,target,background=0,clear=true,alpha=1) {
    const gl=this.gl,p=this.quads;this.bind(target,clear,background,alpha);gl.useProgram(p.program);gl.bindVertexArray(this.quadVAO);gl.bindBuffer(gl.ARRAY_BUFFER,this.buffer);
    gl.uniform2f(p.uniforms.viewSize,this.width,this.height);
    gl.uniform1i(p.uniforms.monochrome,Number(this.monochrome));
    for(let i=0;i<list.used;i++) {
      const batch=list[i]; if(!batch.count)continue;
      if(batch.replace)gl.disable(gl.BLEND);
      else {
        gl.enable(gl.BLEND);
        gl.blendFuncSeparate(gl.SRC_ALPHA,batch.additive?gl.ONE:gl.ONE_MINUS_SRC_ALPHA,batch.additive?gl.ZERO:gl.ONE,batch.additive?gl.ONE:gl.ONE_MINUS_SRC_ALPHA);
      }
      gl.uniform1i(p.uniforms.textured,Number(!!batch.texture));
      this.sample(p,"image",batch.texture?this.textures.get(batch.texture):this.white,0);
      if (batch.texture) {
        const filter = batch.linear ? gl.LINEAR : gl.NEAREST;
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
      }
      gl.bufferData(gl.ARRAY_BUFFER,batch.data.subarray(0,batch.count*16),gl.STREAM_DRAW);
      this.instanceBufferBytes=batch.count*16*4;
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP,0,4,batch.count);
    }
    gl.disable(gl.BLEND);
  }
  begin(width,height,background=0,transparent=false) {
    if(this.lost)throw new Error("GPU context lost");
    if(this.canvas.width!==width)this.canvas.width=width;
    if(this.canvas.height!==height)this.canvas.height=height;
    this.bind(null,true,transparent?0:background,transparent?0:1);
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
    this.monochrome = !!options.monochrome;
    this.lighting = resolveLighting(options.lighting, this.monochrome);
    this.smoothGlow = !!options.smoothGlow;
    this.background = options.background ?? 0;
    this.transparent = !!options.transparent;
    const old=this.histories.get(key);
    if(!old)throw new Error("Missing GPU tile history");
    const scene=this.sceneBuilder;scene.build(sim,options,advance,!this.particleMode);
    // Preserve spawn-order alpha blending: GPU particles first, then original
    // guide/sprite geometry. Glow/history still advance on EVERY physics step.
    if (this.particleMode) {
      this.bind(this.scene,true,0,0);
      this.particles.draw(sim,key,options,false);
      this.drawBatches(scene.scene,this.scene,0,false);
    } else this.drawBatches(scene.scene,this.scene,0,true,0);
    if(advance) {
      if (this.particleMode) {
        this.bind(this.source,true);
        this.particles.draw(sim,key,options,true);
        this.drawBatches(scene.glow,this.source,0,false);
        this.bind(this.cells,true);
        this.particles.draw(sim,key,options,2);
        this.drawBatches(scene.cells,this.cells,0,false);
      } else {
        this.drawBatches(scene.glow,this.source);
        this.drawBatches(scene.cells,this.cells);
      }
      this.pass(this.horizontal,this.blur,old);
      this.pass(this.historyPass,this.next,this.source,this.blur,this.cells);
      this.histories.set(key,this.next);this.next=old;
    }
  }
  compose(key,tile,glow) {
    const history=this.histories.get(key);
    let source=this.scene;
    let smoothOutput=false;
    if(this.sceneBuilder.emissive.used) {
      // Compose at native resolution first, then draw the late emissive layer.
      // One scratch target is shared by all tiles, allocated only when needed.
      const smooth = this.sceneBuilder.emissive.slice(0, this.sceneBuilder.emissive.used).some(batch => batch.linear);
      smoothOutput=smooth;
      const crop = tile.crop ?? { width: this.width, height: this.height };
      // A smooth native sprite must reach display resolution before the final
      // nearest presentation; otherwise its filtered edge becomes square blocks.
      // The underlying particle scene is still sampled with nearest filtering.
      const detail = smooth ? Math.min(Math.max(this.detail, Math.ceil(tile.width / crop.width), Math.ceil(tile.imageHeight / crop.height)),
        Math.max(1, Math.floor(this.maxTextureSize / Math.max(this.width, this.height)))) : this.detail;
      this.emissiveTarget??=this.target(this.width * detail, this.height * detail);
      // Reuse the largest scratch surface across tiles; mixing smooth and
      // pixel-art sprites must not reallocate it on every tile/frame.
      this.resizeTarget(this.emissiveTarget, Math.max(this.emissiveTarget.width, this.width * detail), Math.max(this.emissiveTarget.height, this.height * detail));
      this.compositeTo(this.emissiveTarget,null,source,history,glow);
      this.drawBatches(this.sceneBuilder.emissive,this.emissiveTarget,0,false);
      source=this.emissiveTarget;
      glow=false;
    }
    this.compositeTo(null,tile,source,history,glow,smoothOutput);
  }
  compositeTo(destination,tile,source,history,glow,smoothOutput=false) {
    const gl=this.gl,p=this.composite;this.bind(destination);gl.bindVertexArray(this.screenVAO);gl.useProgram(p.program);
    if(tile)gl.viewport(tile.x,this.canvas.height-tile.y-tile.imageHeight,tile.width,tile.imageHeight);
    // Preserve smooth emissive edges when the display and scratch sizes differ.
    // Raw particle geometry still uses nearest sampling before that layer.
    for(const target of [source,history]) {
      const filter=target===history&&this.detail>1||target===source&&smoothOutput?gl.LINEAR:gl.NEAREST;
      gl.bindTexture(gl.TEXTURE_2D,target.texture);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,filter);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,filter);
    }
    this.sample(p,"glowDitherTexture",this.smoothGlow&&glow?this.getGlowDitherTexture():this.white,2);
    this.sample(p,"source",source,0);this.sample(p,"previous",history,1);
    const crop=tile?.crop;
    gl.uniform4f(p.uniforms.cropWindow,crop?crop.x/this.width:0,crop?(this.height-crop.y-crop.height)/this.height:0,crop?crop.width/this.width:1,crop?crop.height/this.height:1);
    gl.uniform1i(p.uniforms.enableGlow,Number(glow));gl.uniform1i(p.uniforms.monochrome,Number(this.monochrome));
    gl.uniform1i(p.uniforms.scenePass,Number(source===this.scene));
    gl.uniform1i(p.uniforms.lightingEnabled,Number(this.lighting.enabled));
    gl.uniform3fv(p.uniforms.worldLight,this.lighting.worldLight);
    gl.uniform3fv(p.uniforms.skyLight,this.lighting.skyLight);
    gl.uniform1f(p.uniforms.ambientLight,this.lighting.ambient);
    gl.uniform3fv(p.uniforms.glowModulation,this.lighting.glowModulation);
    gl.uniform1i(p.uniforms.smoothGlow,Number(this.smoothGlow));
    gl.uniform1i(p.uniforms.transparent,Number(this.transparent));
    gl.uniform1i(p.uniforms.finalizeAlpha,Number(!destination));
    gl.uniform3f(p.uniforms.backgroundColor,((this.background>>>16)&255)/255,((this.background>>>8)&255)/255,(this.background&255)/255);
    gl.uniform2f(p.uniforms.ditherOrigin,tile?.x??0,tile?this.canvas.height-tile.y-tile.imageHeight:0);
    gl.uniform1f(p.uniforms.ditherHeight,tile?.imageHeight??destination?.height??this.canvas.height);
    // Derive sampling from tile-local pixel centers. Interpolated UVs can
    // choose opposite sides of a nearest-texel tie at different tile origins.
    gl.uniform2f(p.uniforms.outputTexelSize,1/(tile?.width??destination?.width??this.canvas.width),1/(tile?.imageHeight??destination?.height??this.canvas.height));
    gl.drawArrays(gl.TRIANGLE_STRIP,0,4);
    for(const target of [source,history]) {
      gl.bindTexture(gl.TEXTURE_2D,target.texture);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
    }
  }
  finish(){return this.canvas.transferToImageBitmap();}
  setHistory(key,history) {
    const gl=this.gl,target=this.histories.get(key)??this.target();
    const width=this.width,height=this.height,data=new Uint8Array(width*height*4);
    for(let y=0;y<height;y++)for(let x=0;x<width;x++) {
      const src=(y*width+x)*3,dst=((height-1-y)*width+x)*4;
      for(let c=0;c<3;c++)data[dst+c]=Math.round(history[src+c]*255);data[dst+3]=255;
    }
    gl.bindTexture(gl.TEXTURE_2D,target.texture);gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,width,height,gl.RGBA,gl.UNSIGNED_BYTE,data);
    this.histories.set(key,target);
  }
  readHistory(key,history) {
    if(this.lost){history.fill(0);return;}
    const gl=this.gl,width=this.width,height=this.height,data=new Uint8Array(width*height*4);this.bind(this.histories.get(key));
    // Only on an explicit renderer switch, never in steady-state playback.
    gl.readPixels(0,0,width,height,gl.RGBA,gl.UNSIGNED_BYTE,data);
    for(let y=0;y<height;y++)for(let x=0;x<width;x++)for(let c=0;c<3;c++)
      history[(y*width+x)*3+c]=data[((height-1-y)*width+x)*4+c]/255;
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
    if(this.glowDitherTexture){gl.deleteTexture(this.glowDitherTexture);this.glowDitherTexture=null;this.glowDitherBytes=0;}
    if(this.buffer)gl.deleteBuffer(this.buffer);if(this.quadVAO)gl.deleteVertexArray(this.quadVAO);if(this.screenVAO)gl.deleteVertexArray(this.screenVAO);
    this.targets?.clear();this.histories?.clear();
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}
