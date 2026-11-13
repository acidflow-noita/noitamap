import { ParallelConnection } from './parallel-connection';
import { watchTwitchGame } from './twitch-game-client';
import type { TwitchViewer } from './twitch-viewer';
import { gameApiOrigin } from './api';
import type { ParallelServerMessage, ParallelSubmission } from './parallel-types';
import type { RoomConnection } from './live-room-types';

type Handlers = Parameters<typeof watchTwitchGame>[3] & {
  durableReceipt(message: Extract<ParallelServerMessage, { type: 'receipt' }>): void;
  roundResults(results: import('./stream-round-data').StreamRoundView): void;
  published(result: import('./stream-types').StreamResult): void;
};
/** Both transports run concurrently. Twitch receipts in this mode originate
 * from the coordinator's committed acknowledgements, never optimistic sends. */
export function watchParallelGame(viewer: TwitchViewer, channel: string, gameId: string, handlers: Handlers) {
  let socket: ParallelConnection | undefined, socketUser: string | null = null, closed = false;
  let twitchStatus: RoomConnection = 'connecting', socketStatus: RoomConnection = 'connecting';
  const revisions = new Map<string, number>();
  const status = () => {
    const healthy = socketStatus === 'connected' || twitchStatus === 'connected';
    handlers.status(healthy ? 'connected' : socketStatus, healthy ? '' : socketStatus === 'stopped' ? 'Sign in with Twitch to play.' : 'Reconnecting…');
  };
  const legacy = watchTwitchGame(viewer, channel, gameId, { ...handlers,
    status: state => { twitchStatus = state; status(); },
    state: state => { if (!socket?.connected()) handlers.state(state); },
  });
  const connect = () => {
    const user = viewer.getState();
    if (closed || user.userId === socketUser && socket) return;
    socket?.dispose(); socket = undefined; socketUser = null;
    if (!user.connected || !user.userId) return;
    socketUser = user.userId; legacy.join();
    socket = new ParallelConnection(gameApiOrigin()!, gameId, user.userId, () => viewer.transportAuthorization(), {
      status: state => { socketStatus = state; status(); },
      message: message => {
        if (message.type === 'authorized') for (const [id, revision] of Object.entries(message.acceptedRevisions ?? {})) revisions.set(id, Math.max(revision, revisions.get(id) ?? 0));
        else if (message.type === 'state') handlers.state(message.state);
        else if (message.type === 'reveal') {
          handlers.reveal(message.round - 1, message.reveal);
          if (message.results) handlers.roundResults(message.results);
        }
        else if (message.type === 'receipt') {
          if (message.accepted) revisions.set(message.roundId, Math.max(message.revision, revisions.get(message.roundId) ?? 0));
          handlers.durableReceipt(message);
        }
        else if (message.type === 'published' && message.result.id === gameId) handlers.published(message.result);
      },
    });
  };
  const unsubscribe = viewer.subscribe(connect);
  connect();
  return {
    ...legacy,
    hasJoined: () => viewer.getState().connected,
    join: connect,
    now: () => socket?.connected() ? socket.now() : legacy.now(),
    submit: (input: ParallelSubmission) => { connect(); socket?.submit(input); },
    nextRevision: (roundId: string) => (revisions.get(roundId) ?? 0) + 1,
    requestRecovery: () => { if (socket?.connected()) socket.recover(); else legacy.requestRecovery(); },
    retry: () => { socket?.retry(); legacy.retry(); },
    dispose: () => { closed = true; unsubscribe(); socket?.dispose(); legacy.dispose(); },
  };
}
