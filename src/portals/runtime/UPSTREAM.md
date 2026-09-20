# Isolated particle renderer snapshot

Source: WUOTE/noita_particle_animations, commit
`85d0740e7d592d9b65395fbdae68013f23c4acc7` (2026-09-19 08:29 EDT).
An isolated `git pull --ff-only` on 2026-09-19 confirmed GitHub main is unchanged.
Copied from the isolated checkout `task/noita-particle-animations`, not linked to
or edited inside the actively developed sibling repository.

Only `gpu-grid-renderer.mjs` is adapted: its constructor optionally accepts an
existing canvas. The experimental GPU particle physics/shaders are unchanged.
The map worker always calls `configureParticles(entries, true)`; it never selects the
CPU/software or GPU-drawing/CPU-physics backends. The software renderer module is
upstream's shared geometry helper, not a runtime raster fallback.

`../assets/effects.*` are extracted portal-only XML/sprite definitions using the
isolated adaptation in `build_scripts/extract-portal-effects.py`. They contain
32 portal definitions, not the entire game archive. World-space placement rules
are separately sourced and documented in `../placements.json`.

The map-specific worker, GPU-fence backpressure, bitmap presentation and camera
reprojection live outside this vendored directory. The upstream shaders and
particle physics are unchanged.
