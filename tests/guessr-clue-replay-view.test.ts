// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { type ClueReplay } from '../src/guessr/clue-replay';
import { openClueReplay } from '../src/guessr/clue-replay-view';
import { sharedRoundResults } from '../src/guessr/stream-round-results';
import { streamResultsView } from '../src/guessr/stream-results';
import { initializeGuessrTranslations } from '../src/guessr/i18n';
import type { StreamRoundView } from '../src/guessr/stream-round-data';
import type { StreamResult } from '../src/guessr/stream-types';
import type { ImageGameConfig } from '../src/guessr/image-game';

const seen = vi.hoisted(() => ({
  focus: vi.fn(),
  players: vi.fn(),
  highlight: vi.fn(),
  show: vi.fn(async (_: unknown, ready?: () => void) => {
    ready?.();
    return true;
  }),
  destroy: vi.fn(),
}));
vi.mock('../src/guessr/clue-viewport', () => ({
  ClueViewport: class {
    show = seen.show;
    destroy = seen.destroy;
    stop() {}
  },
}));
vi.mock('../src/guessr/map-board', () => ({
  MapBoard: class {
    setLocked() {}
    setPlayers = seen.players;
    focusPlayer = seen.focus;
    highlightPlayer = seen.highlight;
    destroy() {}
  },
}));
vi.mock('../src/guessr/map-controls', () => ({ mapControls: () => document.createElement('div') }));
const config = { bounds: { x: -5000, y: -5000, width: 10000, height: 10000 } } as ImageGameConfig;
const host = { id: '100', login: 'host', name: 'Host' },
  player = { id: '200', login: 'chatter', name: 'Chatter' };
const round: StreamRoundView = {
  clueReplays: true,
  round: 1,
  host,
  answer: { x: 0, y: 0 },
  label: 'Mines',
  players: [
    { ...host, score: 1200, total: 1200, guess: { x: 10, y: 10 } },
    { ...player, score: 0, total: 0, guess: null },
  ],
};
const replay: ClueReplay = {
  clue: { frames: [{ image: '/clue.webp', x: -864, y: -384, width: 1728, height: 768 }] },
  steps: [
    { action: 'view', second: 0, camera: { dx: 0, dy: 0, level: 0 } },
    { action: 'right', second: 4, camera: { dx: 24, dy: 0, level: 0 } },
    { action: 'submit', second: 9, point: { x: 23, y: 84 } },
    { action: 'update', second: 23, point: { x: 55, y: 109 } },
  ],
};
beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  await initializeGuessrTranslations();
});
afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

it('keeps names plain, frames the pin on hover and opens only the requested inline timeline', async () => {
  const read = vi.fn(async () => replay);
  const close = sharedRoundResults(document.body, config, round, document.createElement('div'), { readReplay: read });
  const row = document.querySelector<HTMLTableRowElement>('tr[data-player="200"]')!;
  expect(row.cells[1].textContent).toBe('Chatter');
  expect(row.cells[1].querySelector('button')).toBeNull();
  row.dispatchEvent(new MouseEvent('mouseenter'));
  expect(seen.focus).toHaveBeenCalledWith('200');
  row.cells[2].querySelector('span')!.click();
  expect(read).not.toHaveBeenCalled();
  const open = row.cells[2].querySelector<HTMLButtonElement>('.clue-replay-open')!;
  expect(row.cells).toHaveLength(4);
  expect(open.getAttribute('aria-label')).toContain('Replay for Chatter');
  expect(open.querySelector('span')).toBeNull();
  expect(open.querySelector('.bi-play-fill')).not.toBeNull();
  open.click();
  await vi.waitFor(() => expect(document.querySelectorAll('.replay-step')).toHaveLength(4));
  expect(read).toHaveBeenCalledExactlyOnceWith(1, '200', expect.any(AbortSignal));
  expect(document.querySelector('dialog, input[type="range"]')).toBeNull();
  const steps = document.querySelectorAll<HTMLButtonElement>('.replay-step');
  expect([...steps].map(step => step.title)).toEqual(['Started view', 'Travel east', 'Sent guess', 'Updated guess']);
  expect(steps[3].textContent).toContain('23');
  steps[1].dispatchEvent(Object.assign(new Event('pointermove'), { pointerType: 'mouse', movementX: 1 }));
  await Promise.resolve();
  expect(seen.show).toHaveBeenLastCalledWith({ dx: 24, dy: 0, level: 0 }, expect.any(Function),
    expect.objectContaining({ replayFrom: { dx: 0, dy: 0, level: 0 } }));
  steps[3].focus();
  expect(document.querySelector('.replay-action-badge')?.textContent).toBe('Updated guess');
  expect(seen.players).toHaveBeenLastCalledWith(
    expect.arrayContaining([
      expect.objectContaining({ id: 'current', guess: { x: 55, y: 109 } }),
      expect.objectContaining({ id: 'previous', guess: { x: 23, y: 84 } }),
    ]),
    round.answer,
    expect.any(Function)
  );
  const item = document.querySelector<HTMLDetailsElement>('.replay-item')!;
  expect(row.nextElementSibling?.querySelector('details')).toBe(item);
  expect(row.nextElementSibling?.querySelector('td')?.colSpan).toBe(row.cells.length);
  expect(item.querySelector('ol.stepper.stepper-horizontal > li.stepper-item')).not.toBeNull();
  expect(item.querySelector('.replay-timeline')?.nextElementSibling?.querySelector('.replay-play')).not.toBeNull();
  expect(item.open).toBe(true);
  expect(item.querySelector('summary .stream-round-thumbnail')).not.toBeNull();
  expect(item.querySelector('select')).toBeNull();
  expect(item.querySelector('summary')?.textContent).toContain('Mines');
  item.querySelector('summary')!.click();
  await vi.waitFor(() => expect(open.getAttribute('aria-expanded')).toBe('false'));
  expect(item.open).toBe(false);
  open.click();
  await vi.waitFor(() => expect(open.getAttribute('aria-expanded')).toBe('true'));
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  close();
});

it('shows the round rank, round score and running total in a jump link for the current chatter', () => {
  const players = Array.from({length:70}, (_, i) => ({ ...player, id:String(100+i), name:'Player '+i,
    guess:round.answer, score:4000-i, total:8000-i }));
  const destroy = sharedRoundResults(document.body, config, { ...round, host:players[0], players },
    document.createElement('div'), { viewerId:players[52].id });
  try {
    const summary = document.querySelector('.score-summary')!;
    const row = summary.querySelector<HTMLTableRowElement>('tr[data-player="152"]')!;
    expect(row.cells[0].textContent).toBe('53');
    expect(row.cells[2].textContent).toBe('3,948');
    expect(row.cells[3].textContent).toBe('7,948');
    document.querySelector<HTMLButtonElement>('.stream-round-score-table th:nth-child(4) button')!.click();
    row.cells[2].click();
    expect(document.activeElement).toBe(document.querySelector('.stream-round-score-table tr[data-player="152"]'));
    expect(seen.focus).toHaveBeenCalledWith('152');
  } finally { destroy(); }
});

it('switches the one open replay between players and tables, aborting stale loads', async () => {
  const releases: ((r: ClueReplay) => void)[] = [];
  const read = vi.fn(
    (_n: number, _p: string, signal: AbortSignal) =>
      new Promise<ClueReplay>(r => {
        releases.push(r);
      })
  );
  const page = document.createElement('section');
  page.className = 'stream-results';
  document.body.append(page);
  const tables = [1, 2].map(number =>
    sharedRoundResults(page, config, { ...round, round: number }, document.createElement('div'), { readReplay: read })
  );
  try {
    const buttons = [...page.querySelectorAll<HTMLButtonElement>('.clue-replay-open')];
    for (const i of [0, 1, 2]) {
      buttons[i].click();
      const rows = page.querySelectorAll('tr.score-replay-row');
      expect(rows).toHaveLength(1);
      expect(rows[0].previousElementSibling).toBe(buttons[i].closest('tr'));
      expect(rows[0].querySelector('details[open]')).not.toBeNull();
      expect(page.querySelectorAll('button[aria-expanded="true"]')).toHaveLength(1);
      expect(buttons[i].getAttribute('aria-expanded')).toBe('true');
      if (i > 0) expect(read.mock.calls[i - 1][2].aborted).toBe(true);
    }
    expect(read).toHaveBeenCalledTimes(3);
    releases[0](replay);
    releases[1](replay);
    await Promise.resolve();
    expect(page.querySelector('.replay-step')).toBeNull();
    releases[2](replay);
    await vi.waitFor(() => expect(page.querySelectorAll('.replay-step')).toHaveLength(4));
    buttons[2].click();
    expect(read.mock.calls[2][2].aborted).toBe(true);
    expect(page.querySelector('.score-replay-row')).toBeNull();
  } finally {
    tables.forEach(destroy => destroy());
  }
});

it('holds each completed action for half a second and stops when closed', async () => {
  vi.useFakeTimers();
  try {
    const close = openClueReplay(
      '200',
      'Chatter',
      { number: 1, answer: round.answer, location: 'Mines' },
      async () => replay,
      {
        mount: document.body,
        config,
      }
    );
    await vi.advanceTimersByTimeAsync(0);
    const play = document.querySelector<HTMLButtonElement>('.replay-play')!;
    expect(play.textContent).toBe('Pause');
    expect(play.querySelector('.bi-pause-fill')).not.toBeNull();
    play.click();
    await vi.advanceTimersByTimeAsync(2000);
    expect(document.querySelector('[aria-current="step"]')?.getAttribute('data-step')).toBe('0');
    expect(play.textContent).toBe('Resume');
    play.click();
    await vi.advanceTimersByTimeAsync(495);
    expect(document.querySelector('[aria-current="step"]')?.getAttribute('data-step')).toBe('0');
    let finishPan!: (painted: boolean) => void;
    seen.show.mockImplementationOnce((_camera, ready) => {
      ready?.();
      return new Promise<boolean>(resolve => { finishPan = resolve; });
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(document.querySelector('[aria-current="step"]')?.getAttribute('data-step')).toBe('1');
    await vi.advanceTimersByTimeAsync(700);
    expect(document.querySelector('[aria-current="step"]')?.getAttribute('data-step')).toBe('1');
    finishPan(true);
    await vi.advanceTimersByTimeAsync(499);
    expect(document.querySelector('[aria-current="step"]')?.getAttribute('data-step')).toBe('1');
    await vi.advanceTimersByTimeAsync(1);
    expect(document.querySelector('[aria-current="step"]')?.getAttribute('data-step')).toBe('2');
    close();
    seen.players.mockClear();
    await vi.advanceTimersByTimeAsync(500);
    expect(seen.players).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

it('opens the pressed player when a previous replay moves their button before release', async () => {
  const destroy = sharedRoundResults(document.body, config, round, document.createElement('div'), {
    readReplay: async () => replay,
  });
  try {
    const [first, second] = document.querySelectorAll<HTMLButtonElement>('.clue-replay-open');
    first.click();
    second.setPointerCapture = vi.fn();
    const bounds = vi.spyOn(second, 'getBoundingClientRect').mockReturnValue(new DOMRect(10, 200, 40, 40));
    second.dispatchEvent(Object.assign(new MouseEvent('pointerdown', { bubbles: true, button: 0 }), {
      pointerId: 1, isPrimary: true,
    }));
    expect(second.setPointerCapture).toHaveBeenCalledWith(1);
    bounds.mockReturnValue(new DOMRect(10, 20, 40, 40));
    second.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1, clientX: 30, clientY: 220 }));
    expect(document.querySelectorAll('.score-replay-row')).toHaveLength(1);
    expect(document.querySelector('.score-replay-row')?.previousElementSibling).toBe(second.closest('tr'));
    expect(first.getAttribute('aria-expanded')).toBe('false');
    expect(second.getAttribute('aria-expanded')).toBe('true');
  } finally {
    destroy();
  }
});

it('exposes replay selection in final standings, including no-guess players, and keeps legacy scores readable', async () => {
  const result: StreamResult = {
    schema: 1,
    clueReplays: true,
    id: '11111111-1111-4111-8111-111111111111',
    version: 'test',
    createdAt: 1,
    finishedAt: 2,
    host,
    rounds: ['Mines', 'Vault'].map(name => ({ id: name, name, answer: round.answer, difficultyTier: 'normal' })),
    players: round.players.map((p, i) => ({
      ...p,
      rank: i + 1,
      rounds: [1, 2].map(() => ({ areaScore: p.score, positionScore: 0, score: p.score })),
    })),
  };
  const read = vi.fn(async () => ({ ...replay, steps: replay.steps.slice(0, 1) }));
  const view = streamResultsView(result, player.id, undefined, undefined, read);
  document.body.append(view);
  const cells = [...view.querySelectorAll<HTMLTableRowElement>('.stream-standings tbody tr')].find(row =>
    row.cells[1].textContent?.includes('Chatter')
  )!.cells;
  const button = cells[3].querySelector<HTMLButtonElement>('.clue-replay-open')!;
  expect(cells[2].querySelector('button')?.getAttribute('aria-label')).toContain('Round 1');
  expect(button.getAttribute('aria-label')).toContain('Round 2');
  expect(view.querySelector('details.stream-export-options')).toBeNull();
  expect([...view.querySelectorAll('.stream-results-menu > button')].map(b => b.textContent)).toEqual(
    expect.arrayContaining(['Save results as a web page', 'Save scores as a JSON file'])
  );
  button.click();
  await vi.waitFor(() => expect(view.querySelectorAll('.replay-step')).toHaveLength(1));
  expect(read).toHaveBeenCalledExactlyOnceWith(2, player.id, expect.any(AbortSignal));
  expect(view.querySelector('.replay-item summary')?.textContent).toContain('Vault');
  const play = view.querySelector<HTMLButtonElement>('.replay-play')!;
  expect(play.hidden).toBe(false);
  expect(play.textContent).toBe('Replay');
  expect(play.querySelector('.bi-arrow-counterclockwise')).not.toBeNull();
  play.click();
  expect(play.textContent).toBe('Pause');
  await vi.waitFor(() => expect(play.textContent).toBe('Replay'));
  expect(read).toHaveBeenCalledOnce();
  view.destroy();
  const legacy = streamResultsView({ ...result, clueReplays: undefined });
  expect(legacy.querySelector('.clue-replay-open')).toBeNull();
  legacy.destroy();
});

it('keeps a long timeline bounded and reaches the last and first step with the keyboard', async () => {
  const long: ClueReplay = {
    ...replay,
    steps: Array.from({ length: 1600 }, (_, i) => ({
      action: 'right' as const,
      second: i,
      camera: { dx: 24, dy: 0, level: 0 },
    })),
  };
  const close = openClueReplay(
    '200',
    'Chatter',
    { number: 1, answer: round.answer, location: 'Mines' },
    async () => long,
    {
      mount: document.body,
    }
  );
  try {
    await vi.waitFor(() => expect(document.querySelector('[data-step="0"]')).not.toBeNull());
    expect(document.querySelectorAll('.replay-step').length).toBeLessThan(120);
    expect(document.querySelector('.replay-timeline-pages')).toBeNull();
    const key = (id: number, key: string) =>
      document
        .querySelector<HTMLButtonElement>('[data-step="' + id + '"]')!
        .dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key }));
    key(0, 'End');
    expect((document.activeElement as HTMLElement).dataset.step).toBe('1599');
    key(1599, 'Home');
    expect((document.activeElement as HTMLElement).dataset.step).toBe('0');
  } finally {
    close();
  }
});

it('gives the clue and map in an expanded review one media column with individually rounded frames', () => {
  const clue = document.createElement('div');
  clue.className = 'stream-round-preview clue';
  const destroy = sharedRoundResults(document.body, config, round, document.createElement('div'), {
    inline: true,
    clue,
  });
  const grid = document.querySelector('.inline-round-review')!;
  expect(
    grid.querySelector('.round-review-table-body > .table-wrap.stream-score-frame.stream-round-score-scroll.rounded-9')
  ).not.toBeNull();
  const stack = grid.querySelector('.round-review-media')!;
  expect(stack.children[0]).toBe(clue);
  expect(stack.children[1].matches('.map-board')).toBe(true);
  const media = [...stack.querySelectorAll(':scope > .clue, :scope > .map-board')];
  expect(media).toHaveLength(2);
  for (const child of media) expect(child.matches('.border.rounded-9.overflow-hidden')).toBe(true);
  expect(stack.querySelector('.guessr-marker-hint [data-new-feature="markers"]')).not.toBeNull();
  destroy();
});
