# Portal particle runtime

The portal runtime starts from Dust commit `85d0740e7d592d9b65395fbdae68013f23c4acc7`.
The map passes its worker canvas into the renderer and reports its WebGL device.
The Eye Room adds a material collision field to both the CPU reference and the
GPU update shader. Its nine child trails use the velocity and position after
collision to calculate their endpoints. [Eye Room collision fixtures](../../../docs/portal-collision-audit.md)

Both particle workers use Dust’s shared `playback-clock.mjs`. The CPU and GPU
paths round travel distance before projecting the trail endpoint, and add the
fractional draw origin after snapping a point glow to the world grid. The
software stamp converts the resulting quad edge to its first covered pixel.
[Dust commit 00dc4ed](https://github.com/WUOTE/dust/commit/00dc4ed2eaf304d5c50dbb5b9607d3f66bf0be74)

The map worker calls `configureParticles(entries, true)` to run GPU physics and
drawing. Shadow replay, backpressure, bitmap presentation and camera reprojection
live in the map code. The 32 portal definitions in `../assets/effects.*` come from
`build_scripts/extract-portal-effects.py`. World-space placement rules live in
`../placements.json`. [Playback measurements](../../../docs/experimental-gpu-portals.md#dust-playback-measurements)
