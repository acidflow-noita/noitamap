/** Mod URLs arrive in a new browser tab. Transfer them to ONE ready tab,
 * keeping its renderer alive; only close the duplicate after acceptance. */
const CHANNEL_NAME = 'noitamap-tabs';
const DISCOVERY_TIMEOUT_MS = 200;
// A ready but busy/backgrounded tab may not service BroadcastChannel within
// 200ms. Only wait longer when a live document advertises its ready lock.
const BUSY_DISCOVERY_TIMEOUT_MS = 5000;
const ACCEPT_TIMEOUT_MS = 1000;
const READY_LOCK_PREFIX = 'noitamap-ready:';

type Port = Pick<BroadcastChannel, 'postMessage' | 'addEventListener' | 'removeEventListener'>;
interface CoordinatorOptions {
  channel: Port | null;
  href(): string;
  replaceURL(url: string): void;
  closeDuplicate(): void;
  receiverPresent?(): Promise<boolean>;
  id?: string;
  now?: () => number;
}
const marker = (href: string) => {
  try { return new URL(href).searchParams.get('src') === 'mod'; }
  catch { return false; }
};
function clean(href: string): string {
  const url = new URL(href); url.searchParams.delete('src'); return url.href;
}

export function createTabCoordinator(options: CoordinatorOptions) {
  const port = options.channel, id = options.id ?? globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
  const now = options.now ?? Date.now;
  let accept: ((url: string) => boolean) | undefined;
  let pending: { sourceId: string; url: string; targetId?: string; done: (accepted: boolean) => void } | undefined;
  let negotiation: Promise<boolean> | undefined;
  const offers = new Map<string, { url: string; until: number }>();
  const validURL = (url: unknown): url is string => {
    try { return typeof url === 'string' && marker(url) && new URL(url).origin === new URL(options.href()).origin; }
    catch { return false; }
  };
  const post = (message: object) => { try { port?.postMessage(message); return true; } catch { return false; } };
  const listener = (event: Event) => {
    const msg = (event as MessageEvent).data;
    if (!msg || typeof msg !== 'object' || typeof msg.sourceId !== 'string') return;
    if (msg.type === 'handoff-v2-request') {
      if (!accept || pending || !validURL(msg.url) || !Number.isFinite(msg.until) || msg.until < now()) return;
      for (const [key, offer] of offers) if (offer.until < now()) offers.delete(key);
      if (offers.size >= 64) return;
      // Bound leases using this document's clock. Rounded clocks in separate
      // tabs can differ slightly; rejecting a deadline even 1ms beyond the
      // local maximum can discard a valid request or application message.
      offers.set(msg.sourceId, { url: msg.url,
        until: Math.min(msg.until, now() + BUSY_DISCOVERY_TIMEOUT_MS) + ACCEPT_TIMEOUT_MS });
      post({ type: 'handoff-v2-offer', sourceId: msg.sourceId, targetId: id });
    } else if (msg.type === 'handoff-v2-offer') {
      if (!pending || msg.sourceId !== pending.sourceId || pending.targetId || typeof msg.targetId !== 'string' || msg.targetId === id) return;
      pending.targetId = msg.targetId;
      // An answer is handled immediately. Timers only bound absent/dead tabs.
      arm(ACCEPT_TIMEOUT_MS);
      if (!post({ type: 'handoff-v2-apply', sourceId: pending.sourceId, targetId: msg.targetId,
        url: pending.url, until: now() + ACCEPT_TIMEOUT_MS })) pending.done(false);
    } else if (msg.type === 'handoff-v2-apply') {
      if (msg.targetId !== id || !accept || !validURL(msg.url)) return;
      const offer = offers.get(msg.sourceId);
      offers.delete(msg.sourceId); // A repeated apply must never trigger a second generation.
      if (!offer || offer.url !== msg.url || offer.until < now() || !Number.isFinite(msg.until)
        || msg.until < now()) return;
      let accepted = false;
      try { accepted = accept(msg.url); }
      catch (error) { console.warn('[Noitamap] Mod handoff failed:', error); }
      post({ type: 'handoff-v2-result', sourceId: msg.sourceId, targetId: id, accepted });
      if (accepted) { try { window.focus(); } catch {} }
    } else if (msg.type === 'handoff-v2-result') {
      if (pending && msg.sourceId === pending.sourceId && msg.targetId === pending.targetId)
        pending.done(msg.accepted === true);
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = (ms: number) => { clearTimeout(timer); timer = setTimeout(() => pending?.done(false), ms); };
  port?.addEventListener('message', listener);
  return {
    register(handler: (url: string) => boolean) { accept = handler; return () => { if (accept === handler) accept = undefined; }; },
    negotiate(): Promise<boolean> {
      if (!port || !marker(options.href())) return Promise.resolve(true);
      if (negotiation) return negotiation;
      negotiation = new Promise<boolean>(resolve => {
        const url = options.href(), sourceId = `${id}:${now()}`;
        pending = { sourceId, url, done(accepted) {
          if (pending?.sourceId !== sourceId) return;
          accepted = accepted && options.href() === url;
          clearTimeout(timer); pending = undefined;
          if (accepted) options.closeDuplicate();
          else if (options.href() === url) options.replaceURL(clean(url));
          resolve(!accepted);
        } };
        let discovered = false;
        const discover = (present: boolean) => {
          if (discovered || pending?.sourceId !== sourceId) return;
          discovered = true;
          const deadline = present ? BUSY_DISCOVERY_TIMEOUT_MS : DISCOVERY_TIMEOUT_MS;
          arm(deadline);
          if (!post({ type: 'handoff-v2-request', sourceId, url, until: now() + deadline })) pending?.done(false);
        };
        if (options.receiverPresent) {
          // A broken presence API must not prevent a standalone tab loading.
          timer = setTimeout(() => discover(false), DISCOVERY_TIMEOUT_MS);
          Promise.resolve().then(options.receiverPresent).then(discover, () => discover(false));
        } else discover(false);
      });
      return negotiation;
    },
    dispose() {
      pending?.done(false); clearTimeout(timer); accept = undefined; offers.clear();
      port?.removeEventListener('message', listener);
    },
  };
}

function closeDuplicate() {
  const show = () => {
    document.body.innerHTML = `<div style="position:fixed;inset:0;display:flex;align-items:center;justify-content:center;font-family:system-ui,sans-serif;background:#0f172a;color:#cbd5e1;">
      <div style="text-align:center;padding:2rem;max-width:420px;"><h2>Updated existing Noitamap tab</h2>
      <p>You can close this tab.</p><button id="nm-close-btn">Close tab</button></div></div>`;
    document.getElementById('nm-close-btn')?.addEventListener('click', () => { try { window.close(); } catch {} });
  };
  if (document.body) show(); else document.addEventListener('DOMContentLoaded', show, { once: true });
  try { window.close(); } catch {}
}
let channel: BroadcastChannel | null = null;
try { channel = new BroadcastChannel(CHANNEL_NAME); } catch {}
const tabId = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
const coordinator = createTabCoordinator({ channel, id: tabId, href: () => window.location.href,
  receiverPresent: async () => {
    const snapshot = await navigator.locks?.query();
    return snapshot?.held?.some(lock => lock.name?.startsWith(READY_LOCK_PREFIX)) ?? false;
  },
  replaceURL: href => history.replaceState(history.state, '', href), closeDuplicate });
export const negotiateTabHandoff = () => coordinator.negotiate();
export function registerTabHandoff(accept: (url: string) => boolean) {
  let unregister: (() => void) | undefined, release: (() => void) | undefined;
  const suspend = () => { unregister?.(); unregister = undefined; release?.(); release = undefined; };
  const resume = () => {
    suspend();
    unregister = coordinator.register(accept);
    try {
      if (!navigator.locks) return;
      const controller = new AbortController();
      let finish = () => {};
      void navigator.locks.request(READY_LOCK_PREFIX + tabId, { signal: controller.signal }, () =>
        new Promise<void>(resolve => { finish = resolve; })).catch(() => {});
      release = () => { controller.abort(); finish(); };
    } catch { /* Presence is optional, including in restricted embeds/profiles. */ }
  };
  resume();
  // Release on real navigation as well as bfcache entry; restore on return.
  window.addEventListener('pagehide', suspend);
  window.addEventListener('pageshow', resume);
  return () => {
    suspend(); window.removeEventListener('pagehide', suspend); window.removeEventListener('pageshow', resume);
  };
}
