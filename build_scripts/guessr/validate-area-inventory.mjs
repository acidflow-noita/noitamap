/** Source/capture audit only. Never changes source pixels or enables areas. */
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
import sharp from 'sharp';
import {readRegion} from './prepare-clues.mjs';
const dir='task/guessr/area-inventory',site='task/guessr/site/captured';
const inventory=JSON.parse(await readFile(`${dir}/inventory.json`,'utf8'));
const grid=JSON.parse(await readFile(`${dir}/biome-grid.json`,'utf8'));
const {data:map,info:mapInfo}=await sharp('lib/noita-telescope-vm/data/biome_maps/biome_map.png').ensureAlpha().raw().toBuffer({resolveWithObject:true});
assert.equal(mapInfo.width,70);assert.equal(mapInfo.height,48);
let differences=0;
for(let i=0;i<grid.colors.length;i++){
 const actual='#'+[map[i*4],map[i*4+1],map[i*4+2]].map(v=>v.toString(16).padStart(2,'0')).join('');
 if(actual!==grid.colors[i])differences++;
}
assert.equal(differences,0,'Boundary masks must agree with every source biome-map cell');
const html=await readFile(`${dir}/index.html`,'utf8');
new vm.Script(html.match(/<script>([\s\S]*)<\/script>/)[1]); // syntax only, no browser execution
assert(inventory.areas.every(a=>a.samplingEnabled===false));
const main=inventory.areas.filter(a=>a.geometry==='logical-chunk-component');
assert.equal(main.length,222);assert.equal(main.reduce((n,a)=>n+a.cells,0),3360);
assert.equal(main.filter(a=>a.engine==='fungicave').length,3);
assert.equal(main.filter(a=>a.engine==='meat').length,2);

// Semantic groups must reconstruct their exact source unions. This catches
// rectangle shortcuts, lost holes, overlapping assignments and realm offsets.
const sources=new Map(inventory.areas.map(a=>[a.id,a]));
const puzzles=new Map(inventory.puzzleAreas.map(a=>[a.id,a]));
const cellSet=a=>new Set(a.runs.flatMap(([y,x0,x1])=>Array.from({length:x1-x0},(_,i)=>`${x0+i},${a.originY+y*512}`)));
const allPuzzleCells=new Set(),assigned=new Map();
assert.deepEqual(Object.keys(inventory.scoringProfiles),['easy','normal','hard']);
assert.deepEqual(inventory.scoringProfiles,{
 easy:{area:500,position:4500,maximum:5000},
 normal:{area:1000,position:4000,maximum:5000},
 hard:{area:3000,position:2000,maximum:5000},
});
for(const p of puzzles.values()){
 assert.equal(p.samplingEnabled,false);
 if(p.difficultyRule){
  assert.equal(p.difficultyTier,null);assert.equal(p.scoring,null);
  for(const [tier,score]of Object.entries(p.scoringVariants))assert.deepEqual(score,inventory.scoringProfiles[tier]);
 }else{
  assert(Object.hasOwn(inventory.scoringProfiles,p.difficultyTier));
  assert.equal(p.scoring.area+p.scoring.position,5000);assert.equal(p.scoring.maximum,5000);
 }
 if(!p.runs){assert.equal(p.geometry,'point-only');assert.equal(p.status,'review-footprint');continue}
 const expected=new Set();
 for(const id of p.sourceIds){
  assert(!assigned.has(id),`Source assigned more than once: ${id}`);
  assigned.set(id,p.id);
  const source=sources.get(id);assert(source?.runs);assert.notEqual(source.status,'excluded');
  assert.equal(source.puzzleAreaId,p.id);
  for(const cell of cellSet(source))expected.add(cell);
 }
 const actual=cellSet(p);assert.deepEqual(actual,expected,p.id);assert.equal(p.cells,expected.size);
 for(const cell of actual){assert(!allPuzzleCells.has(cell),`Overlapping base area at ${cell}`);allPuzzleCells.add(cell)}
}
assert.deepEqual(Object.fromEntries(assigned),inventory.sourceAssignments);
assert(inventory.areas.concat(inventory.puzzleAreas).every(a=>a.label!=='en'&&a.label.trim()));
const edr=puzzles.get('terrain/edr');
assert.deepEqual(new Set(edr.sourceIds),new Set(inventory.areas.filter(a=>a.engine==='solid_wall').map(a=>a.id)));
assert.equal(edr.difficultyTier,'normal');assert.deepEqual(edr.scoring,inventory.scoringProfiles.normal);
assert.equal(assigned.get('main/solid_wall/3d3d3d/30-14'),edr.id);
const pyramid=puzzles.get('landmark/pyramid');
assert.deepEqual(new Set(pyramid.sourceIds),new Set(main.filter(a=>a.engine==='pyramid'||a.engine.startsWith('pyramid_')).map(a=>a.id)));
assert.equal(puzzles.get('biome/snowy-wasteland').cells,195);
assert.deepEqual(puzzles.get('biome/snowy-wasteland').difficultyRule,{
 kind:'initial-view-snow',withSnow:'normal',withoutSnow:'hard',unknown:'requires-review',frozenForRound:true,
});
assert.equal(puzzles.get('biome/snowy-chasm').cells,199);
for(const id of ['main/lake/1133f1/4-0','main/winter/d6d8e3/11-0']){
 assert.equal(sources.get(id).status,'excluded');assert(!assigned.has(id));
}
assert.notEqual(sources.get('main/empty/48e311/15-14').status,'excluded');
assert.equal(assigned.get('main/empty/48e311/15-14'),'biome/frozen-vault');
assert.equal(assigned.get('main/bridge/ad8111/15-13'),'biome/frozen-vault');
assert.equal(puzzles.get('biome/frozen-vault').cells,36);assert(!puzzles.has('landmark/bridge'));
assert.equal(puzzles.get('landmark/tower').label,'The Tower');
const templeEngines=new Set(['crypt','wandcave','biome_barren','biome_potion_mimics','biome_darkness','biome_boss_sky']);
for(const a of inventory.areas.concat(inventory.puzzleAreas)){
 if([a.engine].flat().some(e=>templeEngines.has(e))){
  assert.equal(a.difficultyTier,'easy',a.id);assert.deepEqual(a.scoring,inventory.scoringProfiles.easy);
 }
}
const boss=puzzles.get('landmark/alchemist-boss-room'),lab=puzzles.get('biome/ancient-laboratory');
const bossCell=`${Math.floor((-4840+17920)/512)},${Math.floor(851/512)*512}`;
assert(cellSet(boss).has(bossCell));assert(!cellSet(lab).has(bossCell));assert(!cellSet(edr).has(bossCell));
const elevator=puzzles.get('landmark/hiidet-elevator');
assert.deepEqual(elevator.bounds,{x:-16896,y:16896,width:512,height:25088});
assert.equal(puzzles.get('biome/meat-realm-main').cells,18);
assert.equal(puzzles.get('biome/meat-realm-secondary').cells,27);
assert.equal(inventory.puzzleAreas.filter(a=>a.id.startsWith('biome/fungal-caverns-')).length,3);
assert.equal(inventory.puzzleAreas.filter(a=>a.id.startsWith('landmark/holy-mountain-')).length,7);
for(let depth=1;depth<=6;depth++){
 const hm=puzzles.get(`landmark/holy-mountain-${depth}`);
 assert.equal(hm.difficultyTier,'normal');assert.deepEqual(hm.scoring,{area:1500,position:3500,maximum:5000});
}
const finalHm=puzzles.get('landmark/holy-mountain-final');
assert.equal(finalHm.difficultyTier,'easy');assert.deepEqual(finalHm.scoring,inventory.scoringProfiles.easy);
assert.deepEqual(finalHm.point,{x:2590,y:13144});assert(!finalHm.runs);
assert.deepEqual(finalHm.containingComponents,['main/boss_arena/14eed7/38-38']);

const c=inventory.capture,level=12,scale=2**(c.maxLevel-level),width=Math.ceil(c.width/scale),height=Math.ceil(c.height/scale);
const overview=Buffer.alloc(width*height*3),size=c.tileSize;
for(let y=0;y<Math.ceil(height/size);y++)for(let x=0;x<Math.ceil(width/size);x++){
 const {data,info}=await sharp(`${site}/map_files/${level}/${x}_${y}.webp`).removeAlpha().raw().toBuffer({resolveWithObject:true});
 assert.equal(info.channels,3);const ox=x?c.overlap:0,oy=y?c.overlap:0,w=Math.min(size,width-x*size),h=Math.min(size,height-y*size);
 for(let row=0;row<h;row++)data.copy(overview,((y*size+row)*width+x*size)*3,((oy+row)*info.width+ox)*3,((oy+row)*info.width+ox+w)*3);
}
function statistics(bytes,info,rects){
 const colors=new Map();let pixels=0;
 for(const r of rects)for(let y=r.y;y<r.y+r.height;y++)for(let x=r.x;x<r.x+r.width;x++){
  const i=(y*info.width+x)*3,color=(bytes[i]<<16)|(bytes[i+1]<<8)|bytes[i+2];
  colors.set(color,(colors.get(color)??0)+1);pixels++;
 }
 const top=[...colors].sort((a,b)=>b[1]-a[1])[0];
 return {pixels,distinctColors:colors.size,dominantColor:top?'#'+top[0].toString(16).padStart(6,'0'):null,dominantFraction:top?top[1]/pixels:0};
}
const entries=[];
for(const a of inventory.areas){
 if(!a.runs)continue;
 const rects=a.runs.map(([y,x0,x1])=>({x:x0*512/scale,y:(a.originY+y*512-c.originY)/scale,width:(x1-x0)*512/scale,height:512/scale}));
 entries.push({id:a.id,...statistics(overview,{width,height},rects)});
}
const hills=main.find(a=>a.engine==='hills2');assert(hills&&hills.status==='excluded');
const native=await readRegion(site,c,hills.bounds);
const rects=hills.runs.map(([y,x0,x1])=>({x:-17920+x0*512-hills.bounds.x,y:hills.originY+y*512-hills.bounds.y,width:(x1-x0)*512,height:512}));
const hillsStats=statistics(native.data,native.info,rects);
await sharp(native.data,{raw:native.info}).resize({width:640,kernel:'nearest'}).png().toFile(`${dir}/hills2-capture.png`);
const report={captureSha256:c.sha256,boundarySha256:inventory.sourceIdentity['src/data/biome_boundries_py.json'],
 sourceBitmap:{cells:3360,mismatches:differences,encoding:'RGB'},
 geometryChecks:'All3360cells accounted for without overlap, disconnected components/holes retained, raw counts independently match source PNG.',
 htmlScriptSyntax:true,allSamplingDisabled:true,
 curation:{groups:puzzles.size,assignedSourceComponents:assigned.size,unionCells:allPuzzleCells.size,overlaps:0,exactSourceUnions:true,reviewCorrections:true},
 overview:{level,scale,entries},hills2:{id:hills.id,bounds:hills.bounds,...hillsStats},
 note:'Overview color statistics flag review candidates only; low variation is NOT an exclusion rule. Native hills2 statistics cover every pixel inside its source mask; the preview shows its bounding rectangle.'};
await writeFile(`${dir}/content-audit.json`,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({bitmap:report.sourceBitmap,curation:report.curation,mainComponents:main.length,overviewAreas:entries.length,hills2:report.hills2}));
