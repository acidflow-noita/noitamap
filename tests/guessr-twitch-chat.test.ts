import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TwitchChatConnection,
  type TwitchSocket,
} from "../src/guessr/twitch-chat";

class FakeSocket implements TwitchSocket {
  onmessage: TwitchSocket["onmessage"] = null;
  onclose: TwitchSocket["onclose"] = null;
  onerror: TwitchSocket["onerror"] = null;
  closed = false;
  constructor(readonly url: string) {}
  close() {
    this.closed = true;
  }
  receive(type: string, payload: unknown, id: string = crypto.randomUUID()) {
    this.onmessage?.(
      new MessageEvent("message", {
        data: JSON.stringify({
          metadata: {
            message_type: type,
            message_id: id,
            message_timestamp: new Date().toISOString(),
          },
          payload,
        }),
      }),
    );
  }
  welcome(id: string) {
    this.receive("session_welcome", {
      session: { id, keepalive_timeout_seconds: 10 },
    });
  }
  drop() {
    this.onclose?.({ code: 1006 } as CloseEvent);
  }
}
const connections: TwitchChatConnection[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.UTC(2026, 9, 18));
});
afterEach(() => {
  connections.splice(0).forEach((c) => c.stop());
  vi.useRealTimers();
});
const flush = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};
function fixture(broadcasterLogin?: string) {
  const sockets: FakeSocket[] = [],
    message = vi.fn(),
    status = vi.fn();
  const request = vi.fn<typeof fetch>(
    async url => String(url).includes('/helix/users?')
      ? Response.json({ data: [{ id: '456', login: 'noitaguessr' }] }) : new Response("{}", { status: 202 }),
  );
  const credentials = vi.fn(async () => ({
    userId: "100",
    login: "streamer",
    clientId: "client",
    accessToken: "private-user-token",
    expiresAt: Date.now() + 3600000,
  }));
  const connection = new TwitchChatConnection({
    userId: "100",
    broadcasterLogin,
    message,
    status,
    fetch: request,
    credentials,
    socket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
  });
  connections.push(connection);
  connection.start();
  const chat = (socket: FakeSocket, id = "one", owner = "100") =>
    socket.receive(
      "notification",
      {
        subscription: { type: "channel.chat.message" },
        event: {
          broadcaster_user_id: owner,
          chatter_user_id: "123",
          chatter_user_login: "viewer",
          chatter_user_name: "Viewer",
          message_id: id,
          message: { text: "!noitaguessr_guess 1 -100 20" },
        },
      },
      id,
    );
  return { connection, sockets, message, status, request, chat, credentials };
}
describe("Twitch EventSub browser transport", () => {
  it('uses the already validated host credential to announce without another credential request', async () => {
    const f = fixture('noitaguessr');
    f.credentials.mockResolvedValue({ userId: '100', login: 'streamer', clientId: 'client', accessToken: 'private-user-token',
      expiresAt: Date.now() + 3600000, scopes: ['user:read:chat', 'moderator:manage:announcements'] } as any);
    // The initial credentials call has already begun. Restart as a real reconnect would.
    f.connection.stop(); f.connection.start(); await flush();
    f.request.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const credentialCalls = f.credentials.mock.calls.length;
    await f.connection.postAnnouncement('100', 'Join NoitaGuessr: https://noitamap.test/guess/stream/streamer/');
    expect(f.credentials).toHaveBeenCalledTimes(credentialCalls);
    expect(f.request.mock.lastCall![0]).toContain('broadcaster_id=100&moderator_id=100');
    expect(f.request.mock.lastCall![0]).not.toContain('456');
  });
  it('resolves the shared transport once and subscribes with the streamer identity, including after reconnect', async () => {
    const f = fixture('noitaguessr'); await flush(); await flush();
    expect(f.request.mock.calls[0][0]).toBe('https://api.twitch.tv/helix/users?login=noitaguessr');
    f.sockets[0].welcome('central'); await flush();
    expect(JSON.parse(f.request.mock.calls[1][1]!.body as string).condition).toEqual({ broadcaster_user_id: '456', user_id: '100' });
    f.chat(f.sockets[0], 'own-channel', '100');
    expect(f.message).not.toHaveBeenCalled();
    f.chat(f.sockets[0], 'central-message', '456');
    expect(f.message).toHaveBeenCalledOnce();
    f.sockets[0].drop(); await vi.advanceTimersByTimeAsync(1001); await flush();
    f.sockets[1].welcome('reconnected'); await flush();
    expect(f.request.mock.calls.filter(([url]) => String(url).includes('/helix/users?'))).toHaveLength(1);
    expect(JSON.parse(f.request.mock.calls.at(-1)![1]!.body as string).condition).toEqual({ broadcaster_user_id: '456', user_id: '100' });
    expect(f.request.mock.calls.every(([url]) => String(url).startsWith('https://api.twitch.tv/'))).toBe(true);
  });
  it('reads a different broadcaster using the viewer identity and applies moderation only to the local display', async () => {
    const sockets: FakeSocket[] = [], message = vi.fn(), remove = vi.fn();
    const request = vi.fn<typeof fetch>(async () => new Response('{}', { status: 202 }));
    const connection = new TwitchChatConnection({ userId: '123', broadcasterId: '456', message, remove, status: vi.fn(),
      credentials: async () => ({ userId: '123', login: 'viewer', accessToken: 'viewer-token', clientId: 'client', expiresAt: Date.now() + 7200000 }),
      fetch: request, socket: url => { const socket = new FakeSocket(url); sockets.push(socket); return socket; },
    });
    connections.push(connection); connection.start(); await flush(); sockets[0].welcome('viewer-session'); await flush(); await flush();
    expect(request).toHaveBeenCalledTimes(4);
    for (const [url, init] of request.mock.calls) {
      expect(url).toBe('https://api.twitch.tv/helix/eventsub/subscriptions');
      expect(JSON.parse(init!.body as string).condition).toEqual({ broadcaster_user_id: '456', user_id: '123' });
      expect(init!.method).toBe('POST');
    }
    const notify = (type: string, event: Record<string, unknown>) => sockets[0].receive('notification', {
      subscription: { type }, event: { broadcaster_user_id: '456', ...event },
    });
    notify('channel.chat.message', { chatter_user_id: '789', chatter_user_login: 'chatter', chatter_user_name: 'Chatter',
      message: { text: '!noitaguessr_guess 1 0 0' }, message_id: 'guess' });
    expect(message).toHaveBeenCalledOnce();
    notify('channel.chat.message_delete', { message_id: 'guess' });
    notify('channel.chat.clear_user_messages', { target_user_id: '789' });
    notify('channel.chat.clear', {});
    expect(remove.mock.calls).toEqual([['message', 'guess'], ['user', '789'], ['all']]);
    notify('channel.chat.clear', { broadcaster_user_id: '999' });
    expect(remove).toHaveBeenCalledTimes(3);
    expect(request).toHaveBeenCalledTimes(4);
  });
  it("subscribes to the authenticated host's channel, filters other channels and deduplicates notifications", async () => {
    const f = fixture();
    await flush();
    f.sockets[0].welcome("first");
    await flush();
    expect(f.request).toHaveBeenCalledTimes(1);
    const init = f.request.mock.calls[0][1]!;
    expect(JSON.parse(init.body as string)).toEqual({
      type: "channel.chat.message",
      version: "1",
      condition: { broadcaster_user_id: "100", user_id: "100" },
      transport: { method: "websocket", session_id: "first" },
    });
    expect(init.headers).toMatchObject({
      Authorization: "Bearer private-user-token",
      "Client-Id": "client",
    });
    f.chat(f.sockets[0]);
    f.chat(f.sockets[0]);
    f.chat(f.sockets[0], "other", "200");
    expect(f.message).toHaveBeenCalledTimes(1);
    expect(f.message.mock.calls[0][0]).toMatchObject({
      player: { id: "123", login: "viewer" },
      text: "!noitaguessr_guess 1 -100 20",
    });
    expect(f.status).toHaveBeenLastCalledWith("live", expect.any(String));
  });
  it("keeps the old socket during directed reconnect and never resubscribes during handoff", async () => {
    const f = fixture();
    await flush();
    const old = f.sockets[0];
    old.welcome("first");
    await flush();
    const target = "wss://eventsub.wss.twitch.tv/ws?reconnect=opaque%2Ftoken";
    old.receive("session_reconnect", { session: { reconnect_url: target } });
    expect(f.sockets).toHaveLength(2);
    expect(f.sockets[1].url).toBe(target);
    expect(old.closed).toBe(false);
    f.chat(old, "during-handoff");
    expect(f.message).toHaveBeenCalledTimes(1);
    f.sockets[1].welcome("carried-session");
    await flush();
    expect(old.closed).toBe(true);
    expect(f.request).toHaveBeenCalledTimes(1);
    f.chat(f.sockets[1], "during-handoff");
    expect(f.message).toHaveBeenCalledTimes(1);
  });
  it("re-subscribes after an actual disconnect and warns that missed messages cannot be replayed", async () => {
    const f = fixture();
    await flush();
    f.sockets[0].welcome("first");
    await flush();
    f.sockets[0].drop();
    expect(f.status).toHaveBeenLastCalledWith(
      "reconnecting",
      expect.stringContaining("not replayed"),
    );
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    expect(f.sockets).toHaveLength(2);
    f.sockets[1].welcome("second");
    await flush();
    expect(f.request).toHaveBeenCalledTimes(2);
  });
  it("reconnects on a missing keepalive and stops on revoked access", async () => {
    const f = fixture();
    await flush();
    f.sockets[0].welcome("first");
    await flush();
    await vi.advanceTimersByTimeAsync(12001);
    expect(f.status).toHaveBeenLastCalledWith(
      "reconnecting",
      expect.any(String),
    );
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    f.sockets[1].welcome("second");
    await flush();
    f.sockets[1].receive("revocation", {
      subscription: {
        type: "channel.chat.message",
        status: "authorization_revoked",
      },
    });
    expect(f.status).toHaveBeenLastCalledWith(
      "auth-required",
      expect.any(String),
    );
    await vi.advanceTimersByTimeAsync(60000);
    expect(f.sockets).toHaveLength(2);
  });
  it("rejects a reconnect URL outside Twitch without exposing credentials", async () => {
    const f = fixture();
    await flush();
    f.sockets[0].welcome("first");
    await flush();
    f.sockets[0].receive("session_reconnect", {
      session: { reconnect_url: "wss://example.test/steal" },
    });
    expect(f.sockets).toHaveLength(1);
    expect(f.status).toHaveBeenLastCalledWith(
      "reconnecting",
      expect.any(String),
    );
  });
  it("revalidates credentials within an hour without dropping an unchanged connection", async () => {
    const f = fixture();
    await flush();
    f.sockets[0].receive("session_welcome", {
      session: { id: "long-lived", keepalive_timeout_seconds: 7200 },
    });
    await flush();
    await vi.advanceTimersByTimeAsync(3570000);
    await flush();
    expect(f.credentials).toHaveBeenCalledTimes(2);
    expect(f.sockets).toHaveLength(1);
    expect(f.sockets[0].closed).toBe(false);
    expect(f.request).toHaveBeenCalledTimes(1);
  });
});
