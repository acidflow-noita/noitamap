#!/usr/bin/env python3
"""Compile/link the viewer's GLSL ES 3.0 programs in surfaceless EGL. No browser."""
import ctypes as C
import ctypes.util
import os
import json
import subprocess
import re
from pathlib import Path

os.environ.setdefault('EGL_PLATFORM', 'surfaceless')
os.environ.setdefault('LIBGL_ALWAYS_SOFTWARE', '1')
egl = C.CDLL(ctypes.util.find_library('EGL') or 'libEGL.so.1')
gl = C.CDLL(ctypes.util.find_library('GLESv2') or 'libGLESv2.so.2')

def bind(lib, name, result, *args):
    fn = getattr(lib, name)
    fn.restype, fn.argtypes = result, list(args)
    return fn

ptr, integer, uint = C.c_void_p, C.c_int, C.c_uint
get_display = bind(egl, 'eglGetDisplay', ptr, ptr)
initialize = bind(egl, 'eglInitialize', uint, ptr, C.POINTER(integer), C.POINTER(integer))
choose_config = bind(egl, 'eglChooseConfig', uint, ptr, C.POINTER(integer), C.POINTER(ptr), integer, C.POINTER(integer))
bind_api = bind(egl, 'eglBindAPI', uint, uint)
create_context = bind(egl, 'eglCreateContext', ptr, ptr, ptr, ptr, C.POINTER(integer))
create_surface = bind(egl, 'eglCreatePbufferSurface', ptr, ptr, ptr, C.POINTER(integer))
make_current = bind(egl, 'eglMakeCurrent', uint, ptr, ptr, ptr, ptr)
terminate = bind(egl, 'eglTerminate', uint, ptr)
create_shader = bind(gl, 'glCreateShader', uint, uint)
shader_source = bind(gl, 'glShaderSource', None, uint, integer, C.POINTER(C.c_char_p), C.POINTER(integer))
compile_shader = bind(gl, 'glCompileShader', None, uint)
shader_status = bind(gl, 'glGetShaderiv', None, uint, uint, C.POINTER(integer))
shader_log = bind(gl, 'glGetShaderInfoLog', None, uint, integer, C.POINTER(integer), C.c_char_p)
create_program = bind(gl, 'glCreateProgram', uint)
attach = bind(gl, 'glAttachShader', None, uint, uint)
link = bind(gl, 'glLinkProgram', None, uint)
program_status = bind(gl, 'glGetProgramiv', None, uint, uint, C.POINTER(integer))
program_log = bind(gl, 'glGetProgramInfoLog', None, uint, integer, C.POINTER(integer), C.c_char_p)
feedback_varyings = bind(gl, "glTransformFeedbackVaryings", None, uint, integer, C.POINTER(C.c_char_p), uint)
get_string = bind(gl, 'glGetString', C.c_char_p, uint)
delete_shader = bind(gl, 'glDeleteShader', None, uint)
delete_program = bind(gl, 'glDeleteProgram', None, uint)

root = Path(__file__).resolve().parents[1]
shaders = json.loads(subprocess.check_output([
    'node', '--input-type=module', '-e',
    'import {PARTICLE_SHADERS} from "./src/portals/runtime/gpu-particle-shaders.mjs"; '
    'import {GPU_SHADERS} from "./src/portals/runtime/gpu-grid-renderer.mjs"; '
    'import {MAP_COMPOSITE_VERTEX} from "./src/portals/gpu-renderer.mjs"; '
    'console.log(JSON.stringify({...Object.fromEntries(Object.entries(PARTICLE_SHADERS).map(([k,v])=>["particles_"+k,v])),...Object.fromEntries(Object.entries(GPU_SHADERS).map(([k,v])=>["gpu_"+k,v])),mapVertex:MAP_COMPOSITE_VERTEX}));'
], cwd=root, text=True))
pairs = [('particles_updateVertex','particles_updateFragment'), ('particles_drawVertex','gpu_quadFragment'),
         ('gpu_quadVertex','gpu_quadFragment'), ('mapVertex','gpu_composite')]
pairs += [('gpu_screenVertex','gpu_'+name) for name in ['horizontal','history']]
display = get_display(None)
try:
    major, minor = integer(), integer()
    if not initialize(display, C.byref(major), C.byref(minor)):
        raise RuntimeError('Cannot initialize surfaceless EGL; install Mesa EGL/GLES libraries')
    attributes = (integer * 13)(0x3040,0x40, 0x3033,1, 0x3024,8, 0x3023,8, 0x3022,8, 0x3021,8, 0x3038)
    config, count = ptr(), integer()
    if not choose_config(display, attributes, C.byref(config), 1, C.byref(count)) or not count.value:
        raise RuntimeError('No EGL ES3 pbuffer config')
    bind_api(0x30a0)
    context = create_context(display, config, None, (integer * 3)(0x3098,3,0x3038))
    surface = create_surface(display, config, (integer * 5)(0x3057,1,0x3056,1,0x3038))
    if not context or not surface or not make_current(display, surface, surface, context):
        raise RuntimeError('Cannot create GLES3 context')
    for vertex, fragment in pairs:
        program, handles = create_program(), []
        for name, stage in [(vertex,0x8b31),(fragment,0x8b30)]:
            shader = create_shader(stage)
            text = C.c_char_p(shaders[name].encode())
            shader_source(shader,1,C.byref(text),None)
            compile_shader(shader)
            status = integer()
            shader_status(shader,0x8b81,C.byref(status))
            if not status.value:
                message = C.create_string_buffer(8192)
                shader_log(shader,len(message),None,message)
                raise RuntimeError(name + ': ' + message.value.decode())
            attach(program,shader)
            handles.append(shader)
        if vertex == 'particles_updateVertex':
            outputs = (C.c_char_p * 2)(b'nextMotion', b'nextAppearance')
            feedback_varyings(program, 2, outputs, 0x8c8c)
        link(program)
        status = integer()
        program_status(program,0x8b82,C.byref(status))
        if not status.value:
            message = C.create_string_buffer(8192)
            program_log(program,len(message),None,message)
            raise RuntimeError(fragment + ': ' + message.value.decode())
        for shader in handles:
            delete_shader(shader)
        delete_program(program)
        print('Linked', vertex, '+', fragment)
    print('GLSL validation only:', get_string(0x1f02).decode(), '(no browser)')
finally:
    terminate(display)
