// @vitest-environment jsdom
import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';
import i18next from '../src/i18n';
import { initializeGuessrTranslations } from '../src/guessr/i18n';
import { streamResultHtml, streamResultsView } from '../src/guessr/stream-results';
import type { StreamResult } from '../src/guessr/stream-types';

const result: StreamResult = {
  schema: 1, id: '11111111-1111-4111-8111-111111111111', version: 'test', createdAt: 1, finishedAt: 2,
  host: { id: '123', login: 'streamer', name: 'Rank' },
  rounds: [{ id: 'round', answer: { x: 0, y: 0 }, name: 'Coal Pits', difficultyTier: 'normal' }],
  players: [
    { id: '123', login: 'streamer', name: 'Rank', score: 2000, rank: 2, rounds: [{ score: 2000, areaScore: 1000, positionScore: 1000 }] },
    { id: '456', login: 'chatter', name: 'Chatter', score: 3000, rank: 1, rounds: [{ score: 3000, areaScore: 1000, positionScore: 2000 }] },
  ],
};

async function translations() {
  await initializeGuessrTranslations();
  i18next.addResourceBundle('de', 'translation', {}, true, true);
  i18next.addResourceBundle('de', 'guessr', {
    'Rank': 'Rang', 'Player': 'Spieler', 'Total': 'Gesamt', 'Find a player': 'Spieler suchen',
    '{{shown}} of {{players}} players_other': '{{shown}} von {{players}} Spielern',
    ', Streamer': ', Streamer', '{{points}} points_other': '{{points}} Punkte',
    '{{rounds}} rounds_one': '{{rounds}} Runde', '{{rounds}} rounds_other': '{{rounds}} Runden',
  }, true, true);
}

afterEach(async () => {
  document.body.replaceChildren();
  if (i18next.isInitialized) await i18next.changeLanguage('en');
  vi.unstubAllGlobals();
});

it('keeps result filtering and sorting while translating labels, numbers, and player suffixes', async () => {
  await translations();
  const section = streamResultsView(result); document.body.append(section);
  const total = [...section.querySelectorAll('th button')].find(button => button.textContent === 'Total') as HTMLButtonElement;
  total.click();
  const filter = section.querySelector('input')!;
  filter.value = 'Rank'; filter.dispatchEvent(new Event('input'));
  const rows = section.querySelector('tbody')!;
  const row = rows.firstElementChild;
  await i18next.changeLanguage('de');
  expect(filter.value).toBe('Rank');
  expect(filter.placeholder).toBe('Spieler suchen');
  expect(rows.firstElementChild).toBe(row);
  expect(rows.children).toHaveLength(1);
  expect(row!.children[1].textContent).toBe('Rank, Streamer');
  expect(row!.lastElementChild!.textContent).toBe('2.000');
  expect(total.textContent).toBe('Gesamt');
  expect(total.parentElement!.getAttribute('aria-sort')).toBe('descending');
});

it('exports a localized standalone web page that filters and sorts offline without executing player text', async () => {
  await translations(); await i18next.changeLanguage('de');
  const unsafe = structuredClone(result);
  unsafe.players[1].name = '</script><script>window.playerTextExecuted=true</script>';
  const html = streamResultHtml(unsafe);
  expect(html).not.toContain(unsafe.players[1].name);
  expect(html).not.toMatch(/(?:src|href)=["']https?:/);
  const offline = new JSDOM(html, { runScripts: 'dangerously' });
  try {
    const doc = offline.window.document;
    expect(doc.documentElement.lang).toBe('de');
    expect(doc.querySelector('th button')!.textContent).toBe('Rang');
    expect(doc.querySelector('#summary')!.textContent).toContain('2.000 Punkte, 1 Runde');
    expect(doc.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(doc.querySelector('tbody tr')!.children[1].textContent).toBe(unsafe.players[1].name);
    expect((offline.window as unknown as { playerTextExecuted?: boolean }).playerTextExecuted).toBeUndefined();
    const filter = doc.querySelector<HTMLInputElement>('#filter')!;
    filter.value = 'streamer'; filter.dispatchEvent(new offline.window.Event('input'));
    expect(doc.querySelectorAll('tbody tr')).toHaveLength(1);
    expect(doc.querySelector('#count')!.textContent).toBe('1 von 2 Spielern');
    filter.value = ''; filter.dispatchEvent(new offline.window.Event('input'));
    (doc.querySelector('th button') as HTMLButtonElement).click();
    expect(doc.querySelector('tbody tr')!.children[1].textContent).toBe('Rank, Streamer');
  } finally { offline.window.close(); }
});
