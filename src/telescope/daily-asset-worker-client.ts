import AssetWorker from './daily-asset-worker?worker';
import type { DailyAssetReply, DailyAssetRequest } from './daily-asset-worker-protocol';

/** No synchronous preparation fallback: a blocked/unsupported worker must not
 * make the already displayed daily map unresponsive. */
export function prepareDailyAssetsOffThread(
  request: DailyAssetRequest,
  signal: AbortSignal,
  onFailure: (error: unknown) => void,
  makeWorker: () => Worker = () => new AssetWorker(),
): Promise<Extract<DailyAssetReply, { type: 'done' }>> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = makeWorker();
    const cleanup = () => {
      signal.removeEventListener('abort', abort);
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      worker.terminate();
    };
    const abort = () => { cleanup(); reject(signal.reason); };
    worker.onmessage = (event: MessageEvent<DailyAssetReply>) => {
      const reply = event.data;
      if (reply.type === 'failure') onFailure(new Error(`${reply.asset}: ${reply.error}`));
      else if (reply.type === 'stage') console.info(
        `[Dynamic assets] ${reply.stage} ${reply.state}${reply.state === 'finished' ? ` in ${(reply.elapsedMs / 1000).toFixed(2)} seconds` : ''}`,
        { elapsedMs: reply.elapsedMs, failures: reply.failures, scope: 'Worker source-asset preparation; not decoded scene/world pixels' },
      );
      else if (reply.type === 'done') { cleanup(); resolve(reply); }
    };
    worker.onerror = event => { cleanup(); reject(new Error(event.message || 'Asset preparation worker failed')); };
    worker.onmessageerror = () => { cleanup(); reject(new Error('Asset preparation worker returned unreadable data')); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { abort(); return; }
    try { worker.postMessage(request); }
    catch (error) { cleanup(); reject(error); }
  });
}
