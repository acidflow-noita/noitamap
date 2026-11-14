import { gameApiOrigin } from './api';
import type { ParallelConnection } from './parallel-connection';
import { validStreamRoundCount } from './stream-types';

const key = 'noitamap-guessr-pvp-resume-v1';
export interface PvpResume { id: string; playerId: string; round: number; rounds: number; completed: number; complete?: boolean; lobby?: boolean; creator?: boolean }
export function readPvpResume(): PvpResume | undefined {
  try {
    const raw = localStorage.getItem(key); if (!raw || raw.length > 2048) return;
    const saved = JSON.parse(raw);
    if (/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(saved.id) && /^\d{1,30}$/.test(saved.playerId) && validStreamRoundCount(saved.rounds)
      && Number.isInteger(saved.round) && saved.round >= 1 && saved.round <= saved.rounds
      && Number.isInteger(saved.completed) && saved.completed >= 0 && saved.completed <= saved.rounds) return {
        id: saved.id, playerId: saved.playerId, round: saved.round, rounds: saved.rounds, completed: saved.completed,
        complete: saved.complete === true, lobby: saved.lobby === true, creator: saved.creator === true,
      };
  } catch { /* Optional navigation bookmark, never authentication. */ }
}
export function rememberPvp(resume: PvpResume): void {
  try { localStorage.setItem(key, JSON.stringify(resume)); } catch {}
}
export function forgetPvp(id: string): void {
  try { if (readPvpResume()?.id === id) localStorage.removeItem(key); } catch {}
}
export async function leaveSavedPvp(saved: PvpResume): Promise<void> {
  const origin = gameApiOrigin(); if (!origin) throw Error('1v1 is not available on this site yet.');
  const [{ TwitchViewer }, { ParallelConnection }] = await Promise.all([import('./twitch-viewer'), import('./parallel-connection')]);
  const viewer = new TwitchViewer({ chat: false }); let connection: ParallelConnection | undefined;
  try {
    await viewer.ready;
    if (!viewer.getState().connected) await viewer.connect();
    if (viewer.getState().userId !== saved.playerId) throw Error('Sign in with Twitch to play.');
    await new Promise<void>((resolve, reject) => {
      let sent = false;
      const timer = setTimeout(() => reject(Error('Connection unavailable. Reconnecting…')), 30000);
      const done = (error?: unknown) => { clearTimeout(timer); if (error) reject(error); else resolve(); };
      connection = new ParallelConnection(origin, saved.id, saved.playerId, () => viewer.transportAuthorization(), {
        message() {},
        status(status, detail) {
          if (status === 'stopped') { done(Error(detail)); return; }
          if (status === 'connected' && !sent) { sent = true; void connection!.command({ type: 'quit', id: crypto.randomUUID() }).then(() => done(), done); }
        },
      });
    });
    forgetPvp(saved.id);
  } finally { connection?.dispose(); viewer.dispose(); }
}
