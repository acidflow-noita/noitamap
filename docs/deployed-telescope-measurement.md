# Deployed Telescope measurement — 2026-09-27

The deployed [Telescope site](https://noita-telescope.obsoleet.org/?seed=daily&ng=0) was actually opened and measured in Chromium, with **Render Everything (no zoom LOD) enabled before initialization**. The checkbox and exported `appSettings.renderEverything` were both verified. The served `app.js`, terrain shaders, scene renderer and pixel-scene module matched the checked-out vitaminmoo revision `fa9cd25d902f04b234896716eca3ba52b2d11856` byte for byte. The page still displays “Lymm's Telescope”; that title does not identify the deployed code revision.

## Conditions and observed startup

Two separate fresh browser processes and contexts; Chromium 148.0.7778.96; 1280×900 window, device scale 1. This Linux VM exposes a Ryzen 9 7950X CPU, 16 logical CPUs and 31.3 GiB RAM. Rendering used **ANGLE SwiftShader**, explicitly selected software rendering, with an 8192 maximum texture dimension. These are not measurements of a phone, integrated GPU or desktop GPU.

All HTTPS connections, including workers, passed through one encrypted CONNECT tunnel with an aggregate 100 Mb/s token bucket, 256 KiB maximum burst, and 15 ms added delay in each direction. Actual internet latency is additional. Local TCP calibration measured 98.92 Mb/s for one 16 MiB transfer and 99.50 Mb/s aggregate for two parallel transfers. This approximates the requested bandwidth with **30 ms added latency**, not an exact 30 ms total WAN RTT. TLS was not intercepted.

| Milestone from navigation | Fixed seed 786433191 | Daily, resolved 191452512 |
| --- | ---: | ---: |
| App's own generation duration, excluding preceding startup | 0.665 s | 0.674 s |
| DOM status changes to `Done (PW 0, 0)` | 3.764 s | 4.281 s |
| First terrain GL draw submission | 4.184 s | 4.747 s |
| First populated `drawNow()` returns | 5.043 s | 5.768 s |
| First screenshot capture observed complete | 7.794 s | 8.651 s |
| Initial camera: pending-zero/quiet sample plus canvas readback | 33.954 s | 31.732 s |

Draw submission and method return are not GPU presentation timestamps. The screenshot demonstrates visible terrain by its capture time, with automation overhead. Both initial frames ended with **80 scene requests pending**. The last row is also **not final viewport completion**: another 192 / 204 scene requests appeared during the following screenshot interval before the camera changed. `asyncRenderPending()` omits scheduled scene requery/upload work; a future completion probe must also account for `sceneRedrawTimer`, `drawScheduled`, atlas upload/requery state and GPU completion. No complete nine-region generation milestone occurred.

## What Render Everything actually does

[The app](../lib/noita-telescope-vm/js/app.js) returns `Infinity` from `detailZoom()` under this option. It requests level-zero scene images, keeps material textures and backdrop detail enabled at overview zoom, and raises the scene budget to at least 2 GiB. It does **not** increase the terrain framebuffer to the number of visible native world pixels. Recorded terrain views remained **939×900 = 845,100 pixels**, initially at zoom 0.0625; each screen pixel spans 16×16 world pixels. Material textures were verified enabled in these recorded overview calls. [The shader](../lib/noita-telescope-vm/js/gl/shaders.js) still resolves terrain at screen-fragment coordinates.

The option also leaves [edge decals' zoom ≥ 1 gate](../lib/noita-telescope-vm/js/edge_decal_layer.js) intact. Other settings retained site defaults: engine terrain and edge decals enabled, legacy Render Edge Noise disabled, Custom Art/Atmosphere/Alpha Mask layer toggles disabled. Render Edge Noise controls the legacy overlay-boundary path; it is not a switch disabling the engine resolver's noise. Thus “Render Everything” is not synonymous with every layer enabled or every native pixel finished.

The site **does generate POIs and draw their markers**: the initial central world contained 724 / 776 POIs and 3,468 / 3,635 scene placements. Comparing this to the host must account separately for the host's authored POI sprites and tile baking. Initial recorded world extent was only `0,0`; the overview cycle later included `0,-1`. [Bounds checking](../lib/noita-telescope-vm/js/app.js) requests worlds as they enter view. This is not all nine regions.

## Returning to the same detailed camera

The cycle used display coordinates `(17920,8192)`, corresponding to world `(0,1024)`, at zoom `1 → 0.04 → 1`. On return:

| Observation | Fixed seed | Daily |
| --- | ---: | ---: |
| Return request to `drawNow()` start | 773.5 ms | 748.1 ms |
| `drawNow()` wall duration | 1.1 ms | 1.4 ms |
| Terrain viewport renders | 1 | 1 |
| Scene requests before → after return | 1177 → 1177 | 1029 → 1029 |
| Scene cache at end | 448.6 MiB | 434.3 MiB |

Both runs had zero scene evictions/refetches, and the returned canvas SHA-256 matched its earlier detailed canvas exactly. There were 224 / 256 additional overview scene requests during the overview screenshot interval **before** returning. The return itself reused those inputs and reran the terrain shader; it did not retrieve a retained final terrain image.

The whole return probe took 10.119 / 10.227 s, including polling/quiet checks, browser scheduling, canvas readback and hashing. Those intervals were not separately instrumented, so this number is neither a precise input-to-presentation latency nor a measured shader execution time. The short JavaScript draw duration likewise does not establish short GPU completion time.

## Downloads and startup dependencies

Recorded response totals were **18.893 / 18.894 MB**; the tunnel received **18.956 / 18.961 MB** of encrypted downstream traffic over the entire camera exercise. Roughly 13.38 MB of recorded responses had completed by the first `Done` status. Decoded `Network.dataReceived` totals are incomplete for binary responses; main-page ResourceTiming reported 18.36 MB decoded bodies but does not cover all worker traffic. These figures must not be substituted for decoded pixel memory.

The fixed-seed trace shows these dependencies and transfers; times below are relative to the document request:

| Resource | Approximate response bytes | Request → complete |
| --- | ---: | ---: |
| Wang archive | 0.860 MB | 1.347 → 1.516 s |
| Biome-map archive | 3.151 MB | 1.347 → 1.689 s |
| Translations | 1.537 MB | 1.846 → 2.055 s |
| Weather archive | 1.268 MB | 1.853 → 2.139 s |
| Background archive | 1.253 MB | 1.853 → 2.208 s |
| Material atlas | 4.396 MB | 2.506 → 2.881 s |
| Pixel-scene archive | 5.101 MB | 3.760 → 4.231 s |

ES-module imports and the external jsDelivr PNG/inflate/ZIP dependencies precede these downloads. Scene image work continues after the app's generation status. This supports removing serial startup dependencies and unrelated assets in the host; it does not establish an apples-to-apples performance comparison with the host's native Mesa tests.

## Reproduction and artifacts

[The script](../build_scripts/measure-deployed-telescope.mjs) records protocol **4**; [the compact results](deployed-telescope-measurement.json) include settings, hashes, milestones and request groups. No dependency was added. With the repository's existing Playwright installation and Chromium headless shell:

```sh
export PATH=/home/w/.nvm/versions/node/v26.10.0/bin:$PATH
export PLAYWRIGHT_BROWSERS_PATH=/tmp/noitamap-playwright
node build_scripts/measure-deployed-telescope.mjs --calibrate
node build_scripts/measure-deployed-telescope.mjs 786433191 daily
```

Local raw evidence: [fixed JSON](../task/instant-map/deployed/everything-786433191-1790542500199.json), [daily JSON](../task/instant-map/deployed/everything-daily-1790542587642.json), [verified checkbox screenshot](../task/instant-map/deployed/everything-786433191-1790542500199-control.png), [initial overview](../task/instant-map/deployed/everything-786433191-1790542500199-initial-settled.png), [returned detail](../task/instant-map/deployed/everything-786433191-1790542500199-return-detail.png). Raw artifacts are in the ignored task directory. There were no page errors in either recorded run.

Earlier default-LOD runs and the first ON pilot used different or incomplete network shaping and are excluded from these tables. Two seeds are exploratory observations, not a statistical latency distribution. Only the explicitly authorized deployed site was browser-tested; the local app was not.
