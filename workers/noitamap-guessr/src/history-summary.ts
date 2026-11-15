import { streamHistorySummary, type StreamHistorySummary } from '../../../src/guessr/stream-history-summary';
import { readStoredResult, STREAM_STORAGE_BUDGET_BYTES, STREAM_RESULT_OVERHEAD_BYTES, type StoredResultBody } from './result-storage';
import type { Env } from './index';

/** One missing historical summary at most per page. Full result data stays here. */
export async function storedHistorySummary(db: Env['DB'], id: string, stored: StoredResultBody, cached: string | null): Promise<StreamHistorySummary | undefined> {
  const header = JSON.parse(stored.result_json);
  if (header.storage !== 'gzip-json-v1') return streamHistorySummary(header);
  if (header.summary) return header.summary;
  if (cached) return JSON.parse(cached);
  if (stored.result_gzip == null) return;
  const result = await readStoredResult(stored);
  if (result.schema !== 1 || result.id !== id) throw Error('Stored result identity does not match.');
  const summary = streamHistorySummary(result), json = JSON.stringify(summary), bytes = new TextEncoder().encode(json).byteLength;
  await db.prepare(`INSERT INTO stream_result_history(result_id,summary_json,bytes) SELECT ?,?,?
    WHERE EXISTS(SELECT 1 FROM stream_results WHERE id=? AND result_json=?)
      AND (SELECT used_bytes FROM stream_result_storage WHERE id=1)+?<=?
    ON CONFLICT(result_id) DO NOTHING`)
    .bind(id, json, bytes, id, stored.result_json, bytes + STREAM_RESULT_OVERHEAD_BYTES, STREAM_STORAGE_BUDGET_BYTES).run();
  return summary;
}
