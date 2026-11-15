import { ImageGameError } from '../../../src/guessr/image-game-server';
import type { StreamPublishedResult } from '../../../src/guessr/stream-types';
import { STREAM_MAX_DOCUMENT_BYTES } from '../../../src/guessr/stream-types';
import { encodeStoredResult, STREAM_STORAGE_BUDGET_BYTES, STREAM_RESULT_OVERHEAD_BYTES } from './result-storage';
import type { Env } from './index';
interface StoredResult { owner: string; digest: string; result_json: string }
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
/** Trusted coordinator publication. Admission limits must not block finishing games. */
export async function persistStreamResult(env: Env, owner: string, result: StreamPublishedResult,
  hostVerifiedAt: number, now = Date.now()): Promise<Response> {
  const serialized = JSON.stringify(result),
    bytes = new TextEncoder().encode(serialized);
  // Host names/logins may change between an upload and its retry. Identity
  // and reported scores determine idempotency; mutable host labels do not.
  const canonical = new TextEncoder().encode(JSON.stringify({ ...result, transportStats: undefined, config: undefined, host: { id: result.host.id },
    players: result.players.map(p => p.id === result.host.id ? { ...p, name: '', login: '' } : p) }));
  if (await env.DB.prepare('SELECT id FROM stream_result_removals WHERE id=?').bind(result.id).first())
    throw new ImageGameError(410, 'This published result was removed.');
  if (bytes.byteLength > STREAM_MAX_DOCUMENT_BYTES)
    throw new ImageGameError(
      413,
      "Result is too large to publish. Download the complete result instead.",
    );
  const digest = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", canonical)),
    (v) => v.toString(16).padStart(2, "0"),
  ).join("");
  const existing = await env.DB.prepare(
    "SELECT owner,digest FROM stream_results WHERE id=?",
  )
    .bind(result.id)
    .first<StoredResult>();
  if (existing) {
    if (existing.owner !== owner || existing.digest !== digest)
      throw new ImageGameError(
        409,
        "This game already has an immutable published result.",
      );
    return json({ id: result.id, published: true });
  }
  const day = new Date(now).toISOString().slice(0, 10);
  const encoded = await encodeStoredResult(result, serialized, bytes);
  const inserted = await env.DB.prepare(
    "INSERT INTO stream_results(id,owner,day,created_at,bytes,digest,result_json,result_gzip,host_id,host_verified_at) SELECT ?,?,?,?,?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM stream_result_removals WHERE id=?) AND (SELECT used_bytes FROM stream_result_storage WHERE id=1)+? <= ? ON CONFLICT(id) DO NOTHING RETURNING id",
  )
    .bind(
      result.id,
      owner,
      day,
      now,
      encoded.bytes,
      digest,
      encoded.json,
      encoded.gzip,
      result.host.id,
      hostVerifiedAt,
      result.id,
      encoded.bytes + STREAM_RESULT_OVERHEAD_BYTES,
      STREAM_STORAGE_BUDGET_BYTES,
    )
    .first();
  if (!inserted) {
    if (await env.DB.prepare('SELECT id FROM stream_result_removals WHERE id=?').bind(result.id).first())
      throw new ImageGameError(410, 'This published result was removed.');
    const concurrent = await env.DB.prepare(
      "SELECT owner,digest FROM stream_results WHERE id=?",
    )
      .bind(result.id)
      .first<StoredResult>();
    if (concurrent?.owner === owner && concurrent.digest === digest) {
        return json({ id: result.id, published: true });
    }
    if (concurrent)
      throw new ImageGameError(
        409,
        "This game already has an immutable published result.",
      );
    const storage = await env.DB.prepare('SELECT used_bytes FROM stream_result_storage WHERE id=1').first<{ used_bytes: number }>();
    if (!storage) throw new Error('Result storage accounting is unavailable.');
    throw new ImageGameError(
      507,
      'Result storage is full. Download your result to keep a copy.',
    );
  }
  return json({ id: result.id, published: true }, 201);
}
