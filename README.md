# <a href="https://noitamap.com" target="_blank"><img src="https://github.com/acidflow-noita/noitamap/blob/main/public/assets/NoitamapLogo.svg" alt="Noitamap Logo" style="width: 41px; height: 49px" /> NoitaMap.com</a>

_Ultrafast_ Superzoom Map for Noita

![Map demo](https://github.com/acidflow-noita/noitamap/assets/106106310/94e0fb7e-4e0f-4419-9c14-38cace15efee)

> TLDR: This repo contains sources for a very high-resolution highly-performant map for the video game called [Noita](https://store.steampowered.com/app/881100/Noita/). Noitamap uses [OpenSeadragon](https://github.com/openseadragon/openseadragon).
> This repo started as a fork of whalehub's repo, which has been deleted from github but we had a [lucky fork](https://github.com/quiddity-wp/noita-map-viewer) with updated version of openseadragon and probably a different algo for creating the "pyramid" (zoomable) tiles. My goal is to create the best map viewing experience.

The [map iself](https://noitamap.com) is being served by cloudflare pages with deployment from this repository.

## Where can I find the source tiles?

All the current map captures are backed up as separate `7z` archives and can be found in a shared [Google Drive Folder](https://drive.google.com/drive/folders/10oSm9NOv0mdWT98tWDB-97nuP_gp1qQz).

We're using seed `786433191` while running map capture because it has a couple structures and secrets visible. If you find a seed with even more stuff, please open an issue!

## I want to help, what can I do?

If you're a **developer**, contributions and discussions are welcome, feel free to open PRs and issues, take a look at the [project](<[url](https://github.com/orgs/acidflow-noita/projects/1)>) to see what work is being done.

If you're a **player**, you can help by capturing a new version of one of the game modes, or mods (maps with significant changes over time have date indication on the website), then stitch the map and upload an archive with what you've got to a sharing service like google drive, pixeldrain, gofile, etc, then opening an issue. Also, you can help by translating the map into your language and add more points of interest to the overlays (for those who are unable to open a PR the ability to contribute will be added later in the dev cycle).

### How to capture a map

Download the latest release from the [noita-mapcap](https://github.com/Dadido3/noita-mapcap/releases/latest), unpack it and move the `noita-mapcap` directory into your noita mods folder.
To navigate to your mods folder either open the mods directory from inside the game by pressing `Mods`-->`Open mod folder`, or opening this directory:

```powershell
C:\Program Files (x86)\Steam\steamapps\common\Noita\mods\
```

![Opening mod folder from inside the game](https://github.com/acidflow-noita/noitamap/assets/106106310/fa071095-1129-4c1f-bfae-702138ce4ba0)

Before starting the map capture process, check that all the mod settings are correct: use `3 Worlds` capturing mode with `60 frames` capture delay and seed set to `786433191`, all the settings should look exactly like on this screenshot excep for specific non-standard map sizes mods like alternative biomes.
![Noita-mapcap settings](https://github.com/acidflow-noita/noitamap/assets/106106310/dfe4571f-d0d5-4fe2-9f16-b270aec56dac)

### How to stitch a map

1. Navigate to the `Stitcher` directory, its location is:

```powershell
C:\Program Files (x86)\Steam\steamapps\common\Noita\mods\noita-mapcap\bin\stitch
```

2. Right click inside this directory and select "`Open in Terminal`"
   ![Launching Terminal](https://github.com/acidflow-noita/noitamap/assets/106106310/a46f1d51-53bc-4b2c-b3a2-799388e0c558)

3. Copy the following command and paste it into the terminal (either `Ctrl+V` or `Mouse right click`), **Do not run the command yet**, you will need to rename the output files following the naming convention: `gamemode-branch-world-patchDate-seedNumber.dzi` (e.g. `regular-main-branch-left-2024-04-08-78633191.dzi`)

```powershell
.\stitch.exe --output nightmare-main-branch-left-2024-04-08-78633191.dzi --blend-tile-limit 1 --dzi-tile-size 512 --xmin -53760 --xmax -17408 --ymin -31744 --ymax 41984 --webp-level 9 && .\stitch.exe --output nightmare-main-branch-middle-2024-04-08-78633191.dzi --blend-tile-limit 1 --dzi-tile-size 512 --xmin -17920 --xmax 18432 --ymin -31744 --ymax 41984 --webp-level 9 && .\stitch.exe --output nightmare-main-branch-right-2024-04-08-78633191.dzi --blend-tile-limit 1 --dzi-tile-size 512 --xmin 17920 --xmax 53760 --ymin -31744 --ymax 41984 --webp-level 9
```

4. This will launch the stitcher and after it finishes you will see next to the `stitch.exe` 3 new directories (`gamemode-branch-world-patchDate-seedNumber_files`), and 3 new files (`gamemode-branch-world-patchDate-seedNumber.dzi`).

### How to share the capture results to get them added to Noitamap

1. Make a new directory, for example, `upload`, then create a directory inside it, call it `gamemode-branch-world-patchDate` and move the stitching results to it.
2. Create a `.7z` archive with the maximum compression level (`9`). You can do it manually by right-clicking the direrctory, then choosing "`7-zip`-->`Add to Archive`" and selecting `7z` format and "`9 - Ultra`" compression level, or you can open Windows Terminal inside the `upload` directory and execute this command:

```powershell
Get-ChildItem -Directory | ForEach-Object { & "${env:ProgramFiles}\7-Zip\7z.exe" a -mx9 "$($_.FullName).7z" "$($_.FullName)\*" }
```

![image](https://github.com/acidflow-noita/noitamap/assets/106106310/c2e93548-4cf1-43ba-b329-b1e9f8ddc906) 3. Upload the `7z` archive you got to your favorite file sharing service (Google Drive, Mega, PixelDrain, Gofile, etc.) 4. Open a new issue with the `new-map-capture` label, provide details about the map you've captured and post the link.

## Thanks

Huge thanks to [@Dadido3](https://github.com/Dadido3), [@myndzi](https://github.com/myndzi), [@Acors24](https://github.com/Acors24) and [@dextercd](https://github.com/dextercd) for their work, their help, and advice! Thanks to [Arganvain](https://www.twitch.tv/arganvain) for fixing the logo I initially made, thanks to discord user wand_despawner for capturing several maps, thanks to discord user hey_allen for providing storage space for the map tiles' disaster recovery, thanks to discord user Bohnenkrautsaft for the suggestion to add map loading indicator, refactoring of the indicator's code, and other code fixes and improvements!

## Full-pixel terrain and daily baking

**Render every pixel** selects the pinned `render-perf` generation/rendering model.
The live map generates main, heaven and hell planes independently, limits terrain
to owned dynamic biome cells, and uses native-resolution game background textures.
WebGL2 accelerates the main plane when available; CPU workers handle unsupported
contexts and the vertical planes. Completed tiles and derived mip levels are
persisted, so changing zoom does not restart completed terrain generation. Progress
uses the existing generation strip, not a separate floating status panel.

Daily and previous-daily maps prefer validated, completed full-pixel bakes and
perform **no live terrain rendering**. Old coarse manifests are rejected only
when full-pixel mode is requested. `?nb=1` explicitly bypasses baked output.

On baked daily/previous-daily maps, **Render every pixel** is hidden entirely.
The whole control is also hidden while the bake probe is pending, so it cannot
flash before a baked map is recognized. Selecting any unbaked seed shows it again
with the saved live-render preference. This is based on the bake actually being
used, not just the seed URL. Live full-pixel rendering is available on production
as well as localhost; it is not restricted to developer mode.

### Native daily bake (no GPU/browser)

```bash
node build_scripts/build-full-pixel-bake.mjs --seed=381773 --out=/path/to/out --concurrency=8 --resume
```

The script generates seed data/POIs once, renders all nine world/plane combinations,
composites backgrounds, scenes and markers, and builds lossless WebP DZIs with
premultiplied-alpha 2:1 reduction and consistent two-pixel overlaps. Full output
is `left/`, `middle/`, `right/` plus `seed.txt`. Each world contains `map.dzi`,
`map_files/`, `manifest.json` and `generation.json`. Nothing is publishable until
all expected tiles exist. Checkpoints include code/data fingerprints; `--resume`
reuses compatible complete work. `--prepare-only` runs just seed/decor preparation.

The CI changes live in `task/biome-baker`. The configured GitLab runner is
`saas-linux-2xlarge-amd64` (32 CPUs, 128 GB RAM), **not** the GPU runner class.
It uses 30 CPU workers; the native image no longer includes Chromium or the Go
stitcher. Native dependencies must be installed separately on Windows with `npm ci` (an npm
built-in command, not a project script). Do not copy Linux `node_modules` to
Windows. Windows end-to-end baking has not been verified by these Linux tests.

### Inspect a local completed bake

Start Vite with `NOITAMAP_LOCAL_BAKE=/path/to/out`, then open
`/?m=dy&se=381773&bake=local`. The seed must match the output manifest. This
explicit development-only route exercises the same baked loader as production.

Verification covers real CPU workers, real native GL shader execution where
Linux EGL is installed, ownership exclusions, native textures, alpha-aware mip
reduction, matching overlaps and cache reuse. These checks do not replace manual
browser inspection or constitute complete simulation of Noita's runtime.

### Compare against the captured engine map

The Regular capture at seed **786433191** is the geometry ground truth. The
historical `78633191` in its asset filenames is a typo; comparison uses the seed
in the capture instructions, not that filename. Never resize the generated map
to match the capture's extra overlap column.

```bash
node build_scripts/build-full-pixel-bake.mjs --seed=786433191 --out=/path/to/reference-bake --concurrency=8
node build_scripts/compare-engine-terrain.mjs --bake=/path/to/reference-bake --published
```

The comparison fetches coordinate-matched samples from the production Regular
capture and Dynamic static underlay. Each output panel is **engine | generated +
static underlay | absolute RGB difference**. `report.json` records every RGB
mismatch. Omit `--published` to sample a `--prepare-only` native renderer instead
of the finished DZI files. This command does not use a browser and does not
pretend that successful rendering or CPU/GPU agreement proves engine accuracy.

Heaven/hell now reuse the main world's Wang geometry and source exclusions;
broadcasting a material row must not regenerate a continuous strip of terrain.
Hell's background is a separate footprint and continues through the empty gaps.
Dynamic scenes use world-positioned material textures, real force-air erasure,
and original color/background artwork rather than flat biome-color rectangles.
The existing static-room/holy-mountain skip policy remains shared with the
approximate renderer. Static temple foreground templates remain a separate
existing art layer, not new procedural fill targets.

**Accuracy is not yet complete:** the reference comparison still shows cloud
color/material differences, scene differences, and terrain-edge detail
mismatches. These remain investigation targets, not accepted capture errors.
See `tests/fixtures/terrain/README.md` for provenance and reproducible checks.


### PNG background transparency regression

`full-pixel-v6` honors the original PNG `tRNS` color keys. The missing RGB-key
handling had turned authored transparent areas into purple/red/orange rectangles
(e.g. `rainforest/plantlife_background.png`, key `#6b0080`). This is PNG metadata,
not a rule to remove arbitrary bright colors or guess from the corner pixel.
Completed v5 terrain tiles are invalidated and must be regenerated.

```bash
npm test -- tests/png-decode.test.ts
node tests/helpers/verify-native-daily-bake.mjs /path/to/completed-bake
```

The decoder tests compare all engine-listed scene backgrounds with native PNG
sample decoding. Daily artifact verification checks real published tiles,
alpha-preserving mip reduction and overlaps. For the exact daily entrypoint test
without resetting a local checkout, see `task/biome-baker/README.md`.


### Bottom-row elevator continuation

`full-pixel-v7` treats the isolated bottom-row `robobase` (Power Plant) stub as a
narrow continuous shaft below the main world, not two endpoint copies of the
same chunk. It generates only that column with the existing Wang generator and
world seed, resolves its native material pixels at absolute coordinates, and
scans the continued strip for its own scenes/POIs. The false lower endpoint's
spawn copy is removed. Original main-world buffers, ordinary Power Plant regions,
static exclusions and the other heaven/hell columns are not regenerated.

The continuation covers the displayed lower plane (48 chunks, y=17,408 through
41,983 in NG0). This does not extend the map's displayed bounds infinitely.
The native baker and live full-pixel CPU tile worker share the same continuation;
old v6 completed tiles need rebaking. `tests/terrain-elevator.test.ts` checks the
exception's footprint and serialization. The native terrain runtime suites
exercise its top/middle/bottom through real OSD jobs, and the bake-artifact
verifier checks all 144 lower shaft chunks across the three horizontal worlds.


### Final-pixel refinement v8

- EdgeGraphics stamps now run on full-resolution terrain **and scene material
  identities** before pyramid reduction; they are not disabled at lower zoom.
  Scene force-air and colors-file/skip-edge rules remain separate paint passes.
- Static-scene masks protect the part of Holy Mountain altars that reaches above
  the biome chunk. Authored air erases terrain while retaining the backdrop;
  protected material reveals existing static art rather than painting it again.
- Authored horizontal liquid surfaces no longer inherit terrain-edge warp. The
  material classification reads `liquid_sand` (including inheritance) from the
  game XML, so water-like liquids and powdered metals are not conflated. Walls,
  bottoms, powders and other liquids are not flattened. This is not a complete
  fluid/reaction simulation.
- Live rendering skips known-empty pyramid subtrees, coalesces overlapping tile
  requests, and yields CPU work by elapsed time rather than imposing a timer
  after every 16 rows. GPU cell rendering is retained, but per-pixel scene,
  liquid and edge composition runs in the shared worker pool instead of blocking the UI.
  A bounded material cache shares resolver results with the edge-neighbor pass.

```bash
npx tsx tests/helpers/measure-terrain-footprint.ts /path/to/prepared-bake
```

For seed 786433191, a complete nine-plane overview skips **21,059 of 30,240**
full-resolution leaf jobs (69.6%). This is a work-count measurement, not a claim
of 69.6% higher browser FPS or instantaneous generation. All nonempty leaves
still render final pixels, and lower levels still reduce all their children.

The capture comparison still exposes the upstream ore/density mismatch and
neighboring biome-edge wobble. Those are **not** claimed fixed. The attempted
room-boundary clipping was rejected because it worsened the engine-reference
comparison. Edge stamping uses the pinned fork's deterministic decoration pass;
the result is not claimed pixel-identical to every captured stamp.


### Live worker pool and liquid/powder classification

Live rendering uses one **page-wide 1–6 worker pool** for all vertical planes and
GPU finishing. The budget leaves at least one reported CPU available and respects
`navigator.deviceMemory` where provided (1 worker at ≤2 GiB, 2 at ≤4 GiB, up to 6
above that; up to 4 when memory is unreported). Workers initialize additional
planes only when needed, reuse their resources, and are terminated when their
renderers are released. This does not alter GitLab's `TERRAIN_CONCURRENCY` setting.
Final sibling leaves are dispatched in bounded parallel batches; upper pyramid
levels stay depth-first so the whole map is not queued at once.

Native A/B measurement (same twelve full-resolution tiles, seed 786433191):

| Workers | First batch, including additional worker setup | Warm batch |
|---|---:|---:|
| 1 | 1984 ms | 1752 ms |
| 4 | 1232 ms | 576 ms |

All rendered pixel hashes agreed. These are local native-worker timings, not a
browser FPS guarantee or a GitLab benchmark. Reproduce with
`npm test -- tests/terrain-worker-pool-runtime.test.ts`.

`liquid_sand` is an internal Noita physics flag, not a UI material name:

- `sand_static` (walkable ground): `cell_type="liquid"`, `liquid_sand="1"`,
  `liquid_static="1"`.
- Loose `sand`, `gunpowder`, `gold`, `copper`: `cell_type="liquid"`,
  `liquid_sand="1"`; not static ground.
- `water`, `blood`, `oil`, `acid`, `lava`: `liquid_sand="0"`.

The level-surface correction explicitly excludes **both** static ground sand and
loose powders/metals. Tests read the actual `public/data.zip` material XML, follow
inheritance, and cross-check every shader material classified as sand/powder in
the engine table. Missing flags and commented-out definitions cannot turn an
unknown material into a fluid. This classification check does not resolve the
separately documented ore-density placement mismatch.
