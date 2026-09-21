// Real GLES transform-feedback bindings, no browser/mock. Pin Mesa software:
// the local SVGA3D virtual device returned stale feedback between uploads unless
// every frame was read back, making it unsuitable for these numerical tests.
import koffi from "koffi";
import { createNativeGLES } from "../../build_scripts/native-gles.mjs";
export function nativePortalGL() {
  const gpu = createNativeGLES({ softwareOnly: true }),
    canvas = gpu.createCanvas(1, 1),
    gl = canvas.getContext("webgl2"),
    lib = koffi.load("libGLESv2.so.2");
  Object.assign(gl, {
    NO_ERROR: 0,
    ARRAY_BUFFER: 0x8892,
    DYNAMIC_COPY: 0x88ea,
    COPY_READ_BUFFER: 0x8f36,
    COPY_WRITE_BUFFER: 0x8f37,
    TRANSFORM_FEEDBACK: 0x8e22,
    TRANSFORM_FEEDBACK_BUFFER: 0x8c8e,
    INTERLEAVED_ATTRIBS: 0x8c8c,
    RASTERIZER_DISCARD: 0x8c89,
    POINTS: 0,
    TRIANGLE_STRIP: 5,
  });
  const signatures = {
    bindBuffer: "void glBindBuffer(uint target,uint buffer)",
    bufferData:
      "void glBufferData(uint target,int64 size,const void *data,uint usage)",
    copyBufferSubData:
      "void glCopyBufferSubData(uint read,uint write,int64 from,int64 to,int64 size)",
    bindVertexArray: "void glBindVertexArray(uint array)",
    enableVertexAttribArray: "void glEnableVertexAttribArray(uint index)",
    vertexAttribDivisor: "void glVertexAttribDivisor(uint index,uint divisor)",
    vertexAttribPointer:
      "void glVertexAttribPointer(uint index,int size,uint type,uint8 normalized,int stride,int64 offset)",
    bindTransformFeedback: "void glBindTransformFeedback(uint target,uint id)",
    bindBufferRange:
      "void glBindBufferRange(uint target,uint index,uint buffer,int64 offset,int64 size)",
    bindBufferBase: "void glBindBufferBase(uint target,uint index,uint buffer)",
    beginTransformFeedback: "void glBeginTransformFeedback(uint primitive)",
    endTransformFeedback: "void glEndTransformFeedback()",
    enable: "void glEnable(uint cap)",
    uniform4f: "void glUniform4f(int loc,float x,float y,float z,float w)",
    transformFeedbackVaryings:
      "void glTransformFeedbackVaryings(uint program,int count,const char **varyings,uint mode)",
  };
  for (const [name, sig] of Object.entries(signatures))
    gl[name] = lib.func(sig);
  const pointer = gl.vertexAttribPointer;
  gl.vertexAttribPointer = (a, b, c, d, e, f) =>
    pointer(a, b, c, Number(d), e, f);
  const bindBase = gl.bindBufferBase;
  gl.bindBufferBase = (a, b, c) => bindBase(a, b, c ?? 0);
  const bindFeedback = gl.bindTransformFeedback;
  gl.bindTransformFeedback = (a, b) => bindFeedback(a, b ?? 0);
  for (const [name, plural] of [
    ["Buffer", "Buffers"],
    ["VertexArray", "VertexArrays"],
    ["TransformFeedback", "TransformFeedbacks"],
  ]) {
    const gen = lib.func(`void glGen${plural}(int n,_Out_ uint *ids)`),
      del = lib.func(`void glDelete${plural}(int n,const uint *ids)`);
    gl[`create${name}`] = () => {
      const ids = [0];
      gen(1, ids);
      return ids[0];
    };
    gl[`delete${name}`] = (id) => del(1, [id]);
  }
  const data = gl.bufferData;
  gl.bufferData = (target, size, usage) => data(target, size, null, usage);
  const sub = lib.func(
    "void glBufferSubData(uint target,int64 offset,int64 size,const void *data)",
  );
  gl.bufferSubData = (target, offset, bytes) =>
    sub(target, offset, bytes.byteLength, bytes);
  const varyings = gl.transformFeedbackVaryings;
  gl.transformFeedbackVaryings = (p, v, m) => varyings(p, v.length, v, m);
  const map = lib.func(
      "void *glMapBufferRange(uint target,int64 offset,int64 length,uint access)",
    ),
    unmap = lib.func("uint8 glUnmapBuffer(uint target)");
  gl.getBufferSubData = (target, offset, out) => {
    const ptr = map(target, offset, out.byteLength, 1);
    if (!ptr) throw new Error("GLES buffer read failed");
    new Uint8Array(out.buffer, out.byteOffset, out.byteLength).set(
      koffi.decode(ptr, "uint8", out.byteLength),
    );
    unmap(target);
  };
  const programs = [];
  function program(vertex, fragment, names, varyings) {
    const p = gl.createProgram();
    programs.push(p);
    for (const [type, source] of [
      [gl.VERTEX_SHADER, vertex],
      [gl.FRAGMENT_SHADER, fragment],
    ]) {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
        throw new Error(gl.getShaderInfoLog(shader));
      gl.attachShader(p, shader);
      gl.deleteShader(shader);
    }
    if (varyings)
      gl.transformFeedbackVaryings(p, varyings, gl.INTERLEAVED_ATTRIBS);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS))
      throw new Error(gl.getProgramInfoLog(p));
    return {
      program: p,
      uniforms: Object.fromEntries(
        names.map((n) => [n, gl.getUniformLocation(p, n)]),
      ),
    };
  }
  return {
    gl,
    program,
    renderer: gpu.info,
    dispose() {
      for (const p of programs) gl.deleteProgram(p);
      gpu.dispose();
    },
  };
}
