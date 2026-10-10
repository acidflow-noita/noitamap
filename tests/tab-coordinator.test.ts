// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.hoisted(() => { vi.stubGlobal('BroadcastChannel', undefined); });
import { createTabCoordinator, registerTabHandoff } from '../src/tab-coordinator';

function tabs() {
  const ports: EventTarget[] = [], messages: any[] = [], controllers: ReturnType<typeof createTabCoordinator>[] = [];
  const tab = (id: string, mod = false, receiverPresent?: () => Promise<boolean>, clockOffset = 0) => {
    let href = `https://map.test/?m=dy&se=91${mod ? '&src=mod' : ''}`;
    const events = new EventTarget(); ports.push(events);
    const channel = Object.assign(events, { postMessage(message: any) {
      messages.push(message);
      for (const port of ports) if (port !== events)
        queueMicrotask(() => port.dispatchEvent(new MessageEvent('message', { data: structuredClone(message) })));
    } });
    const close = vi.fn(), replace = vi.fn((url: string) => { href = url; });
    const controller = createTabCoordinator({ channel, id, receiverPresent, now: () => Date.now() + clockOffset,
      href: () => href, replaceURL: replace, closeDuplicate: close });
    controllers.push(controller);
    return { ...controller, channel, close, replace, href: () => href, setHref: (url: string) => { href = url; } };
  };
  return { tab, messages, close: () => controllers.forEach(c => c.dispose()) };
}
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
let cleanup: (() => void) | undefined;
beforeEach(() => { vi.useFakeTimers(); vi.spyOn(window, 'focus').mockImplementation(() => {}); });
afterEach(() => { cleanup?.(); cleanup = undefined; vi.useRealTimers(); vi.restoreAllMocks(); });

describe('warm mod tab handoff', () => {
  it('accepts valid handoffs when the sending tab rounds its clock slightly ahead', async () => {
    const b = tabs(); cleanup = b.close;
    const receiver = b.tab('receiver'), sender = b.tab('sender', true, async () => true, 2);
    const accept = vi.fn(() => true); receiver.register(accept);
    const pending = sender.negotiate(); await flush();
    await vi.advanceTimersByTimeAsync(6000);
    expect(await pending).toBe(false);
    expect(accept).toHaveBeenCalledOnce(); expect(sender.close).toHaveBeenCalledOnce();
  });
  it('does not let a far-future sender deadline extend the receiver lease', async () => {
    const b = tabs(); cleanup = b.close;
    const receiver = b.tab('receiver'), sender = b.tab('sender', true), accept = vi.fn(() => true);
    receiver.register(accept);
    const message = { sourceId: 'future', url: sender.href(), until: Number.MAX_SAFE_INTEGER };
    sender.channel.postMessage({ type: 'handoff-v2-request', ...message }); await flush();
    await vi.advanceTimersByTimeAsync(6001);
    sender.channel.postMessage({ type: 'handoff-v2-apply', targetId: 'receiver', ...message }); await flush();
    expect(accept).not.toHaveBeenCalled();
  });
  it('keeps navigation usable when the optional ready-lock API is denied', () => {
    const original = Object.getOwnPropertyDescriptor(navigator, 'locks');
    Object.defineProperty(navigator, 'locks', { configurable: true, value: {
      request: () => { throw new DOMException('Unavailable in this document', 'SecurityError'); },
    } });
    try {
      const unregister = registerTabHandoff(() => true);
      expect(() => window.dispatchEvent(new Event('pagehide'))).not.toThrow();
      expect(() => window.dispatchEvent(new Event('pageshow'))).not.toThrow();
      unregister();
    } finally {
      if (original) Object.defineProperty(navigator, 'locks', original);
      else delete (navigator as any).locks;
    }
  });
  it('selects exactly one existing tab and closes the duplicate only after acceptance, without waiting out a timer', async () => {
    const b = tabs(); cleanup = b.close;
    const a = b.tab('a'), c = b.tab('c'), sender = b.tab('sender', true);
    const first = vi.fn(() => { expect(sender.close).not.toHaveBeenCalled(); return true; });
    const second = vi.fn(() => true);
    a.register(first); c.register(second);
    const pending = sender.negotiate(); await flush();
    expect(await pending).toBe(false);
    expect(first).toHaveBeenCalledOnce(); expect(second).not.toHaveBeenCalled();
    expect(sender.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    expect(b.messages.some(m => m.type === 'handoff')).toBe(false); // older tabs must not reload themselves
  });
  it('loads normally when no initialized tab can accept, and removes the one-shot marker', async () => {
    const b = tabs(); cleanup = b.close;
    b.tab('still-loading');
    const sender = b.tab('sender', true), pending = sender.negotiate();
    await vi.advanceTimersByTimeAsync(200);
    expect(await pending).toBe(true);
    expect(sender.close).not.toHaveBeenCalled();
    expect(new URL(sender.href()).searchParams.has('src')).toBe(false);
  });
  it('keeps the duplicate usable when the selected receiver refuses or throws', async () => {
    for (const throws of [false, true]) {
      const b = tabs();
      const receiver = b.tab('receiver'), sender = b.tab('sender', true);
      receiver.register(() => { if (throws) throw Error('cannot apply'); return false; });
      const pending = sender.negotiate(); await flush();
      expect(await pending).toBe(true); expect(sender.close).not.toHaveBeenCalled(); b.close();
    }
  });
  it('times out a dead receiver without losing the launched map', async () => {
    const b = tabs(); cleanup = b.close;
    const receiver = b.tab('receiver'), sender = b.tab('sender', true);
    receiver.register(() => true);
    const original = receiver.channel.postMessage;
    receiver.channel.postMessage = message => { original(message); if (message.type === 'handoff-v2-offer') receiver.dispose(); };
    const pending = sender.negotiate();
    await vi.advanceTimersByTimeAsync(1200);
    expect(await pending).toBe(true); expect(sender.close).not.toHaveBeenCalled();
  });
  it('allows a known-live busy tab to answer after the short standalone discovery window', async () => {
    const b = tabs(); cleanup = b.close;
    const receiver = b.tab('receiver'), sender = b.tab('sender', true, async () => true);
    const accept = vi.fn(() => true); receiver.register(accept);
    const original = receiver.channel.postMessage;
    receiver.channel.postMessage = message => {
      if (message.type === 'handoff-v2-offer') setTimeout(() => original(message), 700);
      else original(message);
    };
    const pending = sender.negotiate();
    await vi.advanceTimersByTimeAsync(201);
    expect(sender.close).not.toHaveBeenCalled(); expect(sender.replace).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    expect(await pending).toBe(false); expect(accept).toHaveBeenCalledOnce();
  });
  it('falls back promptly when presence is absent, fails, or never answers', async () => {
    for (const presence of [async () => false, async () => { throw Error('unavailable'); }, () => new Promise<boolean>(() => {})]) {
      const b = tabs(), sender = b.tab('sender', true, presence), pending = sender.negotiate();
      await vi.advanceTimersByTimeAsync(400);
      expect(await pending).toBe(true); expect(sender.close).not.toHaveBeenCalled(); b.close();
    }
  });
  it('does not restart discovery when the presence probe answers after its deadline', async () => {
    const b = tabs(); cleanup = b.close;
    let answer!: (present: boolean) => void;
    const sender = b.tab('sender', true, () => new Promise(resolve => { answer = resolve; }));
    const pending = sender.negotiate(); await vi.advanceTimersByTimeAsync(201);
    answer(true); await flush(); await vi.advanceTimersByTimeAsync(200);
    expect(await pending).toBe(true);
    expect(b.messages.filter(m => m.type === 'handoff-v2-request')).toHaveLength(1);
  });
  it('rejects expired/unsolicited/cross-origin applies and accepts a selected request only once', async () => {
    const b = tabs(); cleanup = b.close;
    const receiver = b.tab('receiver'), sender = b.tab('sender', true), accept = vi.fn(() => true);
    receiver.register(accept);
    const pending = sender.negotiate(); await flush(); expect(await pending).toBe(false);
    const apply = b.messages.find(m => m.type === 'handoff-v2-apply');
    sender.channel.postMessage(apply); await flush(); expect(accept).toHaveBeenCalledOnce();
    for (const message of [
      { ...apply, sourceId: 'unknown' },
      { type: 'handoff-v2-request', sourceId: 'evil', url: 'https://elsewhere.test/?src=mod', until: Date.now() + 200 },
      { type: 'handoff-v2-request', sourceId: 'expired', url: sender.href(), until: Date.now() - 1 },
    ]) sender.channel.postMessage(message);
    await flush(); expect(accept).toHaveBeenCalledOnce();
  });
  it('does not negotiate ordinary URLs or depend on BroadcastChannel being available', async () => {
    const close = vi.fn();
    const unavailable = createTabCoordinator({ channel: null, href: () => 'https://map.test/?src=mod', replaceURL: vi.fn(), closeDuplicate: close });
    expect(await unavailable.negotiate()).toBe(true); expect(close).not.toHaveBeenCalled();
    const b = tabs(); cleanup = b.close;
    expect(await b.tab('ordinary').negotiate()).toBe(true); expect(b.messages).toEqual([]);
  });
});
