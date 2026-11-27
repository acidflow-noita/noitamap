import { gameApiOrigin } from './api-origin';
export type SharedQuota = 'worker' | 'starts' | 'checking' | 'ranked';
interface QuotaNotice {
  scope: SharedQuota;
  resetAt: number;
}
const key = 'guessr-daily-limits-v1';
const changed = new EventTarget();
const fallback = new Map<SharedQuota, number>();
const scopes: SharedQuota[] = ['worker', 'starts', 'checking', 'ranked'];
export function currentQuota(now = Date.now()): QuotaNotice | undefined {
  try {
    const saved = JSON.parse(sessionStorage.getItem(key) ?? '{}');
    for (const scope of scopes) if (Number.isSafeInteger(saved[scope])) fallback.set(scope, saved[scope]);
  } catch {
    /* The current tab can still display the response. */
  }
  for (const scope of scopes) {
    const until = fallback.get(scope);
    if (until && until > now && until <= now + 86460000) return { scope, resetAt: until };
  }
}
export function watchQuota(onChange: () => void): () => void {
  changed.addEventListener('change', onChange);
  return () => changed.removeEventListener('change', onChange);
}
export function acceptStartAvailability(scope: 'starts' | 'checking', resetAt: number): void {
  if (!Number.isSafeInteger(resetAt) || resetAt <= Date.now() || resetAt > Date.now() + 86460000) return;
  update(scope, resetAt);
}
export function newStartsPaused(): boolean {
  const scope = currentQuota()?.scope;
  return scope === 'starts' || scope === 'checking' || scope === 'worker';
}
let nextStatusRead = 0,
  statusPending: Promise<void> | undefined;
const staticStatusUrl = () => import.meta.env.VITE_GUESSR_AVAILABILITY_URL || '';
/** Read an independently served, public availability file. Avoid spending a game Worker request to show the closed sign. */
export function refreshStartAvailability(): Promise<void> {
  const url = staticStatusUrl();
  if (!gameApiOrigin() || !url) return Promise.resolve();
  if (statusPending) return statusPending;
  const now = Date.now();
  if (now < nextStatusRead) return Promise.resolve();
  statusPending = (async () => {
    try {
      const response = await fetch(url, {
        credentials: 'omit',
        cache: 'no-cache',
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw Error('Status unavailable');
      const value = (await response.json()) as {state?:unknown; retryAt?:number; validUntil?:number} | null,
        time = Date.now();
      if (
        !value || typeof value.validUntil !== 'number' || typeof value.retryAt !== 'number' ||
        !Number.isSafeInteger(value.validUntil) ||
        value.validUntil <= time ||
        !Number.isSafeInteger(value.retryAt) ||
        value.retryAt > time + 86460000
      )
        throw Error('Stale status');
      if (value.state === 'paused' && value.retryAt > time) {
        acceptStartAvailability('starts', value.retryAt);
        nextStatusRead = value.retryAt;
        return;
      }
      if (value.state !== 'open') throw Error('Availability is being checked');
      // A server-side refusal after this file was published takes precedence over a cached open file.
      if (currentQuota(time)?.scope !== 'starts') update('checking');
      nextStatusRead = Math.min(time + 60000, value.validUntil);
    } catch {
      nextStatusRead = Date.now() + 30000;
      acceptStartAvailability('checking', nextStatusRead);
    }
  })().finally(() => {
    statusPending = undefined;
  });
  return statusPending;
}
export function watchStartMenu(root: HTMLElement): () => void {
  let closed = false,
    timer: ReturnType<typeof setTimeout> | undefined;
  const buttons = root.querySelectorAll<HTMLButtonElement>('[data-guessr-start]');
  const paint = () => {
    buttons.forEach(button => { button.disabled = newStartsPaused(); });
  };
  const refresh = async () => {
    clearTimeout(timer);
    if (closed || document.visibilityState === 'hidden') return;
    await refreshStartAvailability();
    if (closed) return;
    paint();
    timer = setTimeout(() => void refresh(), Math.max(1000, (nextStatusRead || Date.now() + 60000) - Date.now()));
  };
  paint();
  void refresh();
  const stop = watchQuota(paint);
  const visible = () => {
    if (document.visibilityState === 'visible') void refresh();
  };
  document.addEventListener('visibilitychange', visible);
  return () => {
    closed = true;
    stop();
    clearTimeout(timer);
    document.removeEventListener('visibilitychange', visible);
  };
}
function update(scope: SharedQuota, resetAt?: number) {
  currentQuota();
  if (resetAt === fallback.get(scope)) return;
  if (resetAt) fallback.set(scope, resetAt);
  else fallback.delete(scope);
  try {
    sessionStorage.setItem(key, JSON.stringify(Object.fromEntries(fallback)));
  } catch {}
  changed.dispatchEvent(new Event('change'));
}
export async function blockedNewStart(path: string): Promise<QuotaNotice | undefined> {
  if (!['/api/streams/sessions', '/api/games/sessions', '/api/attempts/new'].includes(path)) return;
  await refreshStartAvailability();
  const notice = currentQuota();
  return notice && newStartsPaused() ? notice : undefined;
}
export function startPauseText(notice: QuotaNotice): string {
  return notice.scope === 'checking'
    ? 'New games are paused while availability is checked.'
    : 'New games are paused to let active games finish.';
}
/** Check failed game requests already made by the player. A generic 429, 5xx or socket disconnect is not a daily quota. */
export async function gameFetch(url: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const href = typeof Request !== 'undefined' && url instanceof Request ? url.url : String(url);
  const path = new URL(href, typeof location === 'undefined' ? 'https://local.invalid' : location.origin).pathname;
  if (init?.method === 'POST') {
    const notice = await blockedNewStart(path);
    if (notice)
      return Response.json(
        { error: startPauseText(notice), quota: notice.scope, resetAt: notice.resetAt },
        { status: notice.scope === 'checking' ? 503 : 429 }
      );
  }
  const response = await fetch(url, init);
  if (response.ok) {
    if (currentQuota()?.scope === 'worker') update('worker');
    return response;
  }
  const scope = response.headers?.get('X-Guessr-Daily-Quota') as SharedQuota;
  const reset = Number(response.headers?.get('X-Guessr-Reset-At'));
  if (
    (response.status === 429 || (response.status === 503 && scope === 'checking')) &&
    scopes.includes(scope) &&
    reset > Date.now() &&
    reset <= Date.now() + 86460000
  ) {
    update(scope, reset);
    return response;
  }
  if (response.status < 400 || !response.headers) return response;
  const providerCode = response.headers.get('cf-error-code');
  let exhausted = providerCode === '1027';
  if (
    !exhausted &&
    /^(text\/(?:html|plain)|application\/(?:problem\+)?json)/i.test(response.headers.get('Content-Type') ?? '') &&
    Number(response.headers.get('Content-Length') ?? 0) < 65536 &&
    typeof response.clone === 'function'
  ) {
    // The provider code usually appears in the first chunk. Never read an unbounded error page.
    const probe = response.clone().body?.getReader();
    if (probe) {
      const decoder = new TextDecoder();
      let sample = '';
      try {
        while (sample.length < 16384) {
          const { value, done } = await probe.read();
          if (done) break;
          sample += decoder.decode(value.subarray(0, 16384 - sample.length), { stream: true });
          if (/(?:error(?:\s+code)?\s*:?\s*1027\b|class=["']cf-error-code["']>\s*1027\b)/i.test(sample)) {
            exhausted = true;
            break;
          }
        }
        if (!exhausted && sample.trimStart().startsWith('{')) {
          const json = JSON.parse(sample);
          exhausted =
            json.code === 1027 ||
            (Array.isArray(json.errors) && json.errors.some((e: { code?: number } | null) => e?.code === 1027));
        }
      } catch {
        /* Preserve the normal game error. */
      } finally {
        void probe.cancel().catch(() => {});
      }
    }
  }
  if (exhausted) {
    const date = Date.parse(response.headers.get('Date') ?? '') || Date.now();
    update('worker', (Math.floor(date / 86400000) + 1) * 86400000);
  }
  return response;
}
