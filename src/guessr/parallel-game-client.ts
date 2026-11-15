import { ParallelConnection } from './parallel-connection';
import type { LiveRoomView, RoomConnection } from './live-room-types';
import type { TwitchViewer } from './twitch-viewer';
import { gameApiOrigin } from './api';
import type { ParallelClientMessage, ParallelServerMessage, ParallelSubmission } from './parallel-types';
import type { StreamResult, StreamReveal } from './stream-types';
import type { StreamRoundView } from './stream-round-data';

export interface GameHandlers {
  state(state: LiveRoomView): void;
  status(state: RoomConnection, detail: string): void;
  reveal(round: number, reveal: StreamReveal): void;
  durableReceipt(message: Extract<ParallelServerMessage, { type: 'receipt' }>): void;
  roundResults(results: StreamRoundView): void;
  published(result: StreamResult): void;
}
/** Gameplay has one authenticated durable path. Twitch is used only for login. */
export function watchParallelGame(viewer: TwitchViewer, _channel: string, gameId: string, handlers: GameHandlers, _options: { pvp?: boolean } = {}) {
  let socket: ParallelConnection | undefined, socketUser: string | null = null, closed = false, consented: string | null = null;
  const key = 'noitamap-guessr-joined-v3:' + gameId;
  const explored = new Set<string>();
  const hasJoined = () => {
    const user = viewer.getState();
    if (!user.connected || !user.userId) return false;
    if (consented === user.userId) return true;
    try { return sessionStorage.getItem(key) === user.userId; } catch { return false; }
  };
  const connect = () => {
    const user = viewer.getState();
    if (closed || user.userId === socketUser && socket && user.connected) return;
    socket?.dispose(); socket = undefined; socketUser = null;
    if (!hasJoined() || !user.userId) return;
    socketUser = user.userId;
    socket = new ParallelConnection(gameApiOrigin()!, gameId, user.userId, () => viewer.transportAuthorization(), {
      status: handlers.status,
      message: message => {
        if (message.type === 'state') handlers.state(message.state);
        else if (message.type === 'reveal') {
          handlers.reveal(message.round - 1, message.reveal);
          if (message.results) handlers.roundResults(message.results);
        } else if (message.type === 'receipt') handlers.durableReceipt(message);
        else if (message.type === 'published' && message.result.id === gameId) handlers.published(message.result);
      },
    });
  };
  const unsubscribe = viewer.subscribe(connect);
  connect();
  return {
    hasJoined,
    join() {
      const id = viewer.getState().userId; if (!id) return;
      consented = id; try { sessionStorage.setItem(key, id); } catch {}
      connect();
    },
    now: () => socket?.now() ?? Date.now(),
    command: (message: Extract<ParallelClientMessage, { id: string }>) => {
      connect(); return socket ? socket.command(message) : Promise.reject(Error('Join game'));
    },
    submit: (input: ParallelSubmission) => { connect(); if (!socket) throw Error('Join game'); socket.submit(input); },
    nextRevision: (roundId: string) => socket?.nextRevision(roundId) ?? 1,
    explored(roundId: string) {
      if (_options.pvp || explored.has(roundId) || !socket || !hasJoined()) return;
      explored.add(roundId);
      void socket.command({ type: 'activity', id: 'activity-' + roundId, roundId }).catch(() => explored.delete(roundId));
    },
    requestRecovery: () => socket?.recover(),
    retry: () => { connect(); socket?.retry(); },
    dispose: () => { closed = true; unsubscribe(); socket?.dispose(); },
  };
}
