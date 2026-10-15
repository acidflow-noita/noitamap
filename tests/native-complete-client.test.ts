import {describe,it,expect,vi} from 'vitest';
vi.mock('../src/native-map/complete-worker?worker',()=>({default:class{}}));
import {CompleteMapClient,isCompleteNativeMapEnabled} from '../src/native-map/complete-client';
function harness(){
 const workers:any[]=[];
 const client=new CompleteMapClient(()=>{const worker={postMessage:vi.fn(),terminate:vi.fn(),onmessage:null as any,onerror:null as any,onmessageerror:null as any};workers.push(worker);return worker as unknown as Worker;});
 const message=(worker:any,data:any)=>worker.onmessage({data});return{client,workers,message};
}
describe('completed native map worker lifecycle',()=>{
 it('selects an explicit native route',()=>{expect(isCompleteNativeMapEnabled('?native=1')).toBe(true);expect(isCompleteNativeMapEnabled('?native=0')).toBe(false);expect(isCompleteNativeMapEnabled('?nb=1')).toBe(false);});
 it('retains one worker for generation and reads of completed pixels',async()=>{
  const h=harness(),progress=vi.fn(),generated=h.client.generate({seed:42},undefined,progress),worker=h.workers[0],request=worker.postMessage.mock.calls[0][0];
  h.message(worker,{id:request.id,type:'progress',progress:{completedPages:1,totalPages:30240}});expect(progress).toHaveBeenCalledOnce();
  const description={generationId:request.id,world:{seed:42}};h.message(worker,{id:request.id,ok:true,result:description});expect(await generated).toEqual(description);
  const read=h.client.read(request.id,{level:6,x:0,y:0,width:2,height:2}),readRequest=worker.postMessage.mock.calls.at(-1)[0],pixels=new ArrayBuffer(16);
  expect(h.workers).toHaveLength(1);expect(readRequest.type).toBe('read');h.message(worker,{id:readRequest.id,ok:true,result:{pixels,width:2,height:2}});expect((await read).pixels).toBe(pixels);h.client.dispose();
 });
 it('cancels a request and ignores its late result',async()=>{
  const h=harness(),controller=new AbortController(),result=h.client.generate({seed:1},controller.signal),rejected=expect(result).rejects.toMatchObject({name:'AbortError'}),worker=h.workers[0],id=worker.postMessage.mock.calls[0][0].id;
  controller.abort();await rejected;expect(worker.postMessage).toHaveBeenLastCalledWith({type:'cancel',id});h.message(worker,{id,ok:true,result:{world:{seed:1}}});
  const next=h.client.generate({seed:2}),nextId=worker.postMessage.mock.calls.at(-1)[0].id;h.message(worker,{id:nextId,ok:true,result:{world:{seed:2}}});expect((await next).world.seed).toBe(2);h.client.dispose();
 });
 it('releases failed devices and ignores errors from a retired worker',async()=>{
  const h=harness(),first=h.client.generate({seed:1}),rejected=expect(first).rejects.toThrow('device lost'),old=h.workers[0];h.message(old,{type:'fatal',error:'device lost'});await rejected;expect(old.terminate).toHaveBeenCalledOnce();
  const next=h.client.generate({seed:2}),worker=h.workers[1];old.onerror({message:'late old error'});expect(worker.terminate).not.toHaveBeenCalled();
  h.message(worker,{id:worker.postMessage.mock.calls[0][0].id,ok:true,result:{world:{seed:2}}});expect((await next).world.seed).toBe(2);h.client.dispose();
 });
});
