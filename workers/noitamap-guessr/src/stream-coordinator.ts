import { DurableObject } from 'cloudflare:workers';
import type { Env } from './index';
import { authorizeSocket, socketTicket } from './stream-socket-auth';
import { persistStreamResult } from './result-publication';
import { acceptParallelGuess, beginParallel, createParallelRecord, directGuessMessage, joinParallelPlayer,
  nextParallelAlarm, parallelResult, submitParallelHost, tickParallel, ParallelActionError, type ParallelRecord } from '../../../src/guessr/parallel-core';
import type { ParallelClientMessage, ParallelIdentity, ParallelInitialization, ParallelServerMessage } from '../../../src/guessr/parallel-types';
import { streamSnapshot } from '../../../src/guessr/stream-snapshot';
import { advanceStreamRound, streamResult, type StreamChatMessage } from '../../../src/guessr/stream-state';
import type { StreamParticipant } from '../../../src/guessr/stream-types';
import { STREAM_MAX_PLAYERS } from '../../../src/guessr/stream-types';
import { parseGuessCommand } from '../../../src/guessr/guess-command';
import { streamJoinRequest } from '../../../src/guessr/stream-join-request';
import { ImageGameError } from '../../../src/guessr/image-game-server';
import { streamPlayerName } from '../../../src/guessr/stream-display-name';
import { streamRoundData, type StreamRoundView } from '../../../src/guessr/stream-round-data';
import { pvpSnapshot } from '../../../src/guessr/pvp-state';

interface Attachment { revealed?: number; generation?: number; identity?: ParallelIdentity; opened: number; count: number; since: number }
class GameStorageError extends Error {
  constructor(cause: unknown) { super('Game storage is temporarily unavailable.', { cause }); }
}
/** One authenticated, hibernating coordinator per game. Both delivery paths
 * converge here; a receipt is emitted only after its transaction is durable. */
export class StreamCoordinator extends DurableObject<Env> {
  private record?: ParallelRecord;
  private queue: Promise<unknown> = Promise.resolve();
  private roundViews = new Map<number, StreamRoundView>();
  private storedRounds = new Set<number>();
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    // Do not allocate a database for arbitrary guessed IDs.
    if (ctx.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name='game'").toArray().length) this.restore();
  }
  private restore(): void {
    const row = this.ctx.storage.sql.exec<{ data: string }>('SELECT data FROM game WHERE id=1').toArray()[0];
    if (!row) { this.record = undefined; return; }
    this.record = JSON.parse(row.data);
    this.record!.game.participants = this.ctx.storage.sql.exec<{ data: string }>('SELECT data FROM players ORDER BY ordinal').toArray().map(r => JSON.parse(r.data));
    this.storedRounds = new Set(this.ctx.storage.sql.exec<{ ordinal: number }>('SELECT ordinal FROM round_results').toArray().map(r => r.ordinal));
    this.roundViews.clear();
  }
  private exclusive<T>(action: () => Promise<T>): Promise<T> {
    const run = this.queue.then(action);
    this.queue = run.catch(() => {});
    return run;
  }
  async initialize(input: ParallelInitialization): Promise<void> {
    return this.exclusive(async () => {
      if (this.record) throw Error('Game already exists');
      this.record = createParallelRecord(input, Date.now());
      this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS game (id INTEGER PRIMARY KEY, data TEXT NOT NULL)');
      this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS players (id TEXT PRIMARY KEY, ordinal INTEGER NOT NULL, data TEXT NOT NULL)');
      this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS round_results (ordinal INTEGER PRIMARY KEY, data TEXT NOT NULL)');
      await this.persist(this.record.game.participants);
      await this.schedule();
    });
  }
  private async persist(players: StreamParticipant[] = [], removed: string[] = []): Promise<void> {
    const record = this.record!;
    try {
      this.ctx.storage.transactionSync(() => {
        for (const id of removed) record.metrics.storageRowsWritten += this.ctx.storage.sql.exec('DELETE FROM players WHERE id=?', id).rowsWritten;
        record.game.reveals.forEach((reveal, round) => {
          if (!reveal || this.storedRounds.has(round)) return;
          const view = streamRoundData(record.game, round);
          const write = this.ctx.storage.sql.exec('INSERT INTO round_results(ordinal,data) VALUES(?,?)', round, JSON.stringify(view));
          record.metrics.storageRowsWritten += write.rowsWritten; this.storedRounds.add(round); this.roundViews.set(round, view);
        });
        for (const player of players) {
          const write = this.ctx.storage.sql.exec('INSERT INTO players(id,ordinal,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',
            player.id, record.game.participants.indexOf(player), JSON.stringify(player));
          record.metrics.storageRowsWritten += write.rowsWritten;
        }
        record.metrics.storageRowsWritten++; // The single integer-primary-key metadata row.
        const metadata = { ...record, game: { ...record.game, participants: [], recentNonces: {} } };
        this.ctx.storage.sql.exec('INSERT INTO game(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data', JSON.stringify(metadata));
      });
      await this.ctx.storage.sync();
    } catch (error) {
      try { this.restore(); } catch { /* A storage reset can make the old instance unusable. */ }
      throw new GameStorageError(error);
    }
  }
  async fetch(request: Request): Promise<Response> {
    const origin = request.headers.get('Origin');
    if (!origin || !(this.env.ALLOWED_ORIGINS ?? '').split(',').map(v => v.trim()).includes(origin)) return new Response('Forbidden', { status: 403 });
    if (request.method !== 'GET' || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('WebSocket required', { status: 426 });
    if (!this.record || Date.now() > this.retentionDeadline()) return new Response('Game unavailable', { status: 404 });
    const sockets = this.ctx.getWebSockets();
    if (sockets.length >= (this.record.game.pvp ? 8 : STREAM_MAX_PLAYERS * 2 + 32)
      || sockets.filter(s => !this.attachment(s).identity).length >= (this.record.game.pvp ? 4 : 64)) return new Response('Game is busy', { status: 503 });
    const pair = new WebSocketPair(), client = pair[0], server = pair[1];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ opened: Date.now(), count: 0, since: Date.now() } satisfies Attachment);
    this.record.metrics.upgrades++;
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null || alarm > Date.now() + 15000) await this.ctx.storage.setAlarm(Date.now() + 15000);
    return new Response(null, { status: 101, webSocket: client });
  }
  private attachment(socket: WebSocket): Attachment { return socket.deserializeAttachment() as Attachment; }
  private send(socket: WebSocket, message: ParallelServerMessage): void {
    try { socket.send(JSON.stringify(message)); } catch { try { socket.close(1011, 'Connection interrupted'); } catch {} }
  }
  private sendTo(id: string, message: ParallelServerMessage): void {
    for (const socket of this.ctx.getWebSockets()) if (this.attachment(socket).identity?.id === id) this.send(socket, message);
  }
  private hosts(message: ParallelServerMessage): void {
    if (this.record?.game.pvp) return;
    for (const socket of this.ctx.getWebSockets()) if (this.attachment(socket).identity?.role === 'host') this.send(socket, message);
  }
  private receipt(socket: WebSocket, player: StreamParticipant, round: number): void {
    const guess = player.guesses[round];
    if (guess?.nonce && guess.revision) this.send(socket, { type: 'receipt', round: round + 1, roundId: this.record!.game.session.rounds[round].id,
      nonce: guess.nonce, revision: guess.revision, accepted: true, point: guess.point ?? undefined, maximum: guess.maximum, automatic: guess.automatic });
  }
  private roundView(round: number): StreamRoundView | undefined {
    if (!this.storedRounds.has(round)) return;
    if (!this.roundViews.has(round)) {
      const row = this.ctx.storage.sql.exec<{ data: string }>('SELECT data FROM round_results WHERE ordinal=?', round).toArray()[0];
      if (row) this.roundViews.set(round, JSON.parse(row.data));
    }
    return this.roundViews.get(round);
  }
  private snapshot(socket: WebSocket, history = false): void {
    const record = this.record!, attachment = this.attachment(socket), identity = attachment.identity;
    if (!identity || identity.expiresAt <= Date.now()) return;
    const now = Date.now();
    if (identity.role === 'host' && !record.game.pvp) this.send(socket, { type: 'host', game: { ...record.game, recentNonces: undefined, receipts: undefined }, metrics: record.metrics, now,
      publicationError: record.publicationError, ended: record.ended });
    else {
      this.send(socket, { type: 'state', state: record.game.pvp ? pvpSnapshot(record.game, identity.id, this.env.STREAM_IMAGE_ROOT ?? '', record.ended)
        : streamSnapshot(record.game, this.env.STREAM_IMAGE_ROOT ?? '', record.ended), now });
      if (history) {
        const player = record.game.participants.find(p => p.id === identity.id);
        if (player) player.guesses.forEach((_, i) => this.receipt(socket, player, i));
      }
      record.game.reveals.forEach((reveal, round) => {
        if (reveal && (history || !((attachment.revealed ?? 0) & 1 << round))) {
          this.send(socket, { type: 'reveal', round: round + 1, reveal, results: this.roundView(round) }); attachment.revealed = (attachment.revealed ?? 0) | 1 << round;
        }
      });
      socket.serializeAttachment(attachment);
    }
    if (record.publishedAt) this.send(socket, { type: 'published', result: streamResult(record.game) });
  }
  private broadcast(): void { for (const socket of this.ctx.getWebSockets()) this.snapshot(socket); }
  async webSocketMessage(socket: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== 'string' || raw.length > 8192) { socket.close(1009, 'Message too large'); return; }
    const attachment = this.attachment(socket), now = Date.now();
    if (now - attachment.since > 30000) { attachment.since = now; attachment.count = 0; }
    if (++attachment.count > (attachment.identity?.role === 'host' ? 20000 : 90)) { socket.close(1008, 'Slow down'); return; }
    socket.serializeAttachment(attachment);
    let message: ParallelClientMessage;
    try { message = JSON.parse(raw); } catch { socket.close(1007, 'Invalid message'); return; }
    if (!message || typeof message !== 'object') { socket.close(1007, 'Invalid message'); return; }
    if (message.type === 'authorize') {
      if (!attachment.identity && now - attachment.opened > 15000) { socket.close(1008, 'Authentication expired'); return; }
      try {
        const identity = await authorizeSocket(this.env, this.record!, message, now);
        if (!identity || attachment.identity && attachment.identity.id !== identity.id) {
          this.send(socket, { type: 'error', code: 'auth', message: 'Sign in with Twitch to play.' }); socket.close(4001, 'Authorization required'); return;
        }
        if (this.record!.game.pvp && identity.id === this.record!.game.session.host.id) {
          identity.role = 'host'; identity.owner = this.record!.owner;
        }
        await this.exclusive(async () => {
          const record = this.record!;
          const existing = record.game.participants.find(p => p.id === identity.id);
          if (record.game.pvp && !existing && (record.game.stage === 'complete' || record.ended)) throw new ParallelActionError('This invitation is not available.');
          const active = !record.ended && record.game.stage !== 'complete';
          const player = active ? joinParallelPlayer(record, identity) : existing ?? {
            id: identity.id, login: identity.login, name: streamPlayerName(identity.name, identity.login), color: identity.color,
            guesses: record.game.session.rounds.map(() => null),
          };
          // Strip authorization fields before participant persistence/publication.
          delete (player as Partial<ParallelIdentity>).role; delete (player as Partial<ParallelIdentity>).owner; delete (player as Partial<ParallelIdentity>).expiresAt;
          if (attachment.identity) record.metrics.reauthorizations = (record.metrics.reauthorizations ?? 0) + 1;
          else {
            record.metrics.authenticated++;
            const key = identity.role + ':' + identity.id;
            record.socketIdentities ??= [];
            if (record.socketIdentities.includes(key)) record.metrics.reconnects++;
            else record.socketIdentities.push(key);
          }
          if (record.game.pvp && !attachment.identity) {
            record.game.pvp.controllers ??= {};
            attachment.generation = (record.game.pvp.controllers[identity.id] ?? 0) + 1;
            record.game.pvp.controllers[identity.id] = attachment.generation;
          }
          attachment.identity = identity; socket.serializeAttachment(attachment);
          // Close older same-role sockets, preventing two host tabs from racing.
          for (const other of this.ctx.getWebSockets()) {
            const prior = this.attachment(other).identity;
            if (other !== socket && prior?.id === identity.id && prior.role === identity.role) other.close(4002, 'Opened in another tab');
          }
          if (active || record.game.pvp) await this.persist(active ? [player] : []);
          this.send(socket, { type: 'authorized', player: { id: player.id, login: player.login, name: player.name, color: player.color },
            ticket: await socketTicket(this.env, record.game.session.id, identity), expiresAt: identity.expiresAt, now: Date.now(),
            acceptedRevisions: Object.fromEntries(player.guesses.flatMap((guess, round) => guess?.revision ? [[record.game.session.rounds[round].id, guess.revision]] : [])) });
          this.snapshot(socket, true);
          if (active && record.game.pvp) this.broadcast();
          else if (active) this.hosts({ type: 'participant', participant: player, joined: Object.keys(record.game.joinedPlayers ?? {}).length });
        });
      } catch (error) {
        if (error instanceof GameStorageError) throw error;
        if (error instanceof ParallelActionError) {
          this.send(socket, { type: 'error', code: 'capacity', message: error.message }); socket.close(4003, 'Invitation unavailable'); return;
        }
        this.send(socket, { type: 'error', code: 'unavailable', message: 'Connection unavailable. Reconnecting…' }); socket.close(1013, 'Try again');
      }
      return;
    }
    if (!attachment.identity || attachment.identity.expiresAt <= now) {
      this.send(socket, { type: 'error', code: 'auth', message: 'Sign in with Twitch to play.' }); socket.close(4001, 'Authorization required'); return;
    }
    await this.exclusive(async () => {
      try { await this.process(socket, attachment.identity!, message, now); }
      catch (error) {
        // Never turn an infrastructure failure into a rejected guess. Rethrow
        // so the runtime reconnects; the client retains and replays the same ID.
        if (!(error instanceof ParallelActionError)) throw error;
        this.send(socket, { type: 'error', code: 'invalid', message: 'This action could not be saved.' });
        if ('id' in message && typeof message.id === 'string') this.send(socket, { type: 'command', id: message.id, accepted: false });
      }
    });
  }
  private async process(socket: WebSocket, identity: ParallelIdentity, message: ParallelClientMessage, now: number): Promise<void> {
    // Admission uses the receive time captured before our serialized write queue.
    // A busy final-second burst must not turn on-time frames into late guesses.
    const record = this.record!;
    record.metrics.socketMessages++;
    if (record.game.pvp) {
      if (this.attachment(socket).generation !== record.game.pvp.controllers?.[identity.id]) {
        socket.close(4002, 'Opened in another tab'); return;
      }
      await this.processPvp(socket, identity, message, now); return;
    }
    if (message.type === 'recover') { this.snapshot(socket, true); return; }
    if (message.type === 'guess' || message.type === 'relay') {
      let chat: StreamChatMessage | null;
      const direct = message.type === 'guess';
      if (direct) { record.metrics.directGuesses++; chat = directGuessMessage(record, identity, message.submission, now); }
      else {
        if (identity.role !== 'host') throw new ParallelActionError('Forbidden');
        chat = message.message;
        if (!chat || typeof chat.text !== 'string' || chat.text.length > 2048 || !chat.player || typeof chat.player.name !== 'string'
          || !/^[a-z0-9_]{1,25}$/.test(chat.player.login) || !/^\d{1,30}$/.test(chat.player.id) || chat.player.name.length > 512) throw new ParallelActionError('Invalid relay');
        const join = streamJoinRequest(chat.text);
        if (join) {
          if (record.ended || record.game.stage === 'complete' || join.gameId !== record.game.session.id || join.channel !== record.game.session.host.login) return;
          if (!record.game.participants.some(p => p.id === chat!.player.id)) {
            const player = joinParallelPlayer(record, chat.player); await this.persist([player]);
            this.hosts({ type: 'participant', participant: player, joined: Object.keys(record.game.joinedPlayers ?? {}).length });
          }
          return;
        }
        record.metrics.twitchGuesses++;
      }
      if (!chat) throw new ParallelActionError('Invalid submission');
      if (!direct && chat.player.id === record.game.session.host.id) {
        const guess = parseGuessCommand(chat.text, { rounds: record.game.session.rounds.length, bounds: record.game.session.config.bounds });
        if (!guess?.nonce || guess.userId !== chat.player.id || guess.roundId !== record.game.session.rounds[guess.round - 1]?.id) throw new ParallelActionError('Invalid host guess');
        const timing = record.game.timing!;
        if (!Number.isFinite(chat.sentAt) || chat.sentAt < timing.startsAt || chat.sentAt > now + 5000
          || timing.deadline !== null && (chat.sentAt > timing.deadline + 2000 || now > timing.deadline + 5000)) throw new ParallelActionError('Round closed');
        if (submitParallelHost(record, guess.nonce, guess.roundId, { x: guess.x, y: guess.y }, guess.maximum ?? 5000, now, true)) {
          await this.persist([record.game.participants[0]]); await this.schedule(); this.broadcast();
        }
        return;
      }
      const oldRevision = record.game.timing!.revision;
      const { status, command } = acceptParallelGuess(record, chat, now);
      if (!command?.nonce || !command.revision) throw new ParallelActionError('Invalid submission');
      const accepted = status === 'accepted' || status === 'duplicate';
      const player = record.game.participants.find(p => p.id === chat!.player.id);
      if (status === 'accepted' && player) {
        if (direct) player.guesses[command.round - 1]!.automatic = message.submission.automatic;
        if (direct) record.metrics.firstBySocket++; else record.metrics.firstByTwitch++;
        await this.persist([player]); await this.schedule();
        if (record.game.timing!.revision !== oldRevision) this.broadcast();
        this.hosts({ type: 'participant', participant: player, joined: Object.keys(record.game.joinedPlayers ?? {}).length });
      } else if (status === 'duplicate') record.metrics.duplicates++;
      const response: ParallelServerMessage = { type: 'receipt', round: command.round, roundId: command.roundId!, nonce: command.nonce,
        playerId: chat.player.id, revision: command.revision, accepted, ...(accepted ? { point: { x: command.x, y: command.y }, maximum: command.maximum } : { reason: status === 'old' ? 'superseded' : 'closed' }),
        ...(player?.guesses[command.round - 1]?.automatic ? { automatic: true } : {}) };
      this.sendTo(chat.player.id, response);
      // Host mirrors these durable receipts onto Twitch when the direct player socket is unavailable.
      this.hosts(response);
      return;
    }
    if (identity.role !== 'host' || !('id' in message) || typeof message.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(message.id)) throw new ParallelActionError('Forbidden');
    const duplicate = record.hostCommands.includes(message.id);
    if (!duplicate) {
      if (message.type === 'start') beginParallel(record, message.id, now);
      else if (message.type === 'host-guess') submitParallelHost(record, message.id, message.roundId, message.point, message.maximum, now);
      else if (message.type === 'advance' && !record.game.timing!.seconds) {
        if (record.game.timing!.phase === 'warmup') {
          const { startHostWindow } = await import('../../../src/guessr/stream-timing'); startHostWindow(record.game, now);
        } else {
          if (record.game.stage !== 'reveal') throw new ParallelActionError('This round is closed');
          advanceStreamRound(record.game, now);
        }
      } else if (message.type === 'quit') record.ended = true;
      else if (message.type !== 'publish') throw new ParallelActionError('Invalid command');
      if (!record.hostCommands.includes(message.id)) record.hostCommands = [...record.hostCommands.slice(-31), message.id];
      tickParallel(record, now); await this.persist([record.game.participants[0]]);
      if (record.game.stage === 'complete') await this.publish();
      await this.schedule(); this.broadcast();
    }
    this.send(socket, { type: 'command', id: message.id, accepted: true });
  }
  private async processPvp(socket: WebSocket, identity: ParallelIdentity, message: ParallelClientMessage, now: number): Promise<void> {
    const record = this.record!, game = record.game, pvp = game.pvp!;
    if (!game.participants.some(p => p.id === identity.id)) throw new ParallelActionError('This invitation is not available.');
    if (message.type === 'recover') { this.snapshot(socket, true); return; }
    if (message.type === 'guess') {
      const chat = directGuessMessage(record, identity, message.submission, now);
      if (!chat) throw new ParallelActionError('Invalid submission');
      record.metrics.directGuesses++;
      const { status, command } = acceptParallelGuess(record, chat, now);
      if (!command?.nonce || !command.revision) throw new ParallelActionError('Invalid submission');
      const accepted = status === 'accepted' || status === 'duplicate';
      if (status === 'accepted') {
        game.participants.find(p => p.id === identity.id)!.guesses[command.round - 1]!.automatic = message.submission.automatic;
        record.metrics.firstBySocket++; tickParallel(record, now);
        await this.persist(game.participants); await this.schedule();
      } else if (status === 'duplicate') record.metrics.duplicates++;
      else record.metrics.rejected++;
      this.send(socket, { type: 'receipt', round: command.round, roundId: command.roundId!, nonce: command.nonce,
        revision: command.revision, accepted, ...(accepted ? { point: { x: command.x, y: command.y }, maximum: command.maximum,
          automatic: game.participants.find(p => p.id === identity.id)!.guesses[command.round - 1]?.automatic } : { reason: 'closed' }) });
      if (status === 'accepted') this.broadcast();
      return;
    }
    if (!['start', 'ready', 'reject-opponent', 'quit', 'publish'].includes(message.type)
      || !('id' in message) || typeof message.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(message.id)) throw new ParallelActionError('Forbidden');
    if (record.hostCommands.includes(message.id)) { this.send(socket, { type: 'command', id: message.id, accepted: true }); return; }
    const removed: string[] = [];
    if (message.type === 'start') {
      if (identity.id !== game.session.host.id) throw new ParallelActionError('Forbidden');
      beginParallel(record, message.id, now, message.opponentId);
    } else if (message.type === 'ready') {
      const lobby = game.timing!.phase === 'lobby';
      if (typeof message.ready !== 'boolean' || message.round !== game.round
        || message.phase !== (lobby ? 'lobby' : 'review') || !lobby && game.stage !== 'reveal') throw new ParallelActionError('This action is no longer available.');
      pvp.ready = pvp.ready.filter(id => id !== identity.id);
      if (message.ready) pvp.ready.push(identity.id);
      if (!lobby && game.participants.every(p => pvp.ready.includes(p.id))) { pvp.ready = []; advanceStreamRound(game, now); }
    } else if (message.type === 'reject-opponent') {
      if (identity.id !== game.session.host.id || game.timing!.phase !== 'lobby'
        || message.playerId !== game.participants[1]?.id) throw new ParallelActionError('Forbidden');
      removed.push(message.playerId); pvp.declined = [...pvp.declined.slice(-31), message.playerId]; pvp.ready = [];
      game.participants.splice(1, 1); delete game.joinedPlayers?.[message.playerId];
    } else if (message.type === 'quit') {
      if (game.stage !== 'complete') {
        if (game.timing!.phase === 'lobby') {
          if (identity.id === game.session.host.id) record.ended = true;
          else { removed.push(identity.id); pvp.declined = [...pvp.declined.slice(-31), identity.id];
            game.participants = game.participants.filter(p => p.id !== identity.id); delete game.joinedPlayers?.[identity.id]; pvp.ready = []; }
        }
        else { pvp.concededBy = identity.id; pvp.ready = []; game.stage = 'complete'; game.finishedAt = now; delete record.pendingRevealAt; }
      }
    }
    if (!record.hostCommands.includes(message.id)) record.hostCommands = [...record.hostCommands.slice(-31), message.id];
    game.timing!.revision++;
    await this.persist(game.participants, removed);
    if (game.stage === 'complete') await this.publish();
    await this.schedule(); this.broadcast(); this.send(socket, { type: 'command', id: message.id, accepted: true });
    for (const other of this.ctx.getWebSockets()) if (removed.includes(this.attachment(other).identity?.id ?? '')) {
      this.send(other, { type: 'error', code: 'capacity', message: 'This invitation is not available.' }); other.close(4003, 'Invitation unavailable');
    }
  }
  private async publish(): Promise<void> {
    const record = this.record!;
    if (record.publishedAt || record.game.stage !== 'complete') return;
    record.publicationRetryAt = undefined;
    record.metrics.publicationAttempts++;
    // Freeze the payload before external I/O so a lost D1 response retries identically.
    const result = parallelResult(record); result.transportStats = { ...record.metrics }; await this.persist();
    try {
      const response = await persistStreamResult(this.env, record.owner, result, record.game.session.createdAt);
      if (!response.ok) {
        const data = await response.json() as { error?: string };
        record.publicationRetryAt = Date.now() + Math.max(60, Math.min(86400, Number(response.headers.get('Retry-After')) || 60)) * 1000;
        throw Error(data.error ?? 'Publishing unavailable');
      }
      record.game.published = true; record.publishedAt = Date.now(); record.publicationError = undefined;
    } catch (error) {
      record.publicationError = error instanceof ImageGameError ? error.message : 'Publishing is unavailable. Your local game is safe; download the result or retry later.';
      record.publicationRetryAt ??= Date.now() + Math.min(6 * 3600000, 60000 * 2 ** Math.min(9, record.metrics.publicationAttempts - 1));
    }
    await this.persist();
  }
  private async schedule(): Promise<void> {
    const now = Date.now(), record = this.record!;
    const at = nextParallelAlarm(record, now);
    const pending = this.ctx.getWebSockets().filter(socket => socket.readyState === WebSocket.OPEN).map(socket => this.attachment(socket)).filter(a => !a.identity).map(a => a.opened + 15000);
    if (at !== null) await this.ctx.storage.setAlarm(Math.max(now + 1, Math.min(at, this.retentionDeadline(), ...pending)));
  }
  private retentionDeadline(): number {
    const record = this.record!;
    // Never erase completed scores merely because publication is unavailable.
    return record.publishedAt ? record.publishedAt + 86400000
      : record.game.stage === 'complete' ? Infinity : record.game.pvp && record.game.timing!.phase === 'lobby'
        ? record.game.session.expiresAt : record.game.session.createdAt + 86400000;
  }
  async alarm(): Promise<void> {
    await this.exclusive(async () => {
      const record = this.record; if (!record) return;
      const now = Date.now();
      for (const socket of this.ctx.getWebSockets()) {
        const a = this.attachment(socket);
        if (!a.identity && now - a.opened >= 15000) socket.close(1008, 'Authentication required');
      }
      if (now >= this.retentionDeadline()) {
        const lobbyExpired = !!record.game.pvp && record.game.timing!.phase === 'lobby';
        if (lobbyExpired) { record.ended = true; this.broadcast(); }
        for (const socket of this.ctx.getWebSockets()) socket.close(lobbyExpired ? 4003 : 1000, 'Game archived');
        await this.ctx.storage.deleteAll(); this.record = undefined; return;
      }
      if (tickParallel(record, now)) await this.persist([record.game.participants[0]]);
      if (record.game.stage === 'complete') await this.publish();
      await this.schedule(); this.broadcast();
    });
  }
  webSocketClose(socket: WebSocket, code: number): void { try { socket.close(code); } catch {} }
  webSocketError(socket: WebSocket): void { try { socket.close(1011, 'Connection interrupted'); } catch {} }
}
