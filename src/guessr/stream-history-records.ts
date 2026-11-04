const key = 'noitamap-guessr-published-history';
export interface PublishedStreamVisit { id: string; channel: string; at: number }
export function readPublishedStreamVisits(): PublishedStreamVisit[] {
  try {
    const rows = JSON.parse(localStorage.getItem(key) ?? '[]');
    return Array.isArray(rows) ? rows.filter(row => /^[a-f0-9-]{36}$/.test(row?.id)
      && /^[a-z0-9_]{1,25}$/.test(row?.channel) && Number.isSafeInteger(row?.at)).slice(0, 100) : [];
  } catch { return []; }
}
/** Index only confirmed public links. Full results stay in D1 and are fetched
 * on demand, never once per chatter during the round or on a timer. */
export function rememberPublishedStream(id: string, channel: string): void {
  const rows = readPublishedStreamVisits();
  if (rows.some(row => row.id === id)) return;
  try { localStorage.setItem(key, JSON.stringify([{ id, channel, at: Date.now() }, ...rows].slice(0, 100))); }
  catch { /* The result remains published and discoverable by channel. */ }
}
