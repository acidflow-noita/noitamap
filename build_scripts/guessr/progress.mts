/** Bounded CI progress. Never include private questions, tokens or coordinates. */
export interface Progress { advance(count?: number): void }
interface ProgressOptions { unit?: string; details?: () => string; log?: (line: string) => void; intervalMs?: number }
export async function withProgress<T>(label: string, total: number | null,
  work: (progress: Progress) => Promise<T>, options: ProgressOptions = {}): Promise<T> {
  const log = options.log ?? console.log, started = performance.now();
  const interval = options.intervalMs ?? 5000;
  let completed = 0, changedAt = started, reportedAt = started;
  const report = (state = 'running') => {
    const now = performance.now(), seconds = (now - started) / 1000;
    const count = total === null ? '' : `${completed.toLocaleString('en-US')}/${total.toLocaleString('en-US')} ${options.unit ?? 'files'}, ${total ? (completed / total * 100).toFixed(1) : '100'}%`;
    const rate = completed && seconds > 0 ? completed / seconds : 0;
    const estimate = state === 'running' && total !== null && rate > 0 ? `ETA ${Math.ceil(Math.max(0, total - completed) / rate)}s` : '';
    const stalled = state === 'running' && total !== null && now - changedAt >= 15000 ? `${Math.floor((now - changedAt) / 1000)}s since last completed item` : '';
    const memory = `RSS ${Math.round(process.memoryUsage().rss / 1024 ** 2)} MiB`;
    const detail = options.details?.();
    log(`[Guessr daily] ${label}: ${[state, count, `${seconds.toFixed(1)}s elapsed`, rate && total !== null ? `${rate.toFixed(1)} ${options.unit ?? 'files'}/s` : '', estimate, stalled, detail, memory].filter(Boolean).join(', ')}`);
    reportedAt = now;
  };
  report();
  const timer = setInterval(() => { if (performance.now() - reportedAt >= interval) report(); }, interval); timer.unref();
  try {
    const result = await work({ advance(count = 1) {
      completed += count; changedAt = performance.now();
      // Also report during CPU-heavy loops that delay the interval callback.
      if (changedAt - reportedAt >= interval) report();
    } });
    report('complete'); return result;
  } catch (error) { report('failed'); throw error; }
  finally { clearInterval(timer); }
}
