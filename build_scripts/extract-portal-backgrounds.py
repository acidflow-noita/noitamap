#!/usr/bin/env python3
"""Extract two interior-only, portal-free room patches from unpacked data.wak.
Read-only inputs; never execute game scripts or publish the full game archive.
Usage: NOITA_DATA_DIR=/path/to/unpacked/data python3 build_scripts/extract-portal-backgrounds.py
"""
import hashlib
import json
import os
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
DATA = Path(os.environ['NOITA_DATA_DIR'])
OUT = ROOT / 'src/portals/assets/backgrounds'
ROOMS = [
    ('eye-room', 'snowcastle/hourglass_chamber', 'snowcastle_hourglass_chamber', 'teleport_hourglass_return', False),
    ('meditation-chamber', 'excavationsite/cube_chamber', 'excavationsite_cube_chamber', 'teleport_meditation_cube_return', True),
]
OUT.mkdir(parents=True, exist_ok=True)
manifest = []
for name, scene, script, entity, has_visual in ROOMS:
    material_path = DATA / f'biome_impl/{scene}.png'
    background_path = DATA / f'biome_impl/{scene}_background.png'
    script_path = DATA / f'scripts/biomes/{script}.lua'
    material = Image.open(material_path).convert('RGBA')
    background = Image.open(background_path).convert('RGBA')
    if material.size != (512, 512) or background.size != material.size:
        raise ValueError(f'Unexpected room dimensions: {scene}')
    # Never use RGB from the material/spawn template as art, or punch holes at
    # its spawn colors. Authored background + foreground alpha defines coverage.
    # Hourglass intentionally has NO _visual (its Lua passes an empty filename).
    inputs = [material_path, background_path, script_path]
    visual_path = DATA / f'biome_impl/{scene}_visual.png'
    patch = background.copy()
    if has_visual:
        visual = Image.open(visual_path).convert('RGBA')
        if visual.size != material.size:
            raise ValueError(f'Unexpected visual dimensions: {scene}')
        patch = Image.alpha_composite(patch, visual)
        inputs.append(visual_path)
    spawn_colors = {(54, 97, 120), (0, 255, 0), (85, 175, 140), (80, 160, 240)}
    protected = []
    # The eye's purple BACKGROUND extends behind its steel_static material
    # outline (#404041). There is no missing foreground PNG: preserve the
    # already-rendered metal, and replace air + ALL spawn positions only.
    if name == 'eye-room':
        for i, pixel in enumerate(material.getdata()):
            x, y = i % 512, i // 512
            if pixel[:3] not in spawn_colors | {(0, 0, 66)}:
                patch.putpixel((x, y), (*patch.getpixel((x, y))[:3], 0))
            if pixel[:3] == (64, 64, 65):
                protected.append((x, y))
    # The meditation liquid corner remains game-state/captured liquid, not a
    # solid painting of the background texture. All spawn pixels are covered.
    for i, pixel in enumerate(material.getdata()):
        if pixel[:3] == (131, 0, 0):
            x, y = i % 512, i // 512
            patch.putpixel((x, y), (*patch.getpixel((x, y))[:3], 0))
    marker = [(i % 512, i // 512) for i, pixel in enumerate(material.getdata()) if pixel[:3] == (54, 97, 120)]
    spawn_points = [(i % 512, i // 512) for i, pixel in enumerate(material.getdata()) if pixel[:3] in spawn_colors]
    if len(marker) != 1 or any(patch.getpixel(point)[3] != 255 for point in spawn_points):
        raise ValueError(f'Spawn marker not covered with opaque clean art: {scene}')
    if any(pixel[:3] in spawn_colors and pixel[3] for pixel in patch.getdata()):
        raise ValueError(f'Spawn colors leaked into the patch: {scene}')
    mask = patch.getchannel('A')
    patch.save(OUT / f'{name}-interior.png')
    manifest.append(dict(name=name, scene=scene, entity=entity, size=list(material.size),
        portalMarker=list(marker[0]), coveredSpawnPoints=spawn_points, maskBounds=list(mask.getbbox()),
        preservedMetalPixels=len(protected), preservedMetalSamples=protected[::max(1, len(protected)//16)],
        opaquePixels=sum(1 for p in mask.getdata() if p == 255),
        alphaValues=sorted(set(mask.getdata())),
        inputs={str(p.relative_to(DATA)): hashlib.sha256(p.read_bytes()).hexdigest()
                for p in inputs},
        patchSHA256=hashlib.sha256((OUT / f'{name}-interior.png').read_bytes()).hexdigest()))
(OUT / 'sources.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(f'Extracted {len(manifest)} portal-free interior patches to {OUT}')
