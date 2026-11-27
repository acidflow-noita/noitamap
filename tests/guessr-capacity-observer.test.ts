import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,expect,it,vi} from 'vitest';
import {usageQuery,observe,edgeExpression,refresh} from '../workers/noitamap-guessr/ops/capacity-observer.mjs';

const now=Date.UTC(2026,10,26,16,10),account='a'.repeat(32);
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();vi.useRealTimers();});
function report(used=90000){
 return Response.json({data:{viewer:{accounts:[{today:[{sum:{requests:used}}],peak:[{sum:{requests:24}}],
  lastHour:[{sum:{requests:360}}],remainderYesterday:[{sum:{requests:1200}}]}]}}});
}
it('uses every Worker on the account and guards the period not yet covered by analytics',async()=>{
 const fetcher=vi.fn(async()=>report());vi.stubGlobal('fetch',fetcher);
 const s=await observe(account,'noitamap-guessr','test',now);
 expect(s.used_requests).toBe(90000);expect(s.peak_per_minute).toBe(24);
 expect(s.background_requests).toBe(2820);
 expect(usageQuery(account,'noitamap-guessr',now).query).not.toContain('scriptName:');
 expect(usageQuery(account,'noitamap-guessr',now).through).toBe(now-120000);
});
it('publishes a public reset time and closes only the designated start paths before the Worker',async()=>{
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(now);vi.spyOn(console,'log').mockImplementation(()=>{});
 const dir=await mkdtemp(join(tmpdir(),'guessr-capacity-test-'));const path=join(dir,'status.json');
 const cfg={account,db:'local',script:'noitamap-guessr',analytics:'test',control:'test',path,host:'game.test',zone:'z',ruleset:'rs',rule:'r',edgeToken:'test'};
 const patch=vi.fn();
 vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL,options?:RequestInit)=>{
  const url=String(input);const body=options?.body?JSON.parse(String(options.body)):undefined;
  if(url.endsWith('/graphql'))return report(99000);
  if(url.endsWith('/query'))return Response.json({success:true,result:[{success:true,results:body.sql.startsWith('SELECT')?
    [{day_start:Math.floor(now/86400000)*86400000,measured_through:now-120000,checked_at:now,used_requests:99000,background_requests:3000,held_requests:200,peak_per_minute:10,paused_until:0}]:[]}]});
  if(options?.method==='PATCH'){patch(body);return Response.json({success:true});}
  return Response.json({success:true,result:{rules:[{id:'r',ref:'guessr_pause_game_starts',action:'block',enabled:false,expression:edgeExpression('game.test')}]}});}));
 try{
  await refresh(cfg,true,now);const message=JSON.parse(await readFile(path,'utf8'));
  expect(message).toEqual({state:'paused',retryAt:Date.UTC(2026,10,27),validUntil:Date.UTC(2026,10,27)});
  expect(patch).toHaveBeenCalledOnce();const rule=patch.mock.calls[0][0];
  expect(rule.enabled).toBe(true);expect(rule.expression).toContain('/api/attempts/new');
  expect(rule.expression).not.toContain('/socket');expect(rule.expression).not.toContain('/guess"');
 }finally{await rm(dir,{recursive:true,force:true});}
});
