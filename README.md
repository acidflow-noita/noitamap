# ![](https://github.com/WUOTE/noitamap/blob/main/public/assets/NoitamapLogo.png) Noitamap — [map.runfast.stream](https://map.runfast.stream)

A very _fast_ zoomable map for Noita

![image](https://github.com/WUOTE/noitamap/assets/106106310/60ef19b6-8849-4c88-950f-406a4a5f9a30)

> TLDR: This repo contains sources for a very high-resolution highly-performant map for the video game called [Noita](https://store.steampowered.com/app/881100/Noita/). Noitamap uses [OpenSeadragon](https://github.com/openseadragon/openseadragon).
This repo is basically a fork of whalehub's repo, which has been deleted from github but we had a [lucky fork](https://github.com/quiddity-wp/noita-map-viewer) with updated version of openseadragon and probably a different algo for creating the "pyramid" (zoomable) tiles.

The [map iself](https://map.runfast.stream) is being served by cloudflare pages with deployment from this repository.

We're using seed `786433191` while running map capture because it has a couple structures and secrets visible. If you find a seed with even more stuff, please open an issue!

## Contributing
Contributions and discussions are welcome, feel free to open PRs and issues.

## TBD (What I see as the next steps):
1. ~~Figuring out how to completely automate the app deployment via from a public repo using github actions (at the moment it's tricky cause I need to manually SFTP into the machine to upload and unpack the tiles) so in case something bad happens we have a 1-click deploy replacement fast.~~ — Done, pushing to the repo now triggers a github action which deploys updates directly to Fly.
2. Better map capture (no artifacts, maybe a better seed to show more structures and secrets) — if you have a good seed # for that, open an issue.
3. Layers, overlays, and points of interests — similar to the [current map on easyzoom](https://easyzoom.com/image/260463).
4. Add a section with the info on how to re-deploy the map should the instance I'm hosting break for some reason.
5. Make map capture run autonomously and deploy results automatically each time there's an update to Noita.
6. ~~Be able to see the pixel coordinates of various places on the map — suggested by pudy248. Maybe implement it as a toggable overlay?~~ -- implemented by [@dextercd]((https://github.com/dextercd)

    ![image](https://github.com/WUOTE/noitamap/assets/106106310/dcf35bf6-036c-4145-b07b-31bd7b9a45b8)


## Thanks
Huge thanks to [@Dadido3](https://github.com/Dadido3) and [@myndzi](https://github.com/myndzi) for their work, their help, and advice! Thanks to [Arganvain](https://www.twitch.tv/arganvain) for fixing the logo I initially made.
