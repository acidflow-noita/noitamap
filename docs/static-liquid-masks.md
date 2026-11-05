The captured-base liquid mask is generated offline from material instructions,
not the rendered map's colors. `src/liquids/static-sources.json` identifies the
capture, source files, placements, reviewed hashes, and known coverage gaps.
`src/liquids/assets/static-mask.bin.gz` contains sparse native-resolution row runs
in blocks of at most 512 by 512 world pixels. Loading the artifact does not need
Telescope generation, the game data archive, or scene image decoding. Gzip
decompression and run decoding can happen in the small mask worker on demand.

Rebuild with `node --import tsx build_scripts/build-static-liquid-masks.mts`.
The build refuses changed source hashes. After reviewing the material geometry,
`--refresh-provenance` accepts the new source checks and rebuilds the artifact.
The shared `liquidMaterialIds` classifier includes liquid cells whose inherited
`liquid_sand` is false, including lava. Glow and graphics alpha are not exclusion
criteria.

The filename says seed 78633191, but the clean captured base matches seed
786433191. Six inspected main-world basin images establish this distinction:
an empty basin at (-1536,984), blood at (-1024,984), oil at (512,984), toxic sludge
at (-1024,2520) and (0,4568), and oil at (0,8152). The manifest records the tile
names. Six further images downloaded from the left and right captured tile
sources confirm oil, blood, lava, and water basins at their absolute parallel-world
coordinates. Their URLs and SHA-256 hashes are recorded beside the main-world
checks. The source Lua places lower Holy Mountain rooms at chunk y + 260. The
scanner's older +256 approximation must not be used for these masks.

| Source family | Material geometry and placement |
| --- | --- |
| Holy Mountains | Original altar and basin PNGs, fixed biome cells, capture-seeded basin selection, top y - 40 and lower y + 260 |
| Lake and statue island | Native topology-0 lake surface, generated topology-2 deep-water Wang lattice, then the original statue splice at (-14848,0) |
| Lava Lake, pond, tree, Laboratory | Original spliced material images at their source world origins |
| Secret Lab, orb rooms, meditation chamber, teleport room, racetrack | Original material PNGs placed at their biome-map cells |
| Sky temples and Watchtower | Original coarse templates resolved by the native topology-2 material engine, including density-band materials |
| Volcanic lava and robot egg | Native constant lava and the authored volcanic surface polygon, with later scene solids and force air removing coverage |
| Pyramid spawned scenes | Capture-seed marker scanning emits 42 left and 54 right stone stair scenes across the three worlds; these contain no eligible fluid pixels |
| Buried-eye and hourglass chambers | Original images contain ice, snow, steel, and stone, with no initial eligible fluid pixels |

The source placement order matters. The build resolves static terrain, applies
spliced material images, then biome scenes and fixed scenes. A solid or force-air
pixel erases prior liquid coverage. Transparent and black source pixels leave
the prior material intact. Gray density pixels use the engine material bands;
color substitutions happen before material classification. This avoids a union
of fluid masks extending through overlapping stone or authored room air.

The volcanic lake's `lava_90percent.xml` defines a full-width lava rectangle
from normalized chunk y = 0.02 to 1. The general native terrain resolver drops
polygon bands, so this build reads that exact authored polygon separately.
The original executable samples integer world coordinates modulo 512, then
divides by 512 without a half-pixel offset (`0x0086d325` through `0x0086d378`).
Its polygon test (`0x00ddc9a0`) excludes the left/top edge and includes the
right/bottom edge. The authored rectangle therefore paints local x = 1 through
511 and y = 11 through 511. These exact boundaries are tested. The large
Laboratory splice covers part of the same region and does not replace the rest
of the volcanic surface source. The binary digest and instruction evidence are
recorded in the manifest and [native evidence](liquid-refraction-evidence.md).

Pyramid room placement is now checked through the same native-source marker
scanner. This capture emits only the two stone stair templates. Its possible
lava-room selector has no matching generated markers, and the old
`pyramid/reward.png` is an unused asset, not a missing radioactive pool.

The asset describes source generation and does not claim complete capture-state
reconstruction. Liquid movement, reactions, melting/freezing, and entity contents
after generation require capture-state material evidence. Those are remaining
state uncertainties, not omitted source-liquid regions. Other capture identities,
NG+, Nightmare, and mods need separate manifests.

The Dark Cave is intentional: the clean base has only its backdrop and static
edge splice. Its selected water layout is painted for the active seed and must
come from the live or daily material mask. Likewise, live terrain and scene
replacements must take precedence over this captured-base artifact.
