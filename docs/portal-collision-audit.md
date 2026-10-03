# Eye-room static-material collision

**Implemented for the reviewed eye-room chamber, not arbitrary world terrain.**
Both eye-room simulation names use the extracted material field and native
cosmetic bounce/kill rules. Other portals remain unchanged; unknown scene cells
are not invented walls. This is physics, not a clipping mask or a shorter XML
lifetime. Browser/game visual comparison remains manual.

## Source evidence

Inspected the extracted game data and Ghidra output in
`../noita_particle_animations/task/`, then executed the movement routine from the
local executable through that project's Unicorn reference harness. Executable
SHA-256: `808d2a0ab51ea0b46e9ad2aeb3327a4b0ce3feae04f32ba26326bf585b5779bd`.

- `teleport_hourglass_return.xml` has two parent emitters with explicit
  `collide_with_grid="0"` and nine child FX entities.
- The child XML specifies long particles, vertical speed 60 px/s and lifetime
  10–20 s, and omits `collide_with_grid`. The native component constructor
  (`0x00a66480`) initializes field `+0x66` to **1**; property access `0x00a6ec0f`
  maps the collision property to that offset. Omission does not mean false.
- Cosmetic creation (`0x00716ce0`) sets particle `+0x6b` bit 1 for collision and
  `+0x6a` bit 5 for bouncing. The movement helper is `0x00712390`.
- `biome_impl/snowcastle/hourglass_chamber.png` is the **material program**, not
  the background artwork. The portal anchor is (256,255). At x=256, air ends at
  y=338 and steel occupies y=339 through 346. Material color `0xff404041` maps to
  `steel_static`, whose native cell type is liquid (1), with static/sand flags.
  The extracted field stores steel as 1, known air as 0, and unknown cells as 255.

The earlier air-only source simulation crossed the central steel at step 179:
local (0.445320487,84.836990356), vy=62.147724152, life=14.215396881 s. This confirms
a real missing mechanism, not a reason to shorten the source lifetime.

## Implemented behavior

- Preserve each emitter's collision flag, including the native true default.
  Only the eye-room children collide; its parents and Holy Mountain particles
  retain their non-colliding behavior.
- Upload the hashed 512×512 material field as an integer texture. Lookup uses
  particle **world coordinates**, translated to the actual portal anchor;
  negative coordinates and parallel-world offsets are tested. Unknown/outside
  cells remain non-blocking. No screen-space crop controls collision.
- Follow native sampled movement (up to 60 samples), truncating cell coordinates
  toward zero. The last sampled cell is separate from the long-particle endpoint.
- Cell types 1 and 3 obstruct ordinary cosmetic particles. Bounce-disabled or
  liquid particles die. Other particles reflect the dominant movement axis,
  receive conditional horizontal jitter and 0.1–0.3 velocity damping, then the
  conditional 0.5–1.5 s lifetime reset. Slow bounces disable further bouncing.
- The reset can **extend** a particle whose remaining life is just above 1 s.
  GPU slot/counter retention includes 94 conservative extra steps for the
  reviewed zero-gravity, zero-attractor, low-airflow trails. The bound is derived
  beside `COLLISION_RETENTION_STEPS`; it is not applied to shader lifetimes.
  Replay also includes this allowance and float32 expiry, instead of assuming
  that exactly 1,200 steps always cover a nominal 20-second lifetime.
- Collision randomness uses the native Park–Miller transition in an isolated
  per-particle stream. All 31 bits survive GPU packing/restoration. This preserves
  emission RNG and culled/shadow replay, **not** the live game's globally shared,
  interleaved cosmetic RNG sequence.
- GPU buffers now occupy 160 bytes per slot, including two dynamic buffers and
  static attributes. Early-dead slots are conservatively retained; diagnostics
  mark particle counts as upper bounds. There is no per-frame particle readback
  or CPU quad construction in the map renderer. The CPU collision path is
  the reference/restoration path, not a map-rendering fallback.

## Verification

`probe-portal-collisions.py` injects synthetic material lookups but executes the
original collision response instructions. Fixtures contain numerical inputs and
outputs, not the executable or decompiled game code.

- 25 native cases cover collision opt-out, kill/bounce, blocking and non-blocking
  material classes, liquid particles, both axes, diagonals, negative coordinates,
  subpixel motion, sample limits, contact-cell state, short/extended lifetimes,
  high RNG state, repeated steps and parallel-world offsets.
- CPU reference and the **actual transform-feedback shader** match those cases.
- A 600-step GPU test with the real chamber field and seed 1 compares against the
  air-only control: maximum trail y is about **84.064**, versus **560.608** without
  collision. None passes through the bottom of the central steel. Native sampled
  motion can finish fractionally inside its first row; it is not flattened to a
  visually convenient boundary.
- The same test checks live state restoration/re-upload, nonzero-offset buffer
  compaction/growth, preservation of extended lifetimes, emission RNG isolation,
  conservative counts and GPU memory accounting. A separate continuous-versus-
  shadow test verifies culling replay with real colliding particles.

These run with real surfaceless GLES and Mesa software, **not a browser or a GL
mock**. The local SVGA3D virtual device returned stale transform-feedback data
between uploads without repeated buffer readbacks; numerical tests explicitly
select software rather than hiding that with synchronization in production.
Hardware bake selection remains unchanged. This is not a hardware performance
benchmark or a browser compatibility claim.

## Reproduce

```sh
npx vitest run tests/portal-collision-*.test.ts tests/portal-worker-runtime.test.ts
python build_scripts/probe-portal-collisions.py \
  --executable /path/to/Noita/noita.exe \
  --reference-tools ../noita_particle_animations/tools --matrix
```

The Python environment needs Unicorn; the reference harness validates the
executable hash. The existing three-case fixture is reproduced without `--matrix`.

## Remaining limits / manual checks

The material field is the original static chamber, not a player's modified save.
Base-biome material outside that scene, changing fluids, destroyed walls, shared
cosmetic RNG, and other portals' terrain are not simulated. Native world-boundary
and material-particle creation branches are outside this cosmetic-scene scope.
Review eye-room motion, wall/glow overlap, zooming, leaving/re-entering the view,
parallel worlds, and toggle-off behavior manually. No browser testing was run.
