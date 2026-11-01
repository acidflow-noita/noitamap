// Exercise Dust's complete WebGL renderer through real GLES, without a browser.
import koffi from 'koffi';
import { nativePortalGL } from './native-portal-gl.mjs';

export function nativeSunGL() {
  const native = nativePortalGL(), gl = native.gl, lib = koffi.load('libGLESv2.so.2');
  Object.assign(gl, { LINEAR: 0x2601, DITHER: 0x0bd0, CULL_FACE: 0x0b44, STREAM_DRAW: 0x88e0,
    FRAMEBUFFER: 0x8d40, COLOR_ATTACHMENT0: 0x8ce0, FRAMEBUFFER_COMPLETE: 0x8cd5,
    MAX_VIEWPORT_DIMS: 0x0d3a, RENDERER: 0x1f01, ZERO: 0, ONE: 1, SRC_ALPHA: 0x0302, ONE_MINUS_SRC_ALPHA: 0x0303 });
  const signatures = {
    bindFramebuffer: 'void glBindFramebuffer(uint target,uint framebuffer)',
    framebufferTexture2D: 'void glFramebufferTexture2D(uint target,uint attachment,uint texTarget,uint texture,int level)',
    checkFramebufferStatus: 'uint glCheckFramebufferStatus(uint target)',
    uniform3f: 'void glUniform3f(int loc,float x,float y,float z)',
    drawArrays: 'void glDrawArrays(uint mode,int first,int count)',
    drawArraysInstanced: 'void glDrawArraysInstanced(uint mode,int first,int count,int instances)',
    blendFuncSeparate: 'void glBlendFuncSeparate(uint sr,uint dr,uint sa,uint da)',
    readPixels: 'void glReadPixels(int x,int y,int w,int h,uint format,uint type,void *data)',
    finish: 'void glFinish()',
  };
  for (const [name, signature] of Object.entries(signatures)) gl[name] = lib.func(signature);
  const bind = gl.bindFramebuffer;
  gl.bindFramebuffer = (target, buffer) => bind(target, buffer ?? 0);
  const gen = lib.func('void glGenFramebuffers(int n,_Out_ uint *ids)'), del = lib.func('void glDeleteFramebuffers(int n,const uint *ids)');
  gl.createFramebuffer = () => { const ids = [0]; gen(1, ids); return ids[0]; };
  gl.deleteFramebuffer = id => del(1, [id]);
  const uniform = lib.func('void glUniform3fv(int loc,int count,const float *values)');
  gl.uniform3fv = (loc, values) => uniform(loc, 1, values);
  const buffer = lib.func('void glBufferData(uint target,int64 size,const void *data,uint usage)');
  gl.bufferData = (target, data, usage) => typeof data === 'number' ? buffer(target, data, null, usage) : buffer(target, data.byteLength, data, usage);
  const get = gl.getParameter;
  gl.getParameter = name => name === gl.MAX_VIEWPORT_DIMS ? [get(gl.MAX_TEXTURE_SIZE), get(gl.MAX_TEXTURE_SIZE)] :
    name === gl.RENDERER ? native.renderer.renderer : get(name);
  gl.getExtension = () => null;
  class Canvas {
    constructor(width, height) { this.width = width; this.height = height; }
    addEventListener() {}
    getContext() { return gl; }
  }
  return { ...native, Canvas, read(width, height) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const pixels = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    return pixels;
  } };
}
