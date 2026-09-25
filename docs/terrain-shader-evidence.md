# Terrain shader coefficient verification

Verified on 2026-09-25 through Ghidra-MCP 7.0.0, using a copy of the existing
Noita analysis project. Executable SHA-256:
`808d2a0ab51ea0b46e9ad2aeb3327a4b0ce3feae04f32ba26326bf585b5779bd`.
No game process was started or modified.

`BiomeNodeLookupCoord` at `0087ce50` reads the following double coefficients.
Ghidra-MCP `read_memory` and `decompile_function`, independently checked against
the executable's bytes and instructions, agree with the CPU reference's
`dblFromHex` constants in `engine_resolve/topo2_resolve.js`.

| Shader constant | Binary address | Binary double bits | Value | Correct float32 bits |
| --- | --- | --- | --- | --- |
| `ENG_WARP_CX` | `010538c0` | `3fc18e219652bd3c` | `0.13715` | `3e0c710d` |
| `ENG_WARP_CY` | `010538c8` | `3fc18ec95bff0457` | `0.13717` | `3e0c764b` |
| `ENG_F2` | `010538b0` | `3fbc71c720000000` | `0.1111111119389534` | `3de38e39` |

The pinned upstream shader used `0.13715155947046348`,
`0.13717455323209457`, and `0.11111110448837280273`, respectively. These are
different constants; the first two errors are not ordinary float rounding.
The Vite integration corrects their declarations with `uintBitsToFloat`,
alongside the previously verified RarePolka corrections. Every shader consumer
built through the main Vite configuration receives the correction.

## Native shader comparison

Seed `786433191`, normal NG0, material identity before scene/decal composition.
Each region is 128 × 128 world pixels. The baseline retains the earlier
RarePolka correction and restores only the three old topology coefficients.
Both variants use identical generated world data and CPU reference.

| Region origin `(x, y)` | Previous mismatched pixels | Corrected mismatched pixels |
| --- | ---: | ---: |
| `(0, 512)` | 42 | 0 |
| `(-1024, 512)` | 63 | 0 |
| `(0, 4096)` | 24 | 0 |
| `(7168, 8192)` | 45 | 0 |
| `(35840, 512)` | 101 | 0 |
| `(-35840, 512)` | 43 | 0 |
| **Total: 98,304 pixels** | **318** | **0** |

This executes GLSL through Mesa 26.2.3, OpenGL ES 3.2, llvmpipe
(LLVM 22.1.8, 256 bits). It is a numerical shader test on a software renderer,
not a hardware performance measurement or browser test.

`tests/gpu-bake-materials.test.ts` preserves six formerly incorrect material
decisions across these regions, as well as four existing RarePolka regressions.
`tests/terrain-shader-bits.test.ts` checks the exact coefficient encodings against
the independent CPU reference and rejects missing upstream declarations.

## Remaining precision boundary

The game multiplies the coordinates in double precision and then converts to
float; GLSL ES performs the multiplication in float precision. Correcting the
coefficient does not remove that difference, driver operation reassociation,
or other terrain/composition differences. These sampled matches do not certify
all seeds, all coordinates, or final composed pixels. The full-map decoded-pixel
parity gate remains necessary for GPU exports.

## Vertical-world storage coordinates

The instant renderer prepares a separate biome/material lookup map for each
vertical plane and shares each prepared renderer across the horizontal worlds.
The main Wang geometry repeats; noise and material bands still use absolute
world coordinates. Heaven and hell resources can therefore be initialized only
when visible.

The shader's `u_verticalPlane` translates chunk rows by 48 and translates the
resolved lattice Y coordinate by 2457.6 cells per plane. Simply wrapping a raw
coordinate is incorrect: the stored lattice height is `trunc(24576 / 10) = 2457`
cells, which would shift repeated geometry by six pixels per vertical world.
The fractional lattice offset is split into two float values so it is not
rounded before subtraction. `setTerrainPlane` sets this uniform after resource
preparation and before drawing; the camera retains absolute world Y.

Native comparison against `createCpuTerrain(prepareTerrainPlane(...))` covers
twelve 64 × 64 owned regions, six each in heaven and hell: **49,152 pixels**.
All air/solid decisions agree. All hell material IDs agree. One heaven material
ID differs at `(-3500, -22958)`: GPU 430 versus CPU 38. The retained test allows
only that single mismatch in its region; every other tested region is exact.
This remaining noise-threshold difference is not hidden as full material parity.
The same tests demonstrate that omitting the plane transform produces more
mismatches in every region. An independent camera test checks all nine
horizontal/vertical world combinations at coarse and detail LODs.

These regions exclude the independently generated continuous hell elevator
extensions, and the comparison precedes scene/decal composition. Their coverage
must not be described as a complete final-pixel comparison of the vertical map.
## Shader startup and worker isolation

The live terrain worker compiles and links the corrected shader while source
assets load. `virtual:instant-terrain-shaders` copies only the shader's imported
numeric literals from the pinned Telescope source at build time. It rejects
nonliteral changes. This avoids evaluating the generator's archive-dependent
imports before a cold `data.zip` download finishes. The native worker regression
test requires both shader strings to equal the regular renderer's strings and
forbids worker asset fetches before resource initialization.

Resource construction, texture uploads, and draws run in the same persistent
OffscreenCanvas context. Cancelled or superseded requests close transferred
bitmaps; old generation handles cannot invalidate a newer seed. Unsupported or
failed workers fall back to the regular canvas, and worker requests have a
30-second failure deadline. Closing dynamic maps terminates persistent workers.

With Mesa's shader disk cache disabled, the native worker test generated seed
786433191 in 975 ms and delivered its first 128×128 terrain tile in 3,371 ms,
including a 262 ms resource build. Main-thread heartbeat gaps during resource
preparation and drawing stayed below 6.6 ms. All 196,608 output bytes matched a
direct render. These are local llvmpipe measurements, not browser or hardware
GPU frame rates. Driver specialization still costs about 1.94 seconds on the
first real draw. A dummy draw increased total latency and is deliberately absent
from the shipped prewarm path.
