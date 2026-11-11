import { expect, it } from 'vitest';
import { checkCleanup } from '../workers/noitamap-auth/check-cleanup.mjs';

function fixture(kv: string, rows: number) {
  const buffers: Buffer[] = [];
  const run = async (args: string[]) => {
    const value = args[0] === 'd1' ? JSON.stringify([{ results: [{ remaining: rows }] }])
      : args[0] === 'kv' ? kv : JSON.stringify([{ name: 'GAME_SIGNING_SECRET', type: 'secret_text' }]);
    const stdout = Buffer.from(value), stderr = Buffer.alloc(0); buffers.push(stdout);
    return { code: 0, stdout, stderr };
  };
  const fetcher = async (url: string) => url.includes('-dev.')
    ? new Response('Authentication is not configured for this environment.', { status: 503 })
    : new Response('Method Not Allowed', { status: 405 });
  return { run, fetcher, buffers };
}
it('reports only status and counts, zeroes captured values and performs no writes', async () => {
  const f = fixture('c2.1.opaque-iv.opaque-ciphertext', 0), calls: string[][] = [];
  const report = await checkCleanup(async (args: string[]) => { calls.push(args); return f.run(args); }, f.fetcher);
  expect(report).toMatchObject({ readyToRemoveLegacyCredentialBinding: true, legacyCredentialRows: 0, broadcasterKv: 'encrypted', oldGameSecretOnAuth: 'present' });
  expect(JSON.stringify(report)).not.toContain('opaque');
  expect(f.buffers.every(buffer => buffer.every(byte => byte === 0))).toBe(true);
  expect(calls.some(args => args.includes('--text') || args.includes('delete') || args.includes('deploy') || args.includes('put'))).toBe(false);
  expect(calls[0].at(-1)).toMatch(/^SELECT COUNT/);
});
it('keeps retirement blocked for plaintext credentials or an unfinished migration', async () => {
  const f = fixture('{"accessToken":"do-not-print","refreshToken":"do-not-print"}', 3);
  const report = await checkCleanup(f.run, f.fetcher);
  expect(report.readyToRemoveLegacyCredentialBinding).toBe(false);
  expect(report.broadcasterKv).toBe('NOT MIGRATED'); expect(JSON.stringify(report)).not.toContain('do-not-print');
});
it('fails closed without exposing failed CLI output', async () => {
  const f = fixture('c2.1.unused', 0);
  const report = await checkCleanup(async () => ({ code: 1, stdout: Buffer.from('do-not-print'), stderr: Buffer.from('authentication failed') }), f.fetcher);
  expect(report.readyToRemoveLegacyCredentialBinding).toBe(false);
  expect(report.legacyCredentialRows).toBe('CHECK FAILED');
  expect(report.broadcasterKv).toBe('CHECK FAILED');
  expect(report.oldGameSecretOnAuth).toBe('CHECK FAILED');
  expect(JSON.stringify(report)).not.toContain('do-not-print');
});
