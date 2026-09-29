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

**Public maps use baked pixels when available; generated maps default to the HD renderer.**
The **Render every pixel** toggle is removed from every map/view, including
localhost. The old `noitamap-gl-terrain` saved preference is ignored, and there
is no browser-console or URL opt-in to that full-resolution pyramid path. Returning users cannot accidentally remain
on the expensive live-render path just because they enabled it in an older build.

Daily and previous-daily maps still load their matching baked DZI pyramids without
live terrain rendering. If no bake is available (including arbitrary seeds and
failed/mismatched daily probes), HD renders terrain at the requested display
resolution using the GPU. **Performance → HD renderer** saves the preference
and reloads the current map and camera position. Turning it off uses approximate
terrain. GPU failures also fall back to approximate terrain. `?nb=1` explicitly
bypasses baked output; it does not enable the offline full-resolution pyramid.

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
Windows.

### Inspect a local completed bake

Start Vite with `NOITAMAP_LOCAL_BAKE=/path/to/out`, then open
`/?m=dy&se=381773&bake=local`. The seed must match the output manifest. This
explicit development-only route exercises the same baked loader as production.

## Local builds on Windows and Linux

Use Node.js 22.12 or newer, with `node` and `npm` available in your shell.
After moving a checkout between operating systems, run `npm ci` to reinstall
platform-specific dependencies, then `npm run build`. The install step also
initializes submodules at the revisions recorded by this repository.

`.gitattributes` keeps text files LF on both systems, independently of your
global `core.autocrlf` setting; Windows batch scripts use CRLF. Existing files
committed with CRLF need a one-time normalization commit. Review with
`git diff --ignore-space-at-eol` to distinguish line-ending changes from code
changes. No global Git setting needs to change.

Keep the public and private Pro checkouts on compatible revisions. Pro imports
shared report/Sage sources from the public checkout, so a newer Pro revision
can fail to build against an older public revision even when dependencies are
installed correctly.

## Local Pro development

The private Pro repository can live inside this workspace:

```bash
mkdir -p task
git clone --recurse-submodules <private-pro-repo-url> task/noitamap-pro
npm --prefix task/noitamap-pro ci
npm run dev
```

`task/noitamap-pro/` is ignored by the public repository and keeps its own Git
history. Vite prefers that checkout, and still supports the older sibling
`../noitamap-pro` layout. Restart the dev server after adding/removing a checkout.
Without either checkout, development uses the hosted Pro bundle. Production
always uses the hosted bundle, even when local Pro source exists during a build.
Pro changes must be committed and deployed from the Pro repository separately;
deploying the public app does not publish changes to Pro.
