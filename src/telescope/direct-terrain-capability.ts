/** Software/unknown adapters retain worker presentation. The diagnostic URL
 * can exercise the exact GPU path on a software test machine explicitly. */
function probe(): any | undefined {
  if (typeof WebGL2RenderingContext === 'undefined' || typeof Worker === 'undefined' || typeof document === 'undefined') return;
  const preference = new URLSearchParams(globalThis.location?.search ?? '').get('terrain-presentation');
  if (preference === 'worker') return;
  const canvas = document.createElement('canvas');
  const attributes: WebGLContextAttributes = { alpha: true, antialias: false, depth: false,
    stencil: false, premultipliedAlpha: true, preserveDrawingBuffer: false,
    powerPreference: 'high-performance' };
  const gl = canvas.getContext('webgl2', attributes) ?? canvas.getContext('webgl2', { ...attributes, powerPreference: 'default' });
  if (!gl) return;
  let renderer = String(gl.getParameter(gl.RENDERER) ?? '');
  if (!/NVIDIA|GeForce|AMD|Radeon|Intel|Apple|Adreno|Mali|PowerVR|llvmpipe|SwiftShader|SVGA/i.test(renderer)) {
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    if (info) renderer = String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL) ?? renderer);
  }
  const hardware = /NVIDIA|GeForce|AMD|Radeon|Intel|Apple|Adreno|Mali|PowerVR/i.test(renderer)
    && !/llvmpipe|softpipe|swiftshader|lavapipe|software|SVGA|VMware|Basic Render/i.test(renderer);
  if (!hardware && preference !== 'gpu') {
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return;
  }
  canvas.addEventListener('webglcontextlost', event => event.preventDefault());
  gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST);
  return { canvas, gl, initContext: () => !gl.isContextLost(), device: renderer };
}

export function probeDirectTerrainContext(): any | undefined {
  try { return probe(); } catch { return undefined; }
}
