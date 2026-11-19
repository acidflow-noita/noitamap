import { HARD_PUZZLE_POLL, type GuessrBallot, type PollChoice } from './poll-contract';
import type { SessionAccount } from './sessions';

export async function readGuessrBallot(db: D1Database, accountId: string | null, now: number): Promise<GuessrBallot | null> {
  const row = await db.prepare(`SELECT p.opens_at, p.closes_at, p.yes_count, p.no_count, v.choice
    FROM guessr_polls p LEFT JOIN guessr_votes v ON v.poll_id = p.id AND v.account_id = ?
    WHERE p.id = ?`).bind(accountId, HARD_PUZZLE_POLL).first<{
    opens_at: number; closes_at: number; yes_count: number; no_count: number; choice: PollChoice | null;
  }>();
  if (!row) return null;
  const phase = now < row.opens_at ? 'scheduled' : now < row.closes_at ? 'open' : 'closed';
  return { phase, serverNow: now, opensAt: row.opens_at, closesAt: row.closes_at, vote: row.choice,
    ...(phase === 'closed' ? { totals: { yes: row.yes_count, no: row.no_count } } : {}) };
}

export async function castGuessrBallot(db: D1Database, account: SessionAccount, choice: PollChoice): Promise<void> {
  await db.prepare(`INSERT INTO guessr_votes (poll_id, account_id, choice, cast_at)
    SELECT p.id, a.id, ?, unixepoch() FROM guessr_polls p JOIN auth_accounts a ON a.id = ? AND a.version = ?
    JOIN auth_sessions s ON s.id = ? AND s.account_id = a.id AND s.account_version = a.version
      AND s.revoked_at IS NULL AND s.expires_at > unixepoch() * 1000
    WHERE p.id = ? AND p.opens_at <= unixepoch() AND p.closes_at > unixepoch()
    ON CONFLICT(account_id, poll_id) DO NOTHING`)
    .bind(choice, account.id, account.version, account.session.id, HARD_PUZZLE_POLL).run();
}
