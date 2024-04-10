# ![NoitamapLogo](https://github.com/acidflow-noita/noitamap/assets/106106310/8d744876-be6f-479c-8bed-09257a07a08a) Noitamap — [map.runfast.stream](https://map.runfast.stream)

Blazing-_fast_ zoomable map for Noita

![Map demo](https://github.com/acidflow-noita/noitamap/assets/106106310/94e0fb7e-4e0f-4419-9c14-38cace15efee)

> TLDR: This repo contains sources for a very high-resolution highly-performant map for the video game called [Noita](https://store.steampowered.com/app/881100/Noita/). Noitamap uses [OpenSeadragon](https://github.com/openseadragon/openseadragon).
This repo is basically a fork of whalehub's repo, which has been deleted from github but we had a [lucky fork](https://github.com/quiddity-wp/noita-map-viewer) with updated version of openseadragon and probably a different algo for creating the "pyramid" (zoomable) tiles.

The [map iself](https://map.runfast.stream) is being served by cloudflare pages with deployment from this repository.

We're using seed `786433191` while running map capture because it has a couple structures and secrets visible. If you find a seed with even more stuff, please open an issue!

## I want to help, what can I do?
If you're a **developer**, contributions and discussions are welcome, feel free to open PRs and issues, take a look at the [project]([url](https://github.com/orgs/acidflow-noita/projects/1)) to see what work is being done.  

If you're a **player**, you can help by capturing a new version of one of the game modes, or mods (maps with significant changes over time have date indication on the website), then stitch the map and upload an archive with what you've got to a sharing service like google drive, pixeldrain, gofile, etc, then opening an issue.

### How to capture a map
Download the latest release from the [noita-mapcap](https://github.com/Dadido3/noita-mapcap/releases/latest), unpack it and move the `noita-mapcap` directory into your noita mods folder.
To navigate to your mods folder either open the mods directory from inside the game by pressing `Mods`-->`Open mod folder`, or opening this directory:
```powershell
C:\Program Files (x86)\Steam\steamapps\common\Noita\mods\
```
![Opening mod folder from inside the game](https://github.com/acidflow-noita/noitamap/assets/106106310/fa071095-1129-4c1f-bfae-702138ce4ba0)

Before starting the map capture process, check that all the mod settings are correct: use `3 Worlds` capturing mode with `60 frames` capture delay and seed set to `786433191`, all the settings should look exactly like on this screenshot excep for specific non-standard map sizes mods like alternative biomes.
![Noita-mapcap settings](https://github.com/acidflow-noita/noitamap/assets/106106310/44d0b8b9-89f8-45d6-9f76-5eb9d65c14b7)


### How to stitch a map
1. Navigate to the `Stitcher` directory, its location is:
```powershell
C:\Program Files (x86)\Steam\steamapps\common\Noita\mods\noita-mapcap\bin\stitch
```
2. Right click inside this directory and select "`Open in Terminal`"
![Launching Terminal](https://github.com/acidflow-noita/noitamap/assets/106106310/a46f1d51-53bc-4b2c-b3a2-799388e0c558)

4. Copy the following command and paste it into the terminal (either `Ctrl+V` or `Mouse right click`), **Do not run the command yet**, you will need to rename the output files following the naming convention: `gamemode-branch-world-patchDate-seedNumber.dzi` (e.g. `regular-main-branch-left-pw-2024-04-08-78633191.dzi`)

```powershell
.\stitch.exe --output nightmare-main-branch-left-pw-2024-04-08-78633191.dzi --blend-tile-limit 1 --dzi-tile-size 512 --xmin -53760 --xmax -17408 --ymin -31744 --ymax 41984 --webp-level 9 && .\stitch.exe --output nightmare-main-branch-middle-2024-04-08-78633191.dzi --blend-tile-limit 1 --dzi-tile-size 512 --xmin -17920 --xmax 18432 --ymin -31744 --ymax 41984 --webp-level 9 && .\stitch.exe --output nightmare-main-branch-right-pw-2024-04-08-78633191.dzi --blend-tile-limit 1 --dzi-tile-size 512 --xmin 17920 --xmax 53760 --ymin -31744 --ymax 41984 --webp-level 9
```
4. This will launch the stitcher and after it finishes you will see next to the `stitch.exe` 3 new directories (`gamemode-branch-world-patchDate-seedNumber_files`), and 3 new files (`gamemode-branch-world-patchDate-seedNumber.dzi`).

### How to share the capture results to get them added to Noitamap
1. Make a new directory `gamemode-branch-world-patchDate` and move the stitching results to it, then compress it as `.7z` with the maximum compression level (`9`) then upload it to a file sharing service.
2. Open a new issue with the `new-map-capture` label, post the link.

## Thanks
Huge thanks to [@Dadido3](https://github.com/Dadido3), [@myndzi](https://github.com/myndzi), and [@dextercd](https://github.com/dextercd) for their work, their help, and advice! Thanks to [Arganvain](https://www.twitch.tv/arganvain) for fixing the logo I initially made, thanks to discord user wand_despawner for capturing several maps, thanks to discord user hey_allen for providing storage space for the map tiles' disaster recovery, thanks to discord user Bohnenkrautsaft for the suggestion to add map loading indicator and refactoring of the indicator's code.
