// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POICardLifecycle } from '../src/telescope/poi-card-lifecycle';

function deferred() {
  let resolve!: (value: boolean) => void;
  const promise = new Promise<boolean>(done => { resolve = done; });
  return { promise, resolve };
}

describe('POI card navigation ownership and cancellation', () => {
  let seed: number, cards: POICardLifecycle;
  const show = (name: string) => () => { document.body.textContent = name; };
  beforeEach(() => {
    vi.useFakeTimers(); seed = 1;
    cards = new POICardLifecycle(() => seed, () => document.body.replaceChildren());
  });
  afterEach(() => { cards.close(); vi.useRealTimers(); });

  it('closes the report selection and cancels its flight before a category overview, even if arrival later succeeds', async () => {
    const arrival = deferred(), cancelFlight = vi.fn();
    cards.begin('report').afterNavigation(arrival.promise, show('old wand'), cancelFlight);
    cards.close({ reportOnly: true });
    expect(cancelFlight).toHaveBeenCalledOnce();
    arrival.resolve(true); await arrival.promise;
    expect(document.body.textContent).toBe('');
    expect(cards.owner).toBeUndefined();
  });

  it('cancels the delayed plain-viewer opening when its category is left', () => {
    cards.begin('report').afterNavigation(null, show('old spell'));
    cards.close({ reportOnly: true });
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(1000);
    expect(document.body.textContent).toBe('');
  });

  it('preserves an unrelated pending or visible map card when leaving the report', async () => {
    const reportArrival = deferred(), mapArrival = deferred(), mapCancel = vi.fn();
    cards.begin('report').afterNavigation(reportArrival.promise, show('report wand'));
    const mapCard = cards.begin('map');
    mapCard.afterNavigation(mapArrival.promise, show('clicked chest'), mapCancel);
    expect(cards.close({ reportOnly: true })).toBe(false);
    reportArrival.resolve(true); mapArrival.resolve(true);
    await Promise.all([reportArrival.promise, mapArrival.promise]);
    expect(document.body.textContent).toBe('clicked chest');
    expect(cards.close({ reportOnly: true })).toBe(false);
    expect(document.body.textContent).toBe('clicked chest');
    expect(mapCancel).not.toHaveBeenCalled();
    expect(mapCard.isCurrent()).toBe(true);
  });

  it('seed replacement immediately clears the visible card and invalidates its rebuild closure', () => {
    const card = cards.begin('report');
    show('old seed card')();
    seed = 2; cards.close();
    expect(document.body.textContent).toBe('');
    expect(card.isCurrent()).toBe(false);
  });

  it('checks the seed at arrival even if a replacement starts before its explicit cleanup', async () => {
    const arrival = deferred();
    cards.begin('map').afterNavigation(arrival.promise, show('wrong seed'));
    seed = 2;
    arrival.resolve(true); await arrival.promise;
    expect(document.body.textContent).toBe('');
  });

  it('invalidates queued URL/sidebar work on a seed or map replacement even before a card starts opening', () => {
    const awaitingReportMount = cards.guard();
    cards.close();
    expect(awaitingReportMount()).toBe(false);
    const awaitingNewSeed = cards.guard();
    seed = 2;
    expect(awaitingNewSeed()).toBe(false);
  });

  it('does not cancel another camera operation when closing an already arrived card', async () => {
    const arrival = deferred(), cancelFlight = vi.fn();
    cards.begin('report').afterNavigation(arrival.promise, show('arrived'), cancelFlight);
    arrival.resolve(true); await arrival.promise;
    expect(document.body.textContent).toBe('arrived');
    cards.close({ reportOnly: true });
    expect(document.body.textContent).toBe('');
    expect(cancelFlight).not.toHaveBeenCalled();
  });

  it('does not reopen after user interruption or a rejected navigation', async () => {
    const interrupted = deferred();
    cards.begin('report').afterNavigation(interrupted.promise, show('interrupted'));
    interrupted.resolve(false); await interrupted.promise;
    expect(cards.owner).toBeUndefined();
    cards.begin('map').afterNavigation(Promise.reject(new Error('map changed')), show('rejected'));
    await Promise.resolve();
    expect(cards.owner).toBeUndefined();
    expect(document.body.textContent).toBe('');
  });

  it('consumes the first Escape from a report button while dismissing a card, then lets the next Escape close the report', () => {
    document.body.innerHTML = '<section><button>Go</button></section>';
    const report = document.querySelector('section')!;
    const button = report.querySelector('button')!;
    const removeCard = vi.fn(() => document.querySelector('aside')?.remove());
    cards = new POICardLifecycle(() => seed, removeCard);
    cards.begin('report');
    document.body.insertAdjacentHTML('beforeend', '<aside>POI card</aside>');
    removeCard.mockClear();
    const closeReport = vi.fn();
    const capture = (event: KeyboardEvent) => { cards.handleEscape(event); };
    report.addEventListener('keydown', closeReport);
    document.addEventListener('keydown', capture, true);
    try {
      button.focus();
      const first = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      button.dispatchEvent(first);
      expect(first.defaultPrevented).toBe(true);
      expect(removeCard).toHaveBeenCalledOnce();
      expect(document.querySelector('aside')).toBeNull();
      expect(closeReport).not.toHaveBeenCalled();
      const second = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      button.dispatchEvent(second);
      expect(second.defaultPrevented).toBe(false);
      expect(closeReport).toHaveBeenCalledOnce();
    } finally { document.removeEventListener('keydown', capture, true); }
  });

  it('consumes Escape during a pending flight and cancels arrival, without consuming other keys', async () => {
    const arrival = deferred(), cancelFlight = vi.fn();
    cards.begin('report').afterNavigation(arrival.promise, show('cancelled destination'), cancelFlight);
    const enter = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true });
    expect(cards.handleEscape(enter)).toBe(false);
    expect(enter.defaultPrevented).toBe(false);
    expect(cancelFlight).not.toHaveBeenCalled();
    const escape = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
    expect(cards.handleEscape(escape)).toBe(true);
    expect(escape.defaultPrevented).toBe(true);
    expect(cancelFlight).toHaveBeenCalledOnce();
    arrival.resolve(true); await arrival.promise;
    expect(document.body.textContent).toBe('');
    expect(cards.owner).toBeUndefined();
  });

  it.each(['toggle', 'item'])('lets a focused open dropdown %s consume Escape before the POI card', target => {
    document.body.innerHTML = '<button id="toggle" data-bs-toggle="dropdown" aria-expanded="true">World</button>'
      + '<div class="dropdown-menu show"><button id="item">Main</button></div>';
    cards = new POICardLifecycle(() => seed, vi.fn());
    cards.begin('report');
    const capture = (event: KeyboardEvent) => { cards.handleEscape(event); };
    const item = document.getElementById(target)!;
    const dropdownKey = vi.fn((event: KeyboardEvent) => event.preventDefault());
    item.addEventListener('keydown', dropdownKey);
    document.addEventListener('keydown', capture, true);
    try {
      item.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      expect(dropdownKey).toHaveBeenCalledOnce();
      expect(cards.owner).toBe('report');
      const alreadyHandled = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
      alreadyHandled.preventDefault();
      expect(cards.handleEscape(alreadyHandled)).toBe(false);
      expect(cards.owner).toBe('report');
    } finally { document.removeEventListener('keydown', capture, true); }
  });

  it('closes the card on Escape from an already closed dropdown toggle even when Bootstrap prevents its default', () => {
    document.body.innerHTML = '<button data-bs-toggle="dropdown" aria-expanded="false">World</button>';
    cards = new POICardLifecycle(() => seed, vi.fn());
    cards.begin('report');
    const bootstrapKey = (event: KeyboardEvent) => { event.preventDefault(); };
    const cardKey = (event: KeyboardEvent) => { cards.handleEscape(event); };
    document.addEventListener('keydown', bootstrapKey, true);
    document.addEventListener('keydown', cardKey, true);
    try {
      document.querySelector('button')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      expect(cards.owner).toBeUndefined();
    } finally {
      document.removeEventListener('keydown', bootstrapKey, true);
      document.removeEventListener('keydown', cardKey, true);
    }
  });
});

it('retains a suspended report through card replacement and returns exactly once on final close', () => {
  const returnReport = vi.fn(), remove = vi.fn();
  const cards = new POICardLifecycle(() => 1, remove);
  const first = cards.begin('report', returnReport);
  cards.begin('map');
  expect(first.isCurrent()).toBe(false);
  expect(returnReport).not.toHaveBeenCalled();
  cards.close(); cards.close();
  expect(returnReport).toHaveBeenCalledOnce();
});

it('returns a suspended report when navigation fails, without reviving a cancelled card', async () => {
  const returnReport = vi.fn(), show = vi.fn();
  const cards = new POICardLifecycle(() => 1, () => {});
  cards.begin('report', returnReport).afterNavigation(Promise.resolve(false), show);
  await Promise.resolve();
  expect(returnReport).toHaveBeenCalledOnce();
  expect(show).not.toHaveBeenCalled();
  expect(cards.owner).toBeUndefined();
});


it('returns a suspended report if rendering the arrived card fails', async () => {
  const returnReport = vi.fn();
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const cards = new POICardLifecycle(() => 1, () => {});
    cards.begin('report', returnReport).afterNavigation(Promise.resolve(true), () => { throw new Error('render failed'); });
    await Promise.resolve();
    expect(returnReport).toHaveBeenCalledOnce();
    expect(cards.owner).toBeUndefined();
    expect(log).toHaveBeenCalledOnce();
  } finally { log.mockRestore(); }
});


it('report navigation closes a replacement map card carrying the suspended report return action', () => {
  const returnReport = vi.fn();
  const cards = new POICardLifecycle(() => 1, () => {});
  cards.begin('report', returnReport);
  const replacement = cards.begin('map');
  expect(cards.close({ reportOnly: true })).toBe(true);
  expect(replacement.isCurrent()).toBe(false);
  expect(returnReport).toHaveBeenCalledOnce();
  const unrelated = cards.begin('map');
  expect(cards.close({ reportOnly: true })).toBe(false);
  expect(unrelated.isCurrent()).toBe(true);
  cards.close();
});
