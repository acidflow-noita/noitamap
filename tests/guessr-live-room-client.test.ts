import { afterEach, describe, expect, it, vi } from 'vitest';
import { watchLiveRoom } from '../src/guessr/live-room-client';
import { liveRoomLink } from '../src/guessr/live-room-game';
import type { LiveRoomView } from '../src/guessr/live-room-types';

const state: LiveRoomView = {
  schema: 1, channel: 'wuote', gameId: '11111111-1111-4111-8111-111111111111',
  roundId: '22222222-2222-4222-8222-222222222222', revision: 1,
  phase: 'guess', online: true, paused: false, round: 1, clue: 'opaque', expiresAt: Date.now() + 999999,
};
class Socket {
  onopen: any; onmessage: any; onclose: any; onerror: any;
  send = vi.fn(); close = vi.fn();
  message(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('stable room connection budget', () => {
  it('stops reconnect attempts while offline and resumes once when the network returns', () => {
    vi.useFakeTimers();
    const network = new EventTarget(), browser = { onLine: false };
    vi.stubGlobal('window', network); vi.stubGlobal('navigator', browser);
    const sockets: Socket[] = [];
    const create = vi.fn(() => { const socket = new Socket(); sockets.push(socket); return socket as unknown as WebSocket; });
    const status = vi.fn();
    const room = watchLiveRoom('wuote', { state: vi.fn(), status }, { url: 'wss://test.invalid/room', socket: create });
    expect(status).toHaveBeenLastCalledWith('offline', expect.any(String));
    room.retry(); vi.advanceTimersByTime(3_600_000);
    expect(create).not.toHaveBeenCalled();
    browser.onLine = true; network.dispatchEvent(new Event('online'));
    expect(create).toHaveBeenCalledTimes(1);
    sockets[0].message({ type: 'state', state });
    expect(status).toHaveBeenLastCalledWith('connected', '');
    // A failed connection has a retry scheduled; going offline cancels it.
    sockets[0].onclose({ code: 1006 });
    browser.onLine = false; network.dispatchEvent(new Event('offline'));
    vi.advanceTimersByTime(3_600_000);
    expect(create).toHaveBeenCalledTimes(1);
    expect(status).toHaveBeenLastCalledWith('offline', expect.any(String));
    browser.onLine = true; network.dispatchEvent(new Event('online'));
    expect(create).toHaveBeenCalledTimes(2);
    network.dispatchEvent(new Event('online'));
    expect(create).toHaveBeenCalledTimes(2);
    room.dispose(); network.dispatchEvent(new Event('online'));
    expect(create).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('keeps eight hours and 20 games on one socket with zero viewer pings, polls or per-round requests', () => {
    vi.useFakeTimers();
    const socket = new Socket(), create = vi.fn(() => socket as unknown as WebSocket);
    const got = vi.fn(), status = vi.fn();
    const room = watchLiveRoom('wuote', { state: got, status }, { url: 'wss://test.invalid/room', socket: create });
    socket.message({ type: 'state', state });
    let revision = 1;
    for (let minute = 0; minute < 480; minute++) {
      vi.advanceTimersByTime(60_000);
      socket.message({ type: 'heartbeat', at: Date.now() });
      if (minute % 24 === 0) for (let round = 1; round <= 10; round++) {
        socket.message({ type: 'state', state: { ...state, round, revision: ++revision } });
        socket.message({ type: 'state', state: { ...state, round, phase: 'reveal', revision: ++revision } });
      }
    }
    expect(create).toHaveBeenCalledTimes(1);
    expect(socket.send).not.toHaveBeenCalled();
    expect(got).toHaveBeenCalledTimes(401);
    room.dispose(); expect(vi.getTimerCount()).toBe(0);
  });
  it('caps automatic reconnect attempts instead of polling forever during an outage', () => {
    vi.useFakeTimers();
    const create = vi.fn(() => new Socket() as unknown as WebSocket), status = vi.fn();
    const room = watchLiveRoom('wuote', { state: vi.fn(), status }, { url: 'wss://test.invalid/room', socket: create });
    vi.advanceTimersByTime(3_600_000);
    expect(create).toHaveBeenCalledTimes(7);
    expect(status).toHaveBeenLastCalledWith('stopped', expect.any(String));
    expect(vi.getTimerCount()).toBe(0);
    room.retry(); expect(create).toHaveBeenCalledTimes(8); room.dispose();
  });
  it('does not reconnect just because a host is offline, and rejects a cross-channel state', () => {
    vi.useFakeTimers();
    const socket = new Socket(), create = vi.fn(() => socket as unknown as WebSocket), status = vi.fn(), got = vi.fn();
    const room = watchLiveRoom('wuote', { state: got, status }, { url: 'wss://test.invalid/room', socket: create });
    socket.message({ type: 'state', state: { ...state, online: false } });
    vi.advanceTimersByTime(8 * 3_600_000); expect(create).toHaveBeenCalledTimes(1);
    socket.message({ type: 'state', state: { ...state, channel: 'another' } });
    expect(got).toHaveBeenCalledTimes(1); expect(status).toHaveBeenLastCalledWith('stopped', expect.any(String));
    room.dispose();
  });
  it('shares only a short channel URL, with no clue, round or credentials', () => {
    expect(liveRoomLink('https://dynamic-map.noitamap.com/anything#secret', 'Wuote'))
      .toBe('https://dynamic-map.noitamap.com/guess/stream/wuote/');
    expect(liveRoomLink('https://dynamic-map.noitamap.com', 'a'.repeat(25)).length).toBeLessThan(80);
    expect(() => liveRoomLink('https://example.com', 'x/y')).toThrow();
  });
});
