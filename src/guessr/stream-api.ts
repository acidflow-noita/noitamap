import { GameApi, gameApiOrigin } from "./api";
import { expandStreamResult, packStreamPublish } from "./stream-codec";
import type {
  StreamPublishInput,
  StreamResult,
  StreamReveal,
  StreamSession,
  StreamPublishedResult,
  StreamHistoryPage,
} from "./stream-types";
import { STREAM_MAX_PLAYERS, STREAM_DEFAULT_ROUNDS } from "./stream-types";
import type { LiveRoomView } from "./live-room-types";

export class StreamApi {
  readonly origin = gameApiOrigin();
  readonly local =
    !this.origin &&
    ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
  readonly available = !!this.origin || this.local;
  private api = this.origin ? new GameApi(this.origin) : null;
  private publicResults = new Map<string, Promise<StreamResult>>();
  private localChannel?: string;
  hostSocketTicket(): Promise<string> {
    if (!this.api) return Promise.reject(new Error('Stream hosting is not configured on this site yet.'));
    return this.api.transportTicket();
  }
  setLocalChannel(channel?: string): void {
    if (channel !== undefined && !/^[a-z0-9_]{1,25}$/.test(channel)) throw new Error('Invalid Twitch channel.');
    this.localChannel = channel;
  }
  private async localRequest<T>(path: string, body?: unknown): Promise<T> {
    const response = await fetch("/guessr-api/stream" + path, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify({ ...body as object, ...(this.localChannel ? { localChannel: this.localChannel } : {}) }),
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data)
      throw new Error(
        data?.error || "Could not load the local stream game. Please retry.",
      );
    return data as T;
  }
  private request<T>(path: string, body: unknown): Promise<T> {
    if (this.local) return this.localRequest<T>(path, body);
    if (!this.api)
      return Promise.reject(
        new Error("Stream hosting is not configured on this site yet."),
      );
    return this.api.request<T>("/api/streams" + path, { body });
  }
  start(transport?: 'twitch' | 'parallel', rounds = STREAM_DEFAULT_ROUNDS, seconds = 90): Promise<StreamSession> {
    return this.request("/sessions", { ...(transport ? { transport } : {}), rounds, seconds });
  }
  clock(): Promise<{ now: number }> {
    return this.request("/time", {});
  }
  reveal(token: string, submissions?: import('./stream-types').StreamRoundSubmission[]): Promise<StreamReveal> {
    return this.request("/reveal", { token, submissions });
  }
  advance(gameId: string, roundId: string): Promise<LiveRoomView> {
    if (!this.local) return Promise.reject(new Error("This game transport has been retired."));
    return this.localRequest("/advance", { gameId, roundId });
  }
  pulse(gameId: string): Promise<LiveRoomView> {
    if (!this.local) return Promise.reject(new Error("This game transport has been retired."));
    return this.localRequest("/pulse", { gameId });
  }
  pause(gameId: string, paused: boolean): Promise<LiveRoomView> {
    if (!this.local) return Promise.reject(new Error("This game transport has been retired."));
    return this.localRequest("/pause", { gameId, paused });
  }
  quit(gameId: string): Promise<LiveRoomView> {
    if (!this.local) return Promise.reject(new Error("This game transport has been retired."));
    return this.localRequest("/quit", { gameId });
  }
  publish(
    input: StreamPublishInput,
  ): Promise<{ id: string; published: boolean }> {
    if (input.players.length > STREAM_MAX_PLAYERS)
      return Promise.reject(
        new Error(
          `This game has more than ${STREAM_MAX_PLAYERS.toLocaleString()} players. Download the complete results to share every score.`,
        ),
      );
    return this.request("/results", packStreamPublish(input));
  }

  result(id: string): Promise<StreamResult> {
    if (!/^[a-f0-9-]{36}$/.test(id))
      return Promise.reject(new Error("Invalid result link."));
    let pending = this.publicResults.get(id);
    if (!pending) {
      pending = this.local
        ? this.localRequest<StreamPublishedResult>("/results/" + id).then(
            expandStreamResult,
          )
        : (async () => {
            if (!this.origin)
              throw new Error(
                "Result hosting is not configured. Open the host’s downloaded result instead.",
              );
            const response = await fetch(
              this.origin + "/api/streams/results/" + id,
              { signal: AbortSignal.timeout(15000) },
            );
            const data = await response.json().catch(() => ({}));
            if (!response.ok)
              throw new Error(
                data.error ||
                  "Result is unavailable. Ask the host for a downloaded copy.",
              );
            return expandStreamResult(data as StreamPublishedResult);
          })();
      this.publicResults.set(id, pending);
      void pending.catch(() => this.publicResults.delete(id));
    }
    return pending;
  }
  async history(channel: string, before?: string): Promise<StreamHistoryPage> {
    if (!/^[a-z0-9_]{1,25}$/.test(channel)) throw new Error('Invalid Twitch channel.');
    const path = '/history/' + channel + (before ? '?before=' + encodeURIComponent(before) : '');
    if (this.local) return this.localRequest<StreamHistoryPage>(path);
    if (!this.origin) throw new Error('Result hosting is not configured.');
    const response = await fetch(this.origin + '/api/streams' + path, { signal: AbortSignal.timeout(15000) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not load game history.');
    return data;
  }
}
