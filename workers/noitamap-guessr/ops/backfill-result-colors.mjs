/** Index historical Twitch colors without rewriting a published result. Shares the Worker's validation and upsert. */
import { gunzipSync } from 'node:zlib';
import { sql } from './cloudflare-api.mjs';
import { rememberResultColors } from '../src/result-colors.ts';
const config = { account:process.env.CLOUDFLARE_ACCOUNT_ID, db:process.env.GUESSR_DATABASE_ID,
  control:process.env.GUESSR_CAPACITY_DB_TOKEN };
if (!/^[a-f0-9]{32}$/.test(config.account??'') || !/^[a-f0-9-]{36}$/.test(config.db??'') || !config.control)
  throw Error('Set the secondary account ID, Guessr database ID and scoped D1 token.');
const [pending] = await sql(config,'SELECT COUNT(*) AS n FROM stream_color_backfill');
if (!process.argv.includes('--apply')) console.log(pending.n+' previously published results await color indexing.');
else {
  const db={prepare: statement=>({bind:(...params)=>({statement,params})}),batch:async queries=>{
    for(const q of queries) await sql(config,q.statement,q.params);
  }};
  let completed=0;
  for(;completed<pending.n;completed++){
    const [record]=await sql(config,`SELECT r.id,r.result_json,hex(r.result_gzip) AS compressed FROM stream_color_backfill q
      JOIN stream_results r ON r.id=q.game_id ORDER BY q.game_id LIMIT 1`);
    if(!record)break;
    const body=record.compressed?gunzipSync(Buffer.from(record.compressed,'hex'),{maxOutputLength:4*1024*1024}).toString('utf8'):record.result_json;
    const game=JSON.parse(body);
    if(game.id!==record.id||!Number.isSafeInteger(game.finishedAt)||!Array.isArray(game.players)) throw Error('Invalid archived result.');
    await rememberResultColors(db,game);
  }
  console.log('Indexed Twitch colors from '+completed+' saved results.');
}
