// Real surfaceless EGL / OpenGL ES 3, not a mock and not a browser.
// Exposes the WebGL2 calls used by Telescope; shader compilation, texture
// uploads and draw calls execute in Mesa. Readback makes the canvas drawable
// by the native 2D canvas used in the integration harness.
import koffi from "koffi";
import { createCanvas, ImageData } from "@napi-rs/canvas";

const C = {
  BLEND: 0x0be2,
  CLAMP_TO_EDGE: 0x812f,
  COLOR_BUFFER_BIT: 0x4000,
  COMPILE_STATUS: 0x8b81,
  DEPTH_TEST: 0x0b71,
  FLOAT: 0x1406,
  FRAGMENT_SHADER: 0x8b30,
  INT: 0x1404,
  LINK_STATUS: 0x8b82,
  MAX_TEXTURE_SIZE: 0x0d33,
  NEAREST: 0x2600,
  R16UI: 0x8234,
  R32F: 0x822e,
  R8UI: 0x8232,
  RED: 0x1903,
  RED_INTEGER: 0x8d94,
  RG16UI: 0x823a,
  RGBA: 0x1908,
  RGBA16UI: 0x8d76,
  RGBA32F: 0x8814,
  RGBA32I: 0x8d82,
  RGBA8: 0x8058,
  RGBA8UI: 0x8d7c,
  RGBA_INTEGER: 0x8d99,
  RG_INTEGER: 0x8228,
  TEXTURE0: 0x84c0,
  TEXTURE_2D: 0x0de1,
  TEXTURE_MAG_FILTER: 0x2800,
  TEXTURE_MIN_FILTER: 0x2801,
  TEXTURE_WRAP_S: 0x2802,
  TEXTURE_WRAP_T: 0x2803,
  TRIANGLES: 4,
  UNPACK_ALIGNMENT: 0x0cf5,
  UNSIGNED_BYTE: 0x1401,
  UNSIGNED_SHORT: 0x1403,
  VERTEX_SHADER: 0x8b31,
};

export function createNativeGLES() {
  const egl = koffi.load("libEGL.so.1");
  const lib = koffi.load("libGLESv2.so.2");
  const platform = egl.func(
    "void *eglGetPlatformDisplay(uint platform, void *native, const int *attributes)",
  );
  const initialize = egl.func(
    "uint eglInitialize(void *display, _Out_ int *major, _Out_ int *minor)",
  );
  const choose = egl.func(
    "uint eglChooseConfig(void *display, const int *attributes, _Out_ void **configs, int size, _Out_ int *count)",
  );
  const bind = egl.func("uint eglBindAPI(uint api)");
  const makeSurface = egl.func(
    "void *eglCreatePbufferSurface(void *display, void *config, const int *attributes)",
  );
  const makeContext = egl.func(
    "void *eglCreateContext(void *display, void *config, void *shared, const int *attributes)",
  );
  const makeCurrent = egl.func(
    "uint eglMakeCurrent(void *display, void *draw, void *read, void *context)",
  );
  const destroyContext = egl.func(
    "uint eglDestroyContext(void *display, void *context)",
  );
  const destroySurface = egl.func(
    "uint eglDestroySurface(void *display, void *surface)",
  );
  const terminate = egl.func("uint eglTerminate(void *display)");
  const display = platform(0x31dd, null, null); // EGL_PLATFORM_SURFACELESS_MESA
  if (!initialize(display, [0], [0]))
    throw new Error("Surfaceless EGL initialization failed");
  const config = [null],
    count = [0];
  if (
    !choose(
      display,
      [
        0x3033, 1, 0x3040, 0x40, 0x3024, 8, 0x3023, 8, 0x3022, 8, 0x3021, 8,
        0x3038,
      ],
      config,
      1,
      count,
    ) ||
    !count[0]
  ) {
    throw new Error("No EGL ES3 pbuffer configuration");
  }
  bind(0x30a0); // EGL_OPENGL_ES_API
  const surface = makeSurface(
    display,
    config[0],
    [0x3057, 2048, 0x3056, 2048, 0x3038],
  );
  const context = makeContext(display, config[0], null, [0x3098, 3, 0x3038]);
  if (!surface || !context || !makeCurrent(display, surface, surface, context))
    throw new Error("EGL ES3 context creation failed");

  const gl = { ...C };
  const getInt = lib.func("void glGetIntegerv(uint name, _Out_ int *value)");
  const getString = lib.func("const char *glGetString(uint name)");
  const getError = lib.func("uint glGetError()");
  const draw = lib.func("void glDrawArrays(uint mode, int first, int count)");
  const read = lib.func(
    "void glReadPixels(int x, int y, int w, int h, uint format, uint type, void *data)",
  );
  const shaderSource = lib.func(
    "void glShaderSource(uint shader, int count, const char **source, const int *lengths)",
  );
  const genTextures = lib.func(
    "void glGenTextures(int count, _Out_ uint *textures)",
  );
  const deleteTextures = lib.func(
    "void glDeleteTextures(int count, const uint *textures)",
  );
  const shaderParam = lib.func(
    "void glGetShaderiv(uint shader, uint name, _Out_ int *value)",
  );
  const programParam = lib.func(
    "void glGetProgramiv(uint program, uint name, _Out_ int *value)",
  );
  const shaderLog = lib.func(
    "void glGetShaderInfoLog(uint shader, int capacity, int *length, void *log)",
  );
  const programLog = lib.func(
    "void glGetProgramInfoLog(uint program, int capacity, int *length, void *log)",
  );
  const nativePut = createCanvas(1, 1).getContext("2d").constructor.prototype
    .putImageData;
  const renderer = getString(0x1f01);
  let canvas = null;
  let targetContext = null;
  let draws = 0;
  const check = (label) => {
    const error = getError();
    if (error) throw new Error(`${label}: GLES error 0x${error.toString(16)}`);
  };

  const signatures = {
    activeTexture: "void glActiveTexture(uint texture)",
    attachShader: "void glAttachShader(uint program, uint shader)",
    bindTexture: "void glBindTexture(uint target, uint texture)",
    clear: "void glClear(uint mask)",
    clearColor: "void glClearColor(float r, float g, float b, float a)",
    compileShader: "void glCompileShader(uint shader)",
    createProgram: "uint glCreateProgram()",
    createShader: "uint glCreateShader(uint type)",
    deleteProgram: "void glDeleteProgram(uint program)",
    deleteShader: "void glDeleteShader(uint shader)",
    disable: "void glDisable(uint capability)",
    getUniformLocation:
      "int glGetUniformLocation(uint program, const char *name)",
    linkProgram: "void glLinkProgram(uint program)",
    pixelStorei: "void glPixelStorei(uint name, int value)",
    texImage2D:
      "void glTexImage2D(uint target, int level, int format, int w, int h, int border, uint sourceFormat, uint type, const void *data)",
    texParameteri: "void glTexParameteri(uint target, uint name, int value)",
    texSubImage2D:
      "void glTexSubImage2D(uint target, int level, int x, int y, int w, int h, uint format, uint type, const void *data)",
    uniform1f: "void glUniform1f(int location, float value)",
    uniform1i: "void glUniform1i(int location, int value)",
    uniform2f: "void glUniform2f(int location, float x, float y)",
    uniform2i: "void glUniform2i(int location, int x, int y)",
    useProgram: "void glUseProgram(uint program)",
    viewport: "void glViewport(int x, int y, int width, int height)",
  };
  for (const [name, signature] of Object.entries(signatures)) {
    const native = lib.func(signature);
    gl[name] = (...args) => {
      if (
        name.startsWith("uniform") &&
        args.slice(1).some((v) => !Number.isFinite(v))
      )
        throw new Error(`${name}: non-finite coordinate/uniform ${args}`);
      const result = native(...args);
      check(name);
      return result;
    };
  }
  gl.getError = getError;
  gl.getParameter = (name) => {
    const value = [0];
    getInt(name, value);
    return value[0];
  };
  gl.createTexture = () => {
    const value = [0];
    genTextures(1, value);
    return value[0];
  };
  gl.deleteTexture = (texture) => deleteTextures(1, [texture]);
  gl.shaderSource = (shader, source) => shaderSource(shader, 1, [source], null);
  gl.getShaderParameter = (shader, name) => {
    const value = [0];
    shaderParam(shader, name, value);
    return value[0];
  };
  gl.getProgramParameter = (program, name) => {
    const value = [0];
    programParam(program, name, value);
    return value[0];
  };
  gl.getShaderInfoLog = (shader) => {
    const text = Buffer.alloc(65536);
    shaderLog(shader, text.length, null, text);
    return text.toString().split("\0")[0];
  };
  gl.getProgramInfoLog = (program) => {
    const text = Buffer.alloc(65536);
    programLog(program, text.length, null, text);
    return text.toString().split("\0")[0];
  };
  gl.drawArrays = (...args) => {
    draw(...args);
    check("drawArrays");
    draws++;
    const { width, height } = canvas;
    const data = new Uint8Array(width * height * 4);
    read(0, 0, width, height, C.RGBA, C.UNSIGNED_BYTE, data);
    check("readPixels");
    // GL is bottom-up/premultiplied, ImageData is top-down/straight alpha.
    const pixels = new Uint8ClampedArray(data.length);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const from = ((height - y - 1) * width + x) * 4,
          to = (y * width + x) * 4;
        const alpha = data[from + 3];
        pixels[to + 3] = alpha;
        for (let c = 0; c < 3; c++)
          pixels[to + c] = alpha
            ? Math.round((data[from + c] * 255) / alpha)
            : 0;
      }
    nativePut.call(targetContext, new ImageData(pixels, width, height), 0, 0);
  };

  return {
    renderer,
    get draws() {
      return draws;
    },
    createCanvas(width = 1, height = 1) {
      const element = createCanvas(width, height);
      const nativeContext = element.getContext.bind(element);
      const events = new EventTarget();
      element.addEventListener = events.addEventListener.bind(events);
      element.removeEventListener = events.removeEventListener.bind(events);
      element.getContext = (type) => {
        if (type !== "webgl2") return nativeContext(type);
        canvas = element;
        targetContext = nativeContext("2d");
        return gl;
      };
      return element;
    },
    dispose() {
      makeCurrent(display, null, null, null);
      destroyContext(display, context);
      destroySurface(display, surface);
      terminate(display);
    },
  };
}
