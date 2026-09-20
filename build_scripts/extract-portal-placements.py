#!/usr/bin/env python3
"""Read-only extraction from unpacked data.wak. NOITA_DATA_DIR must be explicit.
No game scripts execute. Each marker has a reviewed Lua spawn-function mapping.
The generated file is shipped; normal builds never need the sibling repository.
"""
import hashlib, json, os, re
from pathlib import Path
from PIL import Image
import xml.etree.ElementTree as ET
ROOT = Path(__file__).resolve().parents[1]
DATA = Path(os.environ['NOITA_DATA_DIR'])
recipes, inputs = [], {}
def read(path):
    data = (DATA / path).read_bytes()
    inputs[path] = hashlib.sha256(data).hexdigest()
    return data

def recipe(keys, image, mappings, script, biomes=()):
    read(script)
    pixels = Image.open(DATA / image).convert('RGBA')
    read(image)
    points=[]
    for y in range(pixels.height):
        for x in range(pixels.width):
            r,g,b,a=pixels.getpixel((x,y))
            match=mappings.get((r<<16)|(g<<8)|b) if a==255 else None
            if match:
                entity,dx,dy,condition=match
                points.append({'entity':entity,'x':x+dx,'y':y+dy,'condition':condition})
    if not points: raise ValueError(f'No portal markers in {image}')
    recipes.append({'keys':keys,'biomes':list(biomes),'image':image,'script':script,'points':points})

normal=('teleport_liquid_powered',0,-4,'liquid')
for variant in ['', '_water', '_blood', '_oil', '_radioactive', '_lava']:
    recipe(['temple/altar_top'+variant], 'biome_impl/temple/altar_top'+variant+'.png',
           {0xbf26a6:normal}, 'scripts/biome_scripts.lua')
recipe(['temple/altar_top_ending'], 'biome_impl/temple/altar_top_ending.png',
       {0xbfcaa6:('teleport_ending',0,-4,'liquid')}, 'scripts/biomes/temple_wall_ending.lua')
recipe(['general/teleportroom'], 'biome_impl/teleroom.png',
       {0xa9d024+i*0x100000:(f'teleport_teleroom_{i+1}',0,0,'leviathan-unlock') for i in range(6)},
       'scripts/biomes/teleroom.lua', [0x5f8fab])
for keys,image,entity,biome,script in [
    (['general/cube_chamber','excavationsite/cube_chamber'],'excavationsite/cube_chamber','teleport_meditation_cube_return',0x24888a,'excavationsite_cube_chamber'),
    (['general/secret_chamber','snowcave/secret_chamber'],'snowcave/secret_chamber','teleport_snowcave_buried_eye_return',0x18a0d6,'snowcave_secret_chamber'),
    (['general/hourglass_chamber','snowcastle/hourglass_chamber'],'snowcastle/hourglass_chamber','teleport_hourglass_return',0x18d6d6,'snowcastle_hourglass_chamber'),
]:
    recipe(keys,'biome_impl/'+image+'.png',{0x366178:(entity,0,0,'return')},'scripts/biomes/'+script+'.lua',[biome])
recipe(['snowcave/buried_eye'],'biome_impl/snowcave/buried_eye.png',
       {0x366178:('teleport_snowcave_buried_eye',0,0,'liquid')},'scripts/biomes/snowcave.lua')
for side in ['left','right']:
    recipe(['snowcastle/side_cavern_'+side,'snowcastle_cavern/side_cavern_'+side],
           'biome_impl/snowcastle/side_cavern_'+side+'.png',
           {0xff9122:('teleport_hourglass',0,0,'hourglass')},'scripts/biomes/snowcastle_cavern.lua')
recipe(['general/mystery_teleport'],'biome_impl/mystery_teleport.png',
       {0x31d0b4:('mystery_teleport',0,0,'always')},'scripts/biomes/mystery_teleport.lua',[0x157cb7])
recipe(['general/robot_egg'],'biome_impl/robot_egg.png',
       {0x548f77:('teleport_robot_egg_return',0,0,'return')},'scripts/biomes/robot_egg.lua',[0x9e4302])
# A shared essenceroom image is not sufficient to identify the Tower. Restrict
# this rule to its actual biome, rather than putting portals in all essence rooms.
recipe([], 'biome_impl/essenceroom.png', {0x31d0b4:('mystery_teleport_back',0,-200,'always')},
       'scripts/biomes/tower_end.lua',[0x3d3e41])
# Some older scene metadata uses the material-less visible cube image. The
# actual portal entity is above the cube, NOT at its click-target center.
read('scripts/biomes/excavationsite.lua')
recipes.append({'keys':['excavationsite/meditation_cube_visual','excavationsite/meditation_cube'],
 'biomes':[], 'script':'scripts/biomes/excavationsite.lua',
 'points':[{'entity':'teleport_meditation_cube','x':20,'y':-41,'condition':'meditation'}]})

# Native-only chunk scenes: Telescope omits some of these from its scene list.
all_biomes=ET.fromstring(read('biome/_biomes_all.xml'))
for stem,entity in [('smokecave_left','teleport_smokecave'),('sandroom','teleport_sandroom')]:
    colors=[int(e.get('color','0'),16)&0xffffff for e in all_biomes.iter() if e.get('biome_filename')=='data/biome/'+stem+'.xml']
    recipe(['general/'+stem], 'biome_impl/'+stem+'.png',
           {0xbf262b:(entity,0,0,'always')}, 'scripts/biomes/'+stem+'.lua', colors)
# These two material pictures contain no portal marker in the supplied game
# data. Do not manufacture the portals from a filename or an XML default target.

entities={}
for p in sorted((DATA/'entities/buildings').glob('*teleport*.xml')):
    r=ET.fromstring(read(str(p.relative_to(DATA))))
    t=next(r.iter('TeleportComponent'),None)
    if t is None: continue
    entities[p.stem]={'source':str(p.relative_to(DATA)), 'target':dict(t.attrib)}
placed={p['entity'] for r in recipes for p in r['points']}
placed.update(['teleport_liquid_powered','teleport_ending'])
result={'version':1,'recipes':recipes,'entities':entities,
        'notPlaced':{key:('runtime/player event or unverified spawn anchor; XML destination is not a spawn position') for key in entities if key not in placed},
        'sourceHashes':inputs}
(ROOT/'src/portals/placements.json').write_text(json.dumps(result,indent=2)+'\n')
print(f'{len(recipes)} reviewed scene rules; {len(placed)} entity types placed; {len(result["notPlaced"])} explicitly unplaced.')
