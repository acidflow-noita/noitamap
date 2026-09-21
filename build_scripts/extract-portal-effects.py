#!/usr/bin/env python3
"""Compile the inspected Noita XML + PNG subset, not the old hand-tuned JS config.
Requires Pillow and the user's extracted task/data (not shipped). Output is deterministic.
"""
import argparse
import os
import copy
import hashlib
import json
import re
import struct
import xml.etree.ElementTree as ET
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
DATA = Path(os.environ['NOITA_DATA_DIR'])
OUT = ROOT / 'src/portals/assets'
ASSETS, IMAGES, MATERIALS, WARNINGS = {}, {}, {}, []
BINARY = bytearray()

def parse(path):
    text = (DATA / path.removeprefix('data/')).read_text(encoding='utf-8-sig')
    try:
        return ET.fromstring(text)
    except ET.ParseError as error:
        # Some shipped definitions (image_explosion) contain duplicate attributes.
        # Record this ambiguity; use the final declaration, not the old JS value.
        if 'duplicate attribute' not in str(error):
            raise
        WARNINGS.append({'source': path, 'warning': 'Duplicate XML attribute: final declaration retained.'})
        def repair(match):
            tag = match.group(0)
            names = set()
            matches = list(re.finditer(r'([\w.:-]+)\s*=\s*"[^"]*"', tag))
            for m in reversed(matches):
                if m[1] in names:
                    tag = tag[:m.start()] + tag[m.end():]
                names.add(m[1])
            return tag
        return ET.fromstring(re.sub(r'<[^!?][^>]*>', repair, text))

def components(path, chain=()):
    if path in chain:
        raise ValueError('Cyclic entity inheritance: ' + path)
    return resolve_components(parse(path), chain + (path,))

def resolve_components(root, chain=()):
    result = []
    for base in root.findall('Base'):
        inherited = components(base.get('file'), chain)
        for override in base:
            matches = [c for c in inherited if c.tag == override.tag]
            if override.get('_remove_from_base') == '1':
                inherited = [c for c in inherited if c.tag != override.tag]
            elif matches:
                matches[0].attrib.update(override.attrib)
            else:
                inherited.append(copy.deepcopy(override))
        result += inherited
    result += [copy.deepcopy(c) for c in root if c.tag != 'Base']
    return result

def visual_components(nodes, x=0, y=0, depth=0):
    result = []
    for node in nodes:
        if node.tag == 'Entity':
            children = resolve_components(node)
            inherit = next((c for c in children if c.tag == 'InheritTransformComponent'), None)
            transform = inherit.find('Transform') if inherit is not None else None
            tx = float(transform.get('position.x', 0)) if transform is not None else 0
            ty = float(transform.get('position.y', 0)) if transform is not None else 0
            if transform is not None and float(transform.get('rotation', 0)) != 0:
                raise ValueError('Rotated child transform needs explicit support')
            result += visual_components(children, x + tx, y + ty, depth + 1)
        else:
            c = copy.deepcopy(node)
            c.set('_entity_x', str(x)); c.set('_entity_y', str(y)); c.set('_entity_depth', str(depth))
            result.append(c)
    return result

def image(path):
    if path not in ASSETS:
        im = Image.open(DATA / path.removeprefix('data/')).convert('RGBA')
        raw = im.tobytes()
        ASSETS[path] = {'offset': len(BINARY), 'length': len(raw), 'width': im.width, 'height': im.height,
            'sha256': hashlib.sha256(raw).hexdigest()}
        BINARY.extend(raw)
    return path

def sprite(path, attrs=None):
    attrs = attrs or {}
    if path.endswith('.xml'):
        root = parse(path)
        anims = root.findall('RectAnimation')
        default = attrs.get('rect_animation') or root.get('default_animation')
        anim = next((a for a in anims if a.get('name') == default), anims[0] if anims else None)
        file = image(root.get('filename'))
        a = anim.attrib if anim is not None else {}
        return {'asset': file, 'width': int(a.get('frame_width',ASSETS[file]['width'])),
            'height': int(a.get('frame_height',ASSETS[file]['height'])), 'frames': int(a.get('frame_count',1)),
            'wait': float(a.get('frame_wait',.1)), 'perRow': int(a.get('frames_per_row',1)),
            'posX': int(a.get('pos_x',0)), 'posY': int(a.get('pos_y',0)), 'loop': a.get('loop','1')=='1',
            'offsetX': float(root.get('offset_x',0)) + float(attrs.get('offset_x',0)),
            'offsetY': float(root.get('offset_y',0)) + float(attrs.get('offset_y',0)),
            'additive': attrs.get('additive','0')=='1', 'alpha': float(attrs.get('alpha',1)), 'zIndex': float(attrs.get('z_index',0)),
            'entityX': float(attrs.get('_entity_x',0)), 'entityY': float(attrs.get('_entity_y',0))}
    file = image(path)
    return {'asset': file, 'width': ASSETS[file]['width'], 'height': ASSETS[file]['height'], 'frames': 1,
        'wait': .1, 'perRow': 1, 'posX': 0, 'posY': 0, 'loop': True,
        'offsetX': float(attrs.get('offset_x',ASSETS[file]['width']/2)),
        'offsetY': float(attrs.get('offset_y',ASSETS[file]['height']/2)),
        'additive': attrs.get('additive','0')=='1', 'alpha': float(attrs.get('alpha',1)), 'zIndex': float(attrs.get('z_index',0)),
            'entityX': float(attrs.get('_entity_x',0)), 'entityY': float(attrs.get('_entity_y',0))}

def image_animation(path):
    if path not in IMAGES:
        im = Image.open(DATA / path.removeprefix('data/')).convert('RGBA')
        # Native loader 0x00bc6aa0: nonzero R only, G is the time bucket; A/B
        # are NOT the inclusion test. R becomes emission probability.
        points = [(g,y,x,r) for y in range(im.height) for x in range(im.width)
            for r,g,b,a in [im.getpixel((x,y))] if r != 0]
        points.sort()  # Native ties may differ; per-bucket geometry/probability is preserved.
        offset = len(BINARY)
        for g,y,x,r in points:
            BINARY.extend(struct.pack('<hhBB',x*2-im.width,y*2-im.height,r,g))
        IMAGES[path] = {'offset':offset,'count':len(points),'stride':6,'width':im.width,'height':im.height,
            'maxTime':max((p[0] for p in points),default=0)}
    return path

MATERIAL_XML = {c.get('name'): c for c in parse('data/materials.xml') if c.get('name')}
def material(name):
    if name not in MATERIALS:
        c = MATERIAL_XML[name]
        parent = material(c.get('_parent')) if c.get('_parent') else {'color':0xffffffff,'glow':0}
        gfx = c.find('Graphics')
        color = gfx.get('color') if gfx is not None else None
        MATERIALS[name] = {'color':int(color,16) if color else (int(c.get('wang_color'),16) if not c.get('_parent') and c.get('wang_color') else parent['color']),
            'glow':int(c.get('gfx_glow',parent['glow'])), 'cellType':c.get('cell_type',parent.get('cellType','liquid'))}
    return MATERIALS[name]

def emitter(c):
    a=c.attrib
    def n(k,d=0): return float(a.get(k,d))
    def b(k,d=False): return a.get(k,'1' if d else '0')=='1'
    mat=a.get('emitted_material_name','blood');material(mat)
    out={'entityX':n('_entity_x'),'entityY':n('_entity_y'),'material':mat,'countMin':int(n('count_min',1)),'countMax':int(n('count_max',3)),
        'intervalMin':int(n('emission_interval_min_frames',5)), 'intervalMax':int(n('emission_interval_max_frames',10)),
        'lifeMin':n('lifetime_min',5),'lifeMax':n('lifetime_max',10),
        'radiusMin':n('area_circle_radius.min'),'radiusMax':n('area_circle_radius.max'),
        'sector':n('area_circle_sector_degrees',360), 'vxMin':n('x_vel_min'),'vxMax':n('x_vel_max'),
        'vyMin':n('y_vel_min'),'vyMax':n('y_vel_max'), 'speed':n('velocity_always_away_from_center'),
        'gx':n('gravity.x'),'gy':n('gravity.y',200), 'force':n('airflow_force'),'scale':n('airflow_scale',1),
        'friction':n('friction'),'attractor':n('attractor_force'), 'direction':n('direction_random_deg'),
        'offsetX':n('offset.x'),'offsetY':n('offset.y'),'xMin':n('x_pos_offset_min'),'xMax':n('x_pos_offset_max'),
        'yMin':n('y_pos_offset_min'),'yMax':n('y_pos_offset_max'),'fade':b('fade_based_on_lifetime'),
        'drawLong':b('draw_as_long'),'onGrid':b('render_on_grid'),'back':b('render_back',True),
        # ParticleEmitterComponent +0x66: native constructor defaults to true.
        'collideWithGrid':b('collide_with_grid',True),
        'alpha':n('custom_alpha',-1),'singleWidth':b('particle_single_width',True),'ultrabright':b('render_ultrabright'),
        'chance':int(n('emission_chance',100)),'delay':int(n('delay_frames')),
        'endFrame':int(n('emitter_lifetime_frames',-1))}
    if 'image_animation_file' in a:
        out.update(image=image_animation(a['image_animation_file']),imageSpeed=n('image_animation_speed',1),
            imageLoop=b('image_animation_loop',True),imagePhase=n('image_animation_phase'),
            imageProbability=n('image_animation_emission_probability',1))
    return out

def sprite_emitter(c):
    a=dict(c.attrib);path=a['sprite_file']
    match=re.search(r'\$\[(\d+)-(\d+)\]',path)
    paths=[path[:match.start()]+str(i)+path[match.end():] for i in range(int(match[1]),int(match[2])+1)] if match else [path]
    a['sprites']=[sprite(p) for p in paths]
    return a

# All former main-page effects. The priority three still use their verified implementation.
GAME = {
 'red_portal': ('Red portal','buildings/teleport_ending.xml'),
 'evil_eye': ('Evil Eye','items/pickup/evil_eye.xml'),
 'orb_of_power': ('Orb of Power','items/orbs/orb_00.xml'),
 'dark_sun': ('Dark Sun','items/pickup/sun/newsun_dark.xml'),
 'moon': ('Moon','items/pickup/moon.xml'),
 'treasure_chest': ('Treasure chest','items/pickup/chest_random_super.xml'),
 'perk_reroll': ('Perk reroll','items/pickup/perk_reroll.xml'),
}
IMAGE = {
 'img_heart': ('Heart pickup','heart_effect'), 'img_chest': ('Chest effect','chest_effect'),
 'img_orb': ('Orb pickup','orb_effect'), 'img_wand': ('Wand pickup','wand_effect'),
 'img_potion': ('Potion pickup','potion_effect'), 'img_spell_refresh': ('Spell refresh','spell_refresh_effect'),
 'img_hourglass': ('Hourglass image animation',None), 'img_heart_fullhp': ('Full-health heart','heart_fullhp_effect'),
 'img_chest_bad': ('Bad chest','chest_effect_bad'), 'img_acid_gas': ('Acid gas cloud','acid_gas'),
 'img_altar_curse': ('Altar curse symbol','altar_tablet_curse_symbol'),
 'img_magical_symbol': ('Magical symbol','magical_symbol'), 'img_magical_symbol_fast': ('Magical symbol · fast','magical_symbol_fast'),
 'img_perk_effect': ('Perk pickup','perk_effect'), 'img_perk_pacifist': ('Pacifist perk','perk_effect_pacifist'),
 'img_player_disappear_right': ('Player disappear · right','player_disappear_effect_right'),
 'img_player_disappear_left': ('Player disappear · left','player_disappear_effect_left'),
 'img_safe_haven': ('Safe haven','safe_haven_buildup'), 'img_shop_effect': ('Shop item effect','shop_effect'),
 'img_transmutation': ('Transmutation','transmutation_effect'), 'img_image_explosion': ('Image explosion','image_explosion'),
}

# Isolated adaptation of noita_particle_animations/tools/build_effects.py.
# Export actual portal visuals only. XML target/activation components do not
# affect visual equivalence; the three script-driven effects keep the upstream
# verified PortalSimulation implementation at atlas-build time.
GAME = {}
for path in sorted((DATA / 'entities/buildings').glob('*teleport*.xml')):
    relative = 'data/entities/buildings/' + path.name
    if any(c.tag == 'TeleportComponent' for c in components(relative)):
        GAME[path.stem] = (path.stem, 'buildings/' + path.name)
IMAGE = {}

def build():
    effects={}
    for key,(label,path) in list(GAME.items()) + [(k,(v[0],('particles/image_emitters/'+v[1]+'.xml') if v[1] else 'buildings/hourglass_master.xml')) for k,v in IMAGE.items()]:
        source='data/entities/'+path; cs=visual_components(components(source))
        if key=='orb_of_power':
            cs=[c for c in cs if c.tag!='SpriteComponent' or not any(t in c.get('_tags','').split(',') for t in ('orb_discovered','orb_picked'))]
        emitters=[emitter(c) for c in cs if c.tag=='ParticleEmitterComponent' and (c.get('emit_cosmetic_particles')=='1' or c.get('emit_real_particles')=='1' or c.get('create_real_particles')=='1')]
        sprites=[sprite(c.get('image_file'),c.attrib) for c in cs if c.tag=='SpriteComponent' and c.get('image_file') and c.get('is_text_sprite')!='1' and (c.get('_enabled')!='0' or c.get('_entity_depth')=='0')]
        if not sprites and key not in IMAGE:
            for c in cs:
                if c.tag=='PhysicsImageShapeComponent' and c.get('image_file'):
                    sprites.append(sprite(c.get('image_file'),c.attrib))
        sprites.sort(key=lambda s:s['zIndex'],reverse=True)
        # Image emitters have no item sprite: the colored PNG is a program, NOT artwork to render.
        end = next((int(c.get('lifetime')) for c in cs if c.tag=='LifetimeComponent' and c.get('lifetime')), -1)
        effects[key]={'label':label,'source':source,'group':'images' if key in IMAGE else 'objects','emitters':emitters,
            'sprites':sprites,'spriteEmitters':[sprite_emitter(c) for c in cs if c.tag=='SpriteParticleEmitterComponent'],
            'lifetime':end,'notes':'Air-only; gameplay scripts/world interactions excluded.'}
        if key=='img_hourglass': effects[key]['emitters']=[e for e in emitters if 'image' in e]
        if key=='img_acid_gas': effects[key]['notes']='Native material-grid emitter shown as an air-only cosmetic projection; lifetime, material motion and reactions are not a full gas simulation.'
        if key=='img_image_explosion': effects[key]['notes']='Original XML declares airflow_force twice (0.2 and 20). This preview retains the final value, 20; duplicate-attribute precedence is not yet verified in the game parser.'
    image('data/particles/particle_glow.png')
    core=sprite('data/buildings_gfx/teleport_center.xml',{'additive':'1'})
    material('spark_purple');material('spark_white');material('spark_teal')
    OUT.mkdir(parents=True,exist_ok=True)
    # Actual material program, not the visual/background artwork. Only known
    # air/steel cells are supplied; untouched base-biome cells stay unknown.
    chamber_path = 'data/biome_impl/snowcastle/hourglass_chamber.png'
    chamber = Image.open(DATA / chamber_path.removeprefix('data/')).convert('RGBA')
    cells = bytes(1 if (r,g,b,a)==(64,64,65,255) else
        0 if (r,g,b,a)==(0,0,66,255) else 255 for r,g,b,a in chamber.getdata())
    collision = {'source':chamber_path,'width':chamber.width,'height':chamber.height,
        'x':256,'y':255,'offset':len(BINARY),'length':len(cells),
        'sha256':hashlib.sha256(cells).hexdigest()}
    BINARY.extend(cells)
    result={'version':1,'effects':effects,'assets':ASSETS,'imageAnimations':IMAGES,'materials':MATERIALS,'portalSprite':core,'warnings':WARNINGS,'eyeCollision':collision}
    (OUT/'effects.json').write_text(json.dumps(result,separators=(',',':'))+'\n')
    (OUT/'effects.bin').write_bytes(BINARY)
    print(f'Compiled {len(effects)} additional effects; {len(BINARY):,} bytes of targeted assets (no ZIP runtime).')
    for warning in WARNINGS: print(warning)

if __name__=='__main__':build()
