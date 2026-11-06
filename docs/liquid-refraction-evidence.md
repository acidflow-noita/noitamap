# Liquid refraction and generated mask export

Status, 2026-11-06: production wobble is restricted to the captured Holy Mountain
water pools. The all-liquid adaptation and basin reservations described below
are historical research, not the current rendering policy. New Daily bakes no
longer export generated-liquid masks. See [liquid-wobble.md](liquid-wobble.md).

## Native evidence

Inspected on 2026-11-04 without starting the game. The source executable was
`/home/w/Documents/git/noita-sources/noita_bin/noita.exe`, SHA-256
`a0d9f9ca513e27a598c61dd9a19211c7a11d1477c9a2b93d909757d91d17d914`.
Addresses below are virtual addresses in that PE image. This is static
instruction evidence, not observation of a running game.

The material gate is inherited `cell_type="liquid"` and `liquid_sand="0"`.
It includes lava, water, blood, oil, acid, radioactive liquid, liquid fire,
rainbow liquid, and static fluids such as `water_static`. Visual alpha and
`gfx_glow` do not exclude a material. Powders use `liquid_sand="1"` and are
excluded even though their cell type is also liquid.

| Address | Observed operation |
| --- | --- |
| `0x00725264..0x00725281` | Requires cell type 1, calls virtual slot `+0x64`, then sets glow alpha to 255 when the result is false. |
| `0x0100bb90` | `CLiquidCell` vtable, resolved through its native RTTI. Slot `+0x64` points to `0x0070b110`. |
| `0x0070b110..0x0070b11b` | Reads material byte `+0x160`. |
| `0x006fbd4b..0x006fbdf3` | Associates XML `liquid_sand` with material byte `+0x160`. |
| `0x005b01c0..0x005b01c4` | Liquid vtable slot `+0x10` reads cell state byte `+0x20`. |
| `0x007255c5..0x007255ea` | Clears the liquid alpha when state is not 3, except in the last two buffer rows. |
| `0x0072564e..0x0072565c` | Stores the packed result in renderer buffer `+0x470`. |
| `0x0088d555`, `0x0088dd8a` | References the `tex_glow_source` and `tex_glow_unfiltered` bindings, respectively. The saved frame decompilation binds both to texture member `+0x9c`. |

The reused assembly is
`/home/w/Documents/git/noita_particle_animations/task/research/material-cell-glow/native-cell-blitter.asm`.
All 1,403 address rows, totaling 5,027 bytes, matched the current executable.
Its SHA-256 is
`a3e8f011ef36f4a60d0ef9f53ce4fdd91aee2a8388cd1c618843e535879aea60`.
No new REA Evidence ID was generated; an earlier glow replay does not verify
this refraction branch and is not used as evidence for it.

The extracted `data/shaders/post_final.frag`, lines 185–210, tests
`tex_glow_unfiltered.a >= 0.99` at both the original and displaced sample.
Both must pass before its sine/cosine displacement is applied. Shader SHA-256:
`ac56e1b7df78d378db8e3bac5de30b781ec4f1d978f771ead2775239bb34619e`.
The numeric state requirement above is established. Calling state 3 settled
is an interpretation of the movement code, not a recovered enum name.

## Tool versions

The installed REA 6.8.0 and GhidraMCP 7.0.0 matched their latest published
releases. Ghidra 12.2 was already installed beside 12.1.4. REA 6.8.0 accepts
Ghidra 12.1.x and explicitly rejects 12.2; its configured 12.1.4 provider and
JDK 21.0.12.1 were available. No installation or configuration change was
needed. The standalone MCP had no running instance. Existing exports were
reused instead of importing the game again.

Release sources: [REA 6.8.0](https://github.com/morluto/rea/releases/tag/rea-agents-6.8.0),
[GhidraMCP 7.0.0](https://github.com/bethington/ghidra-mcp/releases/tag/v7.0.0),
and [Ghidra 12.2](https://github.com/NationalSecurityAgency/ghidra/releases/tag/Ghidra_12.2_build).

## Map adaptation and publication

The map treats its generated fluid occupancy as settled. It does not simulate
the native per-cell state. `finish(pixels, x, y, width, height, mask?)` and the
CPU/GPU bake `render` methods accept an optional one-byte-per-pixel mask.
The material grid already resolved for edge decals supplies the mask, after
scene FORCE AIR and material replacements. Surface leveling records its own
material edits, and scene-authored cells take precedence over those edits.
Protected static pixels and static FORCE AIR are excluded. The generated mask
does not infer material identity from rendered color, alpha, or a capture.

Each private leaf checkpoint has a `.liquid-v1.bin` sibling. Even an empty
tile must have a valid empty-mask header; old image-only cores are not complete
mask checkpoints. The render fingerprint includes shared material/codec
sources and an independent `-liquid1` suffix. The terrain version is unchanged.
No existing completed bake was regenerated during this change; an explicitly
invoked new bake uses the new render identity and cannot silently accept old
cores as having masks.

Every expected leaf is validated before writing one public `liquid-mask.bin`
per horizontal world. The file contains all three vertical planes as sparse
world-coordinate blocks. No public per-tile mask files are emitted. Empty
blocks are omitted. Accumulation and publication are capped at 25 MiB, and the
existing 20,000-file budget includes the one new public file. Only after the
mask is atomically written does the world manifest receive this field:

```json
{
  "liquidMask": {
    "version": 1,
    "path": "liquid-mask.bin",
    "bytes": 472,
    "sha256": "<64 lowercase hexadecimal characters>",
    "seed": 195331,
    "renderId": "<same renderId as the containing manifest>"
  }
}
```

The byte count above is illustrative. The descriptor describes exact encoded
bytes, without gzip. Completed-bake resume validates the version, seed,
render identity, length, digest, and codec. Missing/corrupt checkpoints and
incomplete or duplicate tile inventories prevent new publication. All worlds
validate before deployable directories or the daily seed pointer are replaced.

## Validation and measured cost

The reported apparent 90-degree rotation was checked against the current
executable's `RenderWorldFrame` quad construction at `0x88ee1c..0x88ef8e`.
Screen TL, BL, TR and BR have texture0.xy `(0,1), (0,0), (1,1), (1,0)` and
texture0.zw `(0,0), (0,1), (1,0), (1,1)` before subpixel offsets. The vertex
interleaver at `0x44b830` and OpenGL binder at `0xdd9860` retain those component
orders (stride 36, texture0 offset 8). `0xdd73b0` selects top-left screen
coordinates. The cell buffer is row-major at `0x724720..0x724733`; its upload
keeps the dimensions and row order. This supports the existing X/Y assignments
and Y sign correction, not an axis transpose. Camera rotation, flipping and
resized snapshots are independently covered by renderer tests.

Material-composition tests use actual Noita material IDs and scene material
grids. They cover water/blood/lava/rainbow, air, rock, sand, ownership, FORCE
AIR, visual art, leveling, scene precedence, and protected static bits. Sparse
package tests reconstruct actual mask pixels and reject missing, mismatched,
duplicate, and corrupt inputs while preserving an existing completed file.

The native CPU/GPU test uses seed 195331 and the actual bake renderers through
Mesa llvmpipe (LLVM 19.1.7), OpenGL ES 3.2 Mesa 25.0.7. Across 74,048 sampled
pixels in the main world, heaven, hell, and a plane-boundary request, masks
matched exactly and requesting a mask changed no CPU output bytes. The three
200 by 120 pool samples contained 3,559, 3,569, and 3,605 liquid pixels; their
individual sparse files were 472, 400, and 472 bytes. The empty boundary sample
encoded to 12 bytes.

The repair regression also checks the reported seed 2100611341. Its 200 by
120 region around 626,2043 contains 3,875 generated fluid pixels. The CPU and
GPU masks agree. The 367 by 15 captured-basin overlap at 585,1009 clears all
5,321 reserved pixels, leaving only the 184 unfilled pixels of its first row
available to procedural painting. Those captured pixels remain outside the
generated mask and use the independent static liquid mask.

Eight alternating warmed 24,000-pixel CPU renders took 35.39 ms without masks
and 36.83 ms with masks: about 0.18 ms extra per render (4.1% in this sample).
This is a bounded local measurement, not whole-world bake timing. The native
sample has no pixel scenes; synthetic composition tests cover scene/static
precedence. Each 512 by 512 worker job allocates 256 KiB for its mask plus
sparse surface edits, and performs one additional private checkpoint write.
Aggregation is sequential and does not allocate a dense whole-world mask.

## Authored lava polygon boundary

The extracted `data/biome/lava_90percent.xml` defines a lava polygon with
vertices `(0, 0.02), (1, 0.02), (1, 1), (0, 1)`, with biome-edge noise off.
Its native polygon gate accepts local **columns 1–511 and rows 11–511** of
each 512 by 512 chunk. In particular, row 10 is outside. Column 0 is also
outside because of the polygon helper's boundary comparisons; this is not an
added visual inset.

The existing selector decompilation is
`/home/w/Documents/git/bartender/task/material-availability-native/0x86d2a0.c`,
backed by `procedure_pseudo_code` Evidence
`ev_d297e24c2050e88de3819e78cbc600ad31810884b213b81eddf669370b7cab12`
in that directory's `evidence.json`. Its subject is the same executable and
SHA-256 recorded above, with shipped-artifact authority and observed confidence.
Because the decompiler omits some register arguments, the sampling convention
was checked directly against the current executable's instructions and constant:

| Address | Native observation |
| --- | --- |
| `0x0086d325..0x0086d329` | Tests MaterialComponent `is_polygon` byte `+0x74`. |
| `0x0086d32b..0x0086d350` | Applies positive modulo 512 to integer X and Y. |
| `0x00918210..0x00918222` | Signed integer remainder, adding the divisor when the remainder is negative. |
| `0x0086d33c..0x0086d373` | Converts those integer remainders to float32 and multiplies by `1/512`, with no half-pixel addition. |
| `0x01053434` | Exact float32 bits `0x3b000000`, equal to `0.001953125`. |
| `0x0086d355..0x0086d378` | Reads polygon vertices from component `+0x78/+0x7c` and calls `0x00ddc9a0`. |
| `0x00ddc9d9..0x00ddca21` | Finds edges whose endpoint comparisons `vertexY >= sampleY` differ. |
| `0x00ddca23..0x00ddca76` | Counts crossings at X greater than or equal to sample X and toggles the parity. |

Thus the normalized query is `(positiveMod(worldX,512)/512,
positiveMod(worldY,512)/512)`. Row 10 samples `0.01953125`, below the XML
float32 value near `0.02`; row 11 samples `0.021484375`, above it. On the exact
left boundary, both vertical edges count and cancel. At columns 1–511 only
the right edge counts. For the integer grid, the polygon gate therefore accepts
511 times 501 = **256,011 pixels** per chunk.

This conclusion is static instruction analysis, corroborated by evaluating
the recovered finite comparison formula over the integer grid. Neither the
native helper nor the game was executed. It establishes polygon membership;
other biome/material selection conditions remain separate. An attempted
read of a temporary copy of the prior Ghidra project could not serve queries
because the sandbox disallows local sockets. That process was stopped; no
installed configuration or original analysis project was changed.
