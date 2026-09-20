import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { decode } from 'fast-png';
import { collectPortals, type PortalSeed } from '../src/portals/placements';
import catalog from '../src/portals/assets/effects.json';
import rules from '../src/portals/placements.json';
import cube from './fixtures/search/786433191-meditation-cube.json';
const seed=(extra:Partial<PortalSeed>={}):PortalSeed=>({seed:42,worldSize:70,worldCenter:35,parallelWorlds:[0],...extra});
const scene=(key:string,x=0,y=0)=>({key,name:key.split('/').pop()!,x,y});
function normalPixels(){
  const image=decode(readFileSync('lib/noita-telescope/data/biome_maps/biome_map.png'));
  const pixels=new Uint32Array(image.width*image.height);
  for(let i=0;i<pixels.length;i++){const at=i*image.channels;pixels[i]=(image.data[at]<<16)|(image.data[at+1]<<8)|image.data[at+2];}
  return pixels;
}
describe('verified portal placement',()=>{
  it('uses each scene marker including the two-pixel basin variation, without changing loot',()=>{
    const input=seed({pixelScenesByPW:{'0,0':[scene('temple/altar_top',-1536,984),scene('temple/altar_top_water',0,984),scene('temple/altar_top_ending',0,12760)]}});
    const before=structuredClone(input),points=collectPortals(input);
    expect(points.map(p=>[p.entity,p.x,p.y])).toEqual([
      ['teleport_liquid_powered',-1272,1070],['teleport_liquid_powered',266,1070],['teleport_ending',266,12846],
    ]);
    expect(input).toEqual(before);
  });
  it('reconstructs all normal-mode basins from existing baked biome metadata in three worlds',()=>{
    const points=collectPortals(seed({biomeData:{pixels:normalPixels()},parallelWorlds:[-1,0,1]}));
    const hm=points.filter(p=>p.entity==='teleport_liquid_powered'||p.entity==='teleport_ending');
    expect(hm).toHaveLength(61*3);
    expect(hm.filter(p=>p.entity==='teleport_ending')).toHaveLength(9*3);
    expect(new Set(hm.map(p=>p.y))).toEqual(new Set([1070,2606,4654,6190,8238,10286,12846]));
    expect(hm.filter(p=>p.x < -17920)).toHaveLength(61);
    expect(hm.filter(p=>p.x >= 17920)).toHaveLength(61);
  });
  it('uses the actual mode/seed biome cells, not an invariant vanilla portal row table',()=>{
    const pixels=new Uint32Array(64*48);
    pixels[16*64+30]=0x93cb4d;
    expect(collectPortals(seed({worldSize:64,worldCenter:32,ngPlus:1,biomeData:{pixels}}))).toHaveLength(1);
    pixels[16*64+30]=0;
    expect(collectPortals(seed({worldSize:64,worldCenter:32,ngPlus:1,biomeData:{pixels}}))).toEqual([]);
  });
  it('prefers existing basin variants and deduplicates room markers against chunk fallbacks',()=>{
    const input=seed({biomeData:{pixels:normalPixels()},pixelScenesByPW:{'0,0':[scene('temple/altar_top_water',-1536,984),scene('general/teleportroom',3584,7168)]}});
    const p=collectPortals(input);
    expect(p.filter(p=>p.y===1070&&p.x < -1000)).toMatchObject([{x:-1270}]);
    expect(p.filter(p=>p.entity.startsWith('teleport_teleroom_'))).toHaveLength(6);
  });
  it('locates all six Leviathan hub portals, not a fictitious portal at the boss spawn',()=>{
    const p=collectPortals(seed({pixelScenesByPW:{'0,0':[scene('general/teleportroom',3584,7168)]},poisByPW:{'0,0':[{item:'boss_fish',x:-999,y:999}]}}));
    expect(p).toHaveLength(6);
    expect(p.map(p=>[p.entity,p.x,p.y])).toContainEqual(['teleport_teleroom_1',3721,7550]);
    expect(p.every(p=>p.condition==='leviathan-unlock')).toBe(true);
    expect(p.some(p=>p.entity==='teleport_teleroom')).toBe(false);
  });
  it('keeps the meditation entrance above the cube and uses the source return marker',()=>{
    const p=collectPortals(seed(cube));
    expect(p.find(p=>p.entity==='teleport_meditation_cube')).toMatchObject({x:-355,y:1567});
    const returns=collectPortals(seed({pixelScenesByPW:{'0,0':[scene('general/cube_chamber',-4608,2048)]}}));
    expect(returns[0]).toMatchObject({entity:'teleport_meditation_cube_return',effect:'meditation',x:-4347,y:2302});
  });
  it('keeps Buried Eye and Hourglass distinct and derives both Hourglass variants from their scene',()=>{
    const p=collectPortals(seed({pixelScenesByPW:{'0,0':[
      scene('snowcastle_cavern/side_cavern_left',-2510,5120),scene('snowcastle/hourglass_chamber',-4096,5120),
      scene('snowcave/secret_chamber',3584,4096),scene('snowcave/buried_eye',-200,4000),
    ]}}));
    expect(p).toMatchObject([
      {entity:'teleport_hourglass',x:-2221,y:5188},
      {entity:'teleport_hourglass_return',effect:'eye_room',x:-3840,y:5375},
      {entity:'teleport_snowcave_buried_eye_return',effect:'teleport_snowcave_buried_eye_return',x:3901,y:4284},
      {entity:'teleport_snowcave_buried_eye',x:-117,y:4105},
    ]);
  });
  it('does not turn every essence room into the Tower return or use XML destinations as spawn points',()=>{
    expect(collectPortals(seed({pixelScenesByPW:{'0,0':[scene('general/essenceroom')]}}))).toEqual([]);
    const pixels=new Uint32Array(70*48);pixels[22*70+54]=0x3d3e41;
    const p=collectPortals(seed({biomeData:{pixels}}));
    expect(p).toMatchObject([{entity:'mystery_teleport_back',x:19*512+256,y:8*512+56}]);
  });
  it('covers every registered visual and explicitly records portals with no verified fixed anchor',()=>{
    for(const rule of rules.recipes)for(const point of rule.points)expect(catalog.effects).toHaveProperty(point.entity);
    expect(rules.notPlaced).toHaveProperty('teleport_teleroom');
    expect(rules.notPlaced).toHaveProperty('teleport_ending_victory');
    expect(collectPortals(seed())).toEqual([]);
  });
});
