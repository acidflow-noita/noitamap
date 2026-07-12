/**
 * tab-coordinator.ts
 *
 * Cross-tab handoff for mod-launched URLs.
 *
 * The Noita Lua mod opens noitamap by shelling out to the OS, which spawns a
 * new browser tab every time the user presses M. When an existing noitamap
 * tab is already open we'd rather reuse it: replace its URL with the new
 * params (updated coords / unlocks / seed) and reload, then close the
 * duplicate tab the shell just opened.
 *
 * Mechanism: the mod appends `src=mod` to its URL. On load, if that marker
 * is present we broadcast a handoff request via BroadcastChannel. Any
 * existing tab on the same origin acks it, applies the new URL and reloads.
 * The duplicate tab swaps its body for a "you can close this" message and
 * attempts window.close() (works in browsers that allow scripts to close
 * single-history-entry tabs; falls back to a manual close button).
 */
const CHANNEL_NAME = "noitamap-tabs";
const HANDOFF_PARAM = "src";
const HANDOFF_VALUE = "mod";
const ACK_TIMEOUT_MS = 200;

let channel: BroadcastChannel | null = null;
try {
  channel = new BroadcastChannel(CHANNEL_NAME);
} catch {
  channel = null;
}

function urlHasModMarker(href: string): boolean {
  try {
    return new URL(href).searchParams.get(HANDOFF_PARAM) === HANDOFF_VALUE;
  } catch {
    return false;
  }
}

function stripModMarker(href: string): string {
  try {
    const u = new URL(href);
    u.searchParams.delete(HANDOFF_PARAM);
    return u.toString();
  } catch {
    return href;
  }
}

if (channel) {
  channel.addEventListener("message", (ev) => {
    const msg = ev.data;
    if (!msg || typeof msg !== "object" || msg.type !== "handoff") return;
    if (typeof msg.sourceId !== "string" || typeof msg.url !== "string") return;
    try {
      const target = new URL(msg.url);
      if (target.origin !== window.location.origin || !urlHasModMarker(target.toString())) return;
      channel!.postMessage({ type: "handoff-ack", sourceId: msg.sourceId });
      window.location.replace(stripModMarker(target.toString()));
    } catch (e) {
      console.warn("[Noitamap] handoff URL invalid", e);
    }
  });
}

function showClosablePlaceholder() {
  const html = `
    <div style="position:fixed;inset:0;display:flex;align-items:center;justify-content:center;font-family:system-ui,-apple-system,sans-serif;background:#0f172a;color:#cbd5e1;">
      <div style="text-align:center;padding:2rem;max-width:420px;">
        <h2 style="margin:0 0 .5em;font-weight:600;">Updated existing Noitamap tab</h2>
        <p style="margin:0 0 1.25em;color:#94a3b8;">You can close this tab.</p>
        <button id="nm-close-btn" style="padding:.6em 1.2em;border:1px solid #475569;background:transparent;color:#cbd5e1;border-radius:.375em;cursor:pointer;font-size:1rem;">Close tab</button>
      </div>
    </div>`;
  document.body.innerHTML = html;
  const btn = document.getElementById("nm-close-btn");
  if (btn) btn.addEventListener("click", () => { try { window.close(); } catch {} });
}

export async function negotiateTabHandoff(): Promise<boolean> {
  if (!channel) return true;
  if (!urlHasModMarker(window.location.href)) return true;

  const myId = Math.random().toString(36).slice(2);
  let acked = false;
  const onMsg = (ev: MessageEvent) => {
    const msg = ev.data;
    if (msg?.type === "handoff-ack" && msg.sourceId === myId) acked = true;
  };
  channel.addEventListener("message", onMsg);

  try {
    channel.postMessage({ type: "handoff", sourceId: myId, url: window.location.href });
  } catch {}

  await new Promise((r) => setTimeout(r, ACK_TIMEOUT_MS));
  channel.removeEventListener("message", onMsg);

  if (!acked) {
    try {
      const cleaned = stripModMarker(window.location.href);
      if (cleaned !== window.location.href) {
        history.replaceState({}, "", cleaned);
      }
    } catch {}
    return true;
  }

  const showPlaceholder = () => {
    if (document.body) showClosablePlaceholder();
    else document.addEventListener("DOMContentLoaded", showClosablePlaceholder, { once: true });
  };
  showPlaceholder();
  try { window.close(); } catch {}
  return false;
}
