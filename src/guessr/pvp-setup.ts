import { StreamApi } from './stream-api';
import { gameAuth } from './api';
import { streamingSetting } from './streaming-setting';
import { STREAM_DEFAULT_ROUNDS, STREAM_ROUND_OPTIONS, validStreamRoundCount } from './stream-types';
import { validStreamSeconds } from './stream-timing';
import { bindText, formatGuessrNumber, tr } from './i18n';
import { pageHeading } from './page-heading';
import { loadingPlaceholders } from './loading-placeholders';

export function mountPvpSetup(main: HTMLElement, open: (id: string) => void, back: () => void): () => void {
  let closed = false, busy = false, streaming = false;
  const api = new StreamApi(), card = document.createElement('section');
  card.className = 'card card-body rounded-9 stream-setup-card'; main.classList.add('stream-setup-shell'); main.append(card);
  const title = bindText(document.createElement('h1'), '1v1');
  const leave = bindText(document.createElement('button'), 'Back'); leave.type = 'button'; leave.onclick = back;
  card.append(pageHeading(title, leave), bindText(document.createElement('p'), 'Challenge another player. Only one of you needs Pro.'));
  const access = document.createElement('div'); card.append(access);
  const placeholders = loadingPlaceholders(); access.append(placeholders);
  const settings = document.createElement('fieldset'); settings.disabled = true; settings.className = 'd-grid gap-3 border-0 p-0 m-0';
  const length = document.createElement('select'); length.className = 'form-select';
  for (const count of STREAM_ROUND_OPTIONS) {
    const option = document.createElement('option'); option.value = String(count);
    bindText(option, '{{rounds}} rounds', { rounds: formatGuessrNumber(count), count }); length.append(option);
  }
  length.value = String(STREAM_DEFAULT_ROUNDS);
  const lengthLabel = document.createElement('label'); lengthLabel.className = 'stream-length-setting';
  lengthLabel.append(bindText(document.createElement('span'), 'Number of rounds'), length);
  const seconds = document.createElement('input'); seconds.type = 'number'; seconds.min = '15'; seconds.max = '600'; seconds.step = '1'; seconds.value = '90';
  const timeLabel = document.createElement('label'); timeLabel.className = 'stream-length-setting';
  timeLabel.append(bindText(document.createElement('span'), 'Round length (seconds)'), seconds);
  const create = bindText(document.createElement('button'), 'Create match'); create.type = 'button'; create.className = 'primary';
  const error = document.createElement('p'); error.className = 'form-text'; error.setAttribute('role', 'status');
  create.onclick = async () => {
    if (busy) return;
    const count = Number(length.value), duration = Number(seconds.value);
    if (!validStreamRoundCount(count) || !validStreamSeconds(duration) || !duration) { bindText(error, 'Choose a round duration between 15 and 600 seconds.'); return; }
    busy = true; settings.disabled = true; error.textContent = '';
    try {
      const session = await api.start('parallel', count, duration, streaming, 'pvp');
      if (session.mode !== 'pvp' || session.transport !== 'parallel') throw Error('1v1 is not available on this site yet.');
      if (!closed) open(session.id);
    } catch (reason) { if (!closed) bindText(error, (reason as Error).message); }
    finally { busy = false; if (!closed) settings.disabled = false; }
  };
  settings.append(lengthLabel, timeLabel, streamingSetting('pvp', value => { streaming = value; }).element, create, error); card.append(settings);
  void (async () => {
    try {
      if (!api.origin) throw Error('1v1 is not available on this site yet.');
      const auth = await gameAuth();
      if (closed) return;
      auth.registerLoginPreparation('guessr', () => ({ pane: 'pvp' }));
      placeholders.remove();
      if (!auth.getState().isSubscriber) {
        const { createProControls } = await import('../auth/pro-controls');
        if (closed) return;
        access.append(bindText(document.createElement('p'), 'The Pro player creates the match. Their opponent can play for free.'),
          createProControls({ idPrefix: 'guessr-pvp-', streamerMode: true }));
        return;
      }
      const state = auth.getState();
      if (state.provider !== 'twitch' && !state.linkedAccounts?.some(account => account.provider === 'twitch')) {
        const connect = bindText(document.createElement('button'), 'Connect Twitch'); connect.type = 'button'; connect.className = 'btn btn-twitch';
        connect.onclick = () => { void auth.loginTwitch(); };
        access.append(bindText(document.createElement('p'), 'Connect Twitch to your Pro account to create a 1v1 match.'), connect);
        return;
      }
      const player = state.linkedAccounts?.find(account => account.provider === 'twitch')?.username ?? state.username;
      if (player) access.append(bindText(document.createElement('p'), 'Playing as {{player}}', { player }));
      settings.disabled = false;
    } catch (reason) { placeholders.remove(); if (!closed) bindText(access, (reason as Error).message); }
  })();
  return () => { closed = true; };
}
