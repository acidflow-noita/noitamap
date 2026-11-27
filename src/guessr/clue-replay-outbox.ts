import { REPLAY_BATCH, REPLAY_LIMIT, validReplayFrame, type ReplayFrame, type CameraAction } from './clue-replay';
import type { Camera } from './clue-camera';
import type { ParallelClientMessage } from './parallel-types';

type Pending = { last: ReplayFrame; count: number; frames: ReplayFrame[] };
type Message = Extract<ParallelClientMessage, { type: 'clue-frames' }>;

/** Persist only this tab's unacknowledged camera changes and its last pose.
 * A guess and a reconnect flush those changes before their following commands. */
export class ClueReplayOutbox {
  private rounds = new Map<string, Pending>();
  private sent = new Map<string, number>();
  private timer?: ReturnType<typeof setTimeout>;
  constructor(
    private key: string,
    private send: (message: Message) => boolean
  ) {
    try {
      const stored = JSON.parse(sessionStorage.getItem(key) ?? '[]');
      if (Array.isArray(stored))
        for (const [id, row] of stored.slice(-10)) {
          if (
            typeof id === 'string' &&
            validReplayFrame(row?.last, {}) &&
            Number.isInteger(row.count) &&
            row.count >= 1 &&
            row.count <= REPLAY_LIMIT + 1 &&
            Array.isArray(row.frames) &&
            row.frames.length <= row.count &&
            row.frames.every((f: unknown) => validReplayFrame(f, {}))
          )
            this.rounds.set(id, row);
        }
    } catch {
      /* Optional tab recovery. */
    }
  }
  private save() {
    try {
      if (this.rounds.size) sessionStorage.setItem(this.key, JSON.stringify([...this.rounds]));
      else sessionStorage.removeItem(this.key);
    } catch {
      /* The live outbox still works without storage. */
    }
  }
  record(roundId: string, camera: Camera, time: number, action?: CameraAction) {
    const row = this.rounds.get(roundId);
    if (
      row &&
      (row.count > REPLAY_LIMIT ||
        (row.last[1] === camera.dx && row.last[2] === camera.dy && row.last[3] === camera.level))
    )
      return;
    const frame: ReplayFrame = [
      Math.max(Math.round(time), (row?.last[0] ?? 0) + 1),
      camera.dx,
      camera.dy,
      camera.level,
    ];
    if (action) frame.push(action);
    if (row) {
      row.last = frame;
      row.count++;
      row.frames.push(frame);
    } else this.rounds.set(roundId, { last: frame, count: 1, frames: [frame] });
    this.save();
    if (!row) this.flush();
    else this.timer ??= setTimeout(() => this.flush(), 1500);
  }
  flush() {
    clearTimeout(this.timer);
    this.timer = undefined;
    let batches = 0;
    for (const [roundId, row] of this.rounds) {
      const since = this.sent.get(roundId) ?? 0;
      const first = row.frames.findIndex(f => f[0] > since);
      if (first < 0) continue;
      for (let i = first; i < row.frames.length; i += REPLAY_BATCH) {
        // A long reconnect stays below the socket's flood limit and leaves
        // room for the time-sensitive guess queued immediately after this.
        if (batches >= 2) {
          this.timer = setTimeout(() => this.flush(), 1500);
          return;
        }
        const frames = row.frames.slice(i, i + REPLAY_BATCH);
        if (!this.send({ type: 'clue-frames', roundId, frames })) return;
        batches++;
        this.sent.set(roundId, frames[frames.length - 1][0]);
      }
    }
  }
  reconnect() {
    this.sent.clear();
    this.flush();
  }
  acknowledge(roundId: string, through: number) {
    const row = this.rounds.get(roundId);
    if (!row || !Number.isSafeInteger(through)) return;
    row.frames = row.frames.filter(frame => frame[0] > through);
    this.save();
  }
  dispose() {
    clearTimeout(this.timer);
  }
  clear() {
    this.dispose();
    this.rounds.clear();
    this.sent.clear();
    this.save();
  }
}
