// @vitest-environment jsdom
import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';
import i18next from '../src/i18n';
import { initializeGuessrTranslations } from '../src/guessr/i18n';
import { streamResultHtml, streamResultsView } from '../src/guessr/stream-results';
import { streamHostName, streamResultNames } from '../src/guessr/stream-display-name';
import type { StreamResult } from '../src/guessr/stream-types';

vi.mock('../src/guessr/map-board', () => ({ MapBoard: class {} }));

const result: StreamResult = {
  schema: 1, id: '11111111-1111-4111-8111-111111111111', version: 'test', createdAt: 1, finishedAt: 2,
  host: { id: '123', login: 'streamer', name: 'Rank' },
  rounds: [{ id: 'round', answer: { x: 0, y: 0 }, name: 'Coal Pits', difficultyTier: 'normal' }],
  players: [
    { id: '123', login: 'streamer', name: 'Rank', score: 2000, rank: 2, rounds: [{ score: 2000, areaScore: 1000, positionScore: 1000 }] },
    { id: '456', login: 'chatter', name: 'Chatter', color: '#FF4500', score: 3000, rank: 1, rounds: [{ score: 3000, areaScore: 1000, positionScore: 2000 }] },
  ],
};

it('names the streamer and the chatter explicitly in their finishing positions, including ties', () => {
  const own = streamResultsView(result, '456'); document.body.append(own);
  expect(own.querySelector('.finish-hero')!.textContent).toContain('You finished 1st out of 2.');
  expect(own.querySelector('.finish-hero')!.textContent).toContain('Streamer Rank finished 2nd out of 2.');
  own.destroy(); own.remove();
  const tied = structuredClone(result); tied.players[0].rank = 1; tied.players[0].score = tied.players[1].score;
  const host = streamResultsView(tied, '123'); document.body.append(host);
  expect(host.querySelector('.stream-placement')!.textContent).toBe('Streamer Rank finished 1st out of 2.');
  expect(host.querySelector('.finish-hero')!.textContent).not.toContain('You finished');
  host.destroy();
});

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

it('shows the saved Twitch login in old Patron-labelled results and offline exports without changing their data', () => {
  vi.stubGlobal('fetch', vi.fn(() => { throw Error('Name repair must not request a profile'); }));
  const old = structuredClone(result); old.host.name = 'Patron'; old.players[0].name = 'Patron';
  const view = streamResultsView(old);
  expect(view.querySelector('h1')!.textContent).toBe('streamer’s results');
  expect(view.querySelector('.stream-host-row')!.children[1].textContent).toBe('streamer, Streamer');
  const filter = view.querySelector('input')!;
  filter.value = 'streamer'; filter.dispatchEvent(new Event('input'));
  expect(view.querySelectorAll('tbody tr')).toHaveLength(1);
  const offline = new JSDOM(streamResultHtml(old), { runScripts: 'dangerously' });
  try { expect(offline.window.document.querySelector('tr.host')!.children[1].textContent).toBe('streamer, Streamer'); }
  finally { offline.window.close(); }
  const exported = streamResultNames(old);
  expect(exported.host.name).toBe('streamer'); expect(exported.players[0].name).toBe('streamer');
  expect(exported.players[0].rounds).toBe(old.players[0].rounds);
  expect(exported.players[0].score).toBe(old.players[0].score);
  expect(old.host.name).toBe('Patron'); expect(old.players[0].name).toBe('Patron');
  expect(fetch).not.toHaveBeenCalled();
});

it('keeps real Twitch display names, including a channel actually named Patron and any chatter name', () => {
  expect(streamResultNames(result)).toBe(result);
  const patronChannel = structuredClone(result); patronChannel.host = { ...patronChannel.host, login: 'patron', name: 'Patron' };
  patronChannel.players[0] = { ...patronChannel.players[0], login: 'patron', name: 'Patron' };
  patronChannel.players[1].name = 'Patron';
  expect(streamResultNames(patronChannel)).toBe(patronChannel);
  const old = structuredClone(result); old.host.name = 'Patron'; old.players[0].name = 'MyChannel';
  old.players[1].name = 'Patron';
  const fixed = streamResultNames(old);
  expect(fixed.host.name).toBe('MyChannel'); expect(fixed.players[1].name).toBe('Patron');
  expect(streamHostName(old.host, old.players[1])).toBe('streamer');
});

it('keeps result filtering and sorting while translating labels, numbers, and player suffixes', async () => {
  await translations();
  const section = streamResultsView(result); document.body.append(section);
  expect((section.querySelector('tbody tr')!.children[1] as HTMLElement).style.color).toBe('rgb(255, 69, 0)');
  expect((section.querySelector('.stream-host-row')!.children[1] as HTMLElement).style.color).toBe('rgb(145, 70, 255)');
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
    expect(doc.querySelector('tbody tr')!.children[1].textContent).not.toMatch(/[<>]/);
    expect(doc.querySelector('tbody tr')!.children[1].textContent).toContain('window.playerTextExecuted=true');
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
