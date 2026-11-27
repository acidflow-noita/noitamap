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
  let socket: ParallelConnection | undefined, socketUser: string | null = null, joinedUser: string | null = null, closed = false, epoch = 0;
  const explored = new Set<string>();
  const hasJoined = () => {
    const user = viewer.getState();
    return !closed && user.connected && !!user.userId && joinedUser === user.userId;
  };
  const connect = () => {
    const user = viewer.getState();
    if (closed || user.userId === socketUser && socket && user.connected) return;
    const currentEpoch = ++epoch;
    socketUser = null; joinedUser = null; socket?.dispose(); socket = undefined;
    if (!user.connected || !user.userId) return;
    socketUser = user.userId;
    const current = () => !closed && epoch === currentEpoch;
    socket = new ParallelConnection(gameApiOrigin()!, gameId, user.userId, renew => viewer.transportAuthorization(renew), {
      status: (state, detail) => { if (current()) handlers.status(state, detail); },
      message: message => {
        if (!current()) return;
        if (message.type === 'state' && message.state.gameId === gameId) {
          joinedUser = user.userId; handlers.state(message.state);
        }
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
    now: () => socket?.now() ?? Date.now(),
    command: (message: Extract<ParallelClientMessage, { id: string }>) => {
      connect(); return socket ? socket.command(message) : Promise.reject(Error('Join game'));
    },
    submit: (input: ParallelSubmission) => { connect(); if (!socket) throw Error('Join game'); socket.submit(input); },
    recordCamera: (roundId: string, camera: import('./clue-camera').Camera, action?: import('./clue-replay').CameraAction) => socket?.recordCamera(roundId, camera, action),
    recordMap: (roundId: string, pose: import('./guess-map-replay').MapPose, action: import('./guess-map-replay').MapReplayAction, at: number) =>
      socket?.recordMap(roundId, pose, action, at),
    readReplay: (round: number, player: string, signal: AbortSignal) =>
      socket ? socket.readReplay(round, player, signal) : Promise.reject(Error('Connection unavailable. Reconnecting…')),
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
