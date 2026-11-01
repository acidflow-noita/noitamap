import { expect, it } from 'vitest';
import { gameDatabase } from './helpers/guessr-database';

it('applies the schema upgrade and completes a full game only after ten rounds', () => {
  const fixture = gameDatabase(), db = fixture.sqlite;
  try {
    db.exec(`INSERT INTO challenges
      (id,day,title,opens_at,closes_at,reveal_at,bounds_json,round_seconds,enabled)
      VALUES('daily','2026-10-30','Daily',0,10000,10000,'{}',60,1)`);
    db.exec(`INSERT INTO attempts
      (id,user_id,challenge_id,display_name,started_at,round_started_at)
      VALUES('game','player','daily','Player',0,0)`);
    const question = db.prepare(`INSERT INTO questions
      (challenge_id,ordinal,asset_key,name,biome,x,y,seed) VALUES('daily',?,'asset','answer','biome',0,0,123)`);
    const guess = db.prepare(`INSERT INTO guesses
      (attempt_id,ordinal,request_id,request_hash,score,elapsed_ms,accepted_at) VALUES('game',?,?,?,5000,0,?)`);
    for (let i = 0; i < 10; i++) {
      question.run(i); guess.run(i,`request-${i}`,`${i}`,i+1);
      expect(db.prepare('SELECT next_round,score,completed_at FROM attempts').get()).toMatchObject({
        next_round: i+1, score: (i+1)*5000, completed_at: i === 9 ? 10 : null,
      });
    }
    expect(() => question.run(10)).toThrow();
    expect(() => guess.run(10,'extra','extra',11)).toThrow();
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(db.prepare('PRAGMA foreign_key_list(guesses)').get()).toMatchObject({ table: 'attempts' });
  } finally { fixture.close(); }
});
