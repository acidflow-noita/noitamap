import { MODIFIER_KEYS, prepareCarveTables, type CompleteMaterialInputs } from '../../complete-materials/index.ts';
import { getModifierGrid, surfaceNoisePhase, bitmapNoiseNodeOffset } from '../../complete-materials/seed-modifiers.mjs';
import { copyCaveStateModifiers, validateCaveStateBinding } from '../../game-state/index.ts';

/** One retained exact C world, reused for compact repairs and liquid probes. */
export async function createExactCorrector(input: CompleteMaterialInputs, module: WebAssembly.Module) {
  const started=performance.now(),widthLimit=1024,heightLimit=1024,capacity=widthLimit*heightLimit,l=input.lattice;
  if(input.mapWidth!==70||l.GW!==3584||l.GH!==2457||l.cov.length!==l.GW*l.GH||l.mat.length!==l.cov.length||input.biomePixels.length!==3360||input.hostChunks.length!==3360)
    throw Error('Exact GPU correction requires normal70-column inputs');
  const imported=input.generationState?validateCaveStateBinding(input.generationState):undefined;
  if(imported&&(input.topology0||imported.context.seed!==input.seed||imported.context.ngPlus!==0||imported.context.gameMode!=='normal'))throw Error('Correction cave-state context mismatch');
  const overrides=input.generationState?copyCaveStateModifiers(input.generationState):undefined;
  const seedData=input.topology0??(!input.plane?{seed:input.seed,surfacePhase:surfaceNoisePhase(input.seed),bitmapNoiseOffset:bitmapNoiseNodeOffset(input.seed),modifiers:Object.fromEntries(MODIFIER_KEYS.map(key=>[key,overrides&&Object.hasOwn(overrides,key)?overrides[key]:getModifierGrid(input.seed,key)]))}:undefined);
  if(seedData&&seedData.seed!==input.seed)throw Error('Correction modifier seed mismatch');
  const tables=input.carveTables??(!input.plane?prepareCarveTables():undefined),w:any=(await WebAssembly.instantiate(module)).exports;
  if(w.abi_version()!==3||typeof w.correct_indices!=='function')throw Error('Incorrect material correction WASM');
  let cursor=Math.ceil(w.heap_base()/16)*16;const take=(n:number)=>{const at=cursor;cursor=Math.ceil((cursor+n)/16)*16;return at;};
  const colors=take(3360*4),covered=take(3360),ids=take(3360*4),host=take(3360*4),params=take(input.parameters.length*16),hash=take(tables?.hash.byteLength??0),cx=take(tables?.cosine.byteLength??0),sy=take(tables?.sine.byteLength??0),descriptors=take(MODIFIER_KEYS.length*24);
  const modifiers=MODIFIER_KEYS.map(key=>{const grid=seedData?.modifiers[key];return grid?{grid,at:take(grid.data.byteLength)}:null;});
  const shafts=new Map((input.plane?.shafts??[]).map(s=>[s.column,s]));
  const grids=[{source:l,offsetY:input.plane?.offsetY??0,originX:0,shaft:0},...[...shafts.values()].map(s=>({source:s.lattice,offsetY:s.offsetY,originX:s.originX,shaft:1}))].map(g=>({...g,cov:take(g.source.cov.byteLength),mat:take(g.source.mat.byteLength)}));
  const gridDescriptors=take(grids.length*40),columnsAt=take(input.mapWidth*4),columns=new Uint32Array(input.mapWidth);
  [...shafts.keys()].forEach((column,i)=>{if(!Number.isInteger(column)||column<0||column>=input.mapWidth)throw Error('Invalid correction shaft column');columns[column]=i+1;});
  const cosineAt=take(widthLimit*8),sineAt=take(heightLimit*8),indicesAt=take(capacity*4),outAt=take(capacity*16),bandAt=take(4096*24),required=Math.ceil(cursor/65536)*65536;
  if(required>128*1024*1024)throw Error('Exact correction memory bound exceeded');
  if(required>w.memory.buffer.byteLength)w.memory.grow((required-w.memory.buffer.byteLength)/65536);
  const memory=w.memory.buffer;
  const configCount=w.correction_topo0_config_count(),surfaceCount=w.correction_topo0_surface_count();
  const configView=new DataView(memory,w.correction_topo0_configs(),configCount*128),surfaceView=new DataView(memory,w.correction_topo0_surfaces(),surfaceCount*64);
  const configRows=Array.from({length:configCount},(_,i)=>({integers:Array.from({length:12},(_,j)=>configView.getInt32(i*128+j*4,true)),values:Array.from({length:10},(_,j)=>configView.getFloat64(i*128+48+j*8,true))}));
  const surfaceRows=Array.from({length:surfaceCount},(_,i)=>({edge:surfaceView.getInt32(i*64,true),values:Array.from({length:7},(_,j)=>surfaceView.getFloat64(i*64+8+j*8,true))}));
  new Uint32Array(memory,colors,3360).set(input.biomePixels);new Uint8Array(memory,covered,3360).set(l.chunkCovered);new Uint32Array(memory,host,3360).set(input.hostChunks);
  const gd=new DataView(memory,gridDescriptors,grids.length*40);grids.forEach((g,i)=>{const s=g.source;if(!Number.isInteger(s.GW)||!Number.isInteger(s.GH)||s.GW<1||s.GH<1||s.cov.length!==s.GW*s.GH||s.mat.length!==s.cov.length||![g.offsetY,g.originX].every(Number.isFinite))throw Error('Invalid correction grid');new Float32Array(memory,g.cov,s.cov.length).set(s.cov);new Uint16Array(memory,g.mat,s.mat.length).set(s.mat);gd.setInt32(i*40,s.GW,true);gd.setInt32(i*40+4,s.GH,true);gd.setUint32(i*40+8,g.cov,true);gd.setUint32(i*40+12,g.mat,true);gd.setFloat64(i*40+16,g.offsetY,true);gd.setFloat64(i*40+24,g.originX,true);gd.setInt32(i*40+32,g.shaft,true);});
  new Uint32Array(memory,columnsAt,columns.length).set(columns);
  const pv=new DataView(memory,params,input.parameters.length*16);input.parameters.forEach((p,i)=>{if(!Number.isFinite(p.scale)||!Number.isFinite(p.threshold)||!Number.isInteger(p.type)||p.type<0||p.type>2)throw Error('Invalid correction sampling parameters');pv.setFloat32(i*16,p.scale,true);pv.setFloat32(i*16+4,p.threshold,true);pv.setInt32(i*16+8,p.type,true);pv.setInt32(i*16+12,p.present===false?0:1,true);});
  if(tables){new Float32Array(memory,hash,tables.hash.length).set(tables.hash);new Float64Array(memory,cx,tables.cosine.length).set(tables.cosine);new Float64Array(memory,sy,tables.sine.length).set(tables.sine);
  w.configure_topo0_immutable(hash,tables.hashMin,tables.hash.length,cx,tables.xMin,tables.cosine.length,sy,tables.yMin,tables.sine.length);}
  const mv=new DataView(memory,descriptors,MODIFIER_KEYS.length*24);modifiers.forEach((m,i)=>{if(!m)return;const g=m.grid;new Float32Array(memory,m.at,g.data.length).set(g.data);mv.setUint32(i*24,m.at,true);mv.setInt32(i*24+4,g.W,true);mv.setInt32(i*24+8,g.H,true);mv.setFloat64(i*24+16,g.node94,true);});
  w.configure_topo0_seed(seedData?.surfacePhase??0,seedData?.bitmapNoiseOffset??0,input.seed,descriptors);w.configure(l.GW,l.GH,grids[0].cov,grids[0].mat,params,input.parameters.length,input.mapWidth*256);w.configure_world(colors,input.mapWidth,covered,ids);w.configure_host_chunks(host);w.configure_correction_grids(gridDescriptors,columnsAt,+!!input.plane,input.plane?.offsetY??0);
  const cosine=new Float64Array(memory,cosineAt,widthLimit),sine=new Float64Array(memory,sineAt,heightLimit),indexData=new Uint32Array(memory,indicesAt,capacity),output=new Int32Array(memory,outAt,capacity*4);
  const statistics={correctionQueries:0,exactRunQueries:0,correctionMs:0,exactRunMs:0};
  const bandData=new Float64Array(memory,bandAt,4096*3);
  function bandQuery(points:ReadonlyArray<{biomeId:number,x:number,y:number,coverage?:number,density?:number}>,coverage:boolean){
    if(points.length>4096)throw Error('Exact band batch exceeds4096 points');
    points.forEach((p,i)=>{const value=coverage?p.coverage:p.density;if(!Number.isInteger(p.biomeId)||p.biomeId<0||p.biomeId>65535||![p.x,p.y,value].every(Number.isFinite)||Math.abs(p.x)>2**26||Math.abs(p.y)>2**26||Math.abs(value!)>65536||(!coverage&&Math.fround(value!)!==value))throw Error('Invalid exact band point');bandData.set([p.x,p.y,value!],i*3);indexData[i]=p.biomeId;});
    (coverage?w.resolve_coverage_band_points:w.select_band_points)(bandAt,indicesAt,points.length,outAt);
    return output.slice(0,points.length);
  }
  function correct(x:number,y:number,width:number,height:number,indices:Uint32Array) {
    if(![x,y,width,height].every(Number.isSafeInteger)||width<1||height<1||width>widthLimit||height>heightLimit||indices.length>capacity||indices.some(i=>i>=width*height))throw Error('Invalid batched correction inputs');
    const start=performance.now();indexData.set(indices);for(let i=0;i<width;i++)cosine[i]=Math.cos((x+i+input.mapWidth*256)*.005);for(let i=0;i<height;i++)sine[i]=Math.sin((y+i+7168)*.005);const prepared=performance.now();
    w.correct_indices(x,y,width,height,indicesAt,indices.length,cosineAt,sineAt,outAt);const completed=performance.now(),patches=output.slice(0,indices.length*4);
    for(let i=0;i<indices.length;i++)if(patches[i*4+2]>=8)throw Error(`Unresolved exact material correction class${patches[i*4+2]} at${x+indices[i]%width},${y+Math.floor(indices[i]/width)}`);
    return{patches,stats:{queries:indices.length,copyAndTrigMs:prepared-start,kernelMs:completed-prepared,copyAndCheckMs:performance.now()-completed,totalMs:performance.now()-start}};
  }
  return{memoryBytes:memory.byteLength,preparationMs:performance.now()-started,statistics,seedData,tables,configRows,surfaceRows,
    prepareSurfaceAxes(x:number,width:number){if(width<1||width>widthLimit)throw Error('Invalid surface-axis width');w.prepare_correction_surfaces(x,width,outAt);return new Float64Array(memory,outAt,surfaceCount*width*2).slice();},
    resolveCoverageBandPoints(points:ReadonlyArray<{biomeId:number,x:number,y:number,coverage:number}>){return bandQuery(points,true);},
    selectBandPoints(points:ReadonlyArray<{biomeId:number,x:number,y:number,density:number}>){return bandQuery(points,false);},
    correct(x:number,y:number,width:number,height:number,indices:Uint32Array){const r=correct(x,y,width,height,indices);statistics.correctionQueries+=indices.length;statistics.correctionMs+=r.stats.totalMs;return r;},
    resolveExactRect(x:number,y:number,width:number,height:number){const start=performance.now(),count=width*height,indices=Uint32Array.from({length:count},(_,i)=>i),r=correct(x,y,width,height,indices),materials=new Int32Array(count),classifications=new Uint8Array(count),owners=new Int32Array(count);for(let i=0;i<count;i++){materials[i]=r.patches[i*4+1];classifications[i]=r.patches[i*4+2];owners[i]=r.patches[i*4+3];}statistics.exactRunQueries+=count;statistics.exactRunMs+=performance.now()-start;return{materials,classifications,owners,stats:r.stats};},
  };
}
