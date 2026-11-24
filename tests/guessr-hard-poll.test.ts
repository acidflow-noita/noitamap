// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openHardPoll } from '../src/guessr/hard-poll';
import { createPollBanner } from '../src/guessr/poll-banner';
import type { GuessrBallot } from '../workers/noitamap-auth/src/poll-contract';

const fixture = vi.hoisted(() => ({
  ballot: vi.fn(), auth: vi.fn(), owner: 'voter' as string | undefined, login: vi.fn(), loginTwitch: vi.fn(),
}));
vi.mock('../src/guessr/api', () => ({ gameAuth: fixture.auth }));
vi.mock('bootstrap/js/dist/dialog.js', () => ({ default: class {
  constructor(private dialog: HTMLDialogElement) {}
  async show() { this.dialog.setAttribute('open', ''); }
  dispose() {}
} }));

const empty: GuessrBallot = { phase: 'open', serverNow: 1000, opensAt: 1, closesAt: 259201, vote: null };
const textButton = (label: string) => [...document.querySelectorAll('button')].find(b => b.textContent === label)!;
const beforeLogin = vi.fn(), afterVote = vi.fn();
function open() {
  const trigger = document.createElement('button'); document.body.append(trigger);
  openHardPoll(trigger, null, beforeLogin, afterVote);
}

beforeEach(() => {
  vi.clearAllMocks(); sessionStorage.clear(); fixture.owner = 'voter';
  fixture.ballot.mockReset().mockResolvedValue(empty);
  fixture.auth.mockResolvedValue({ getState: () => ({ accountId: fixture.owner }), subscribe: () => () => {},
    login: fixture.login, loginTwitch: fixture.loginTwitch, guessrBallot: fixture.ballot });
});
afterEach(() => document.body.replaceChildren());

it('displays the invitation without a poll request and dismisses it for the session', () => {
  const start = Math.floor(Date.now() / 1000) - 300;
  const banner = createPollBanner(vi.fn(), start); document.body.append(banner);
  expect(fixture.auth).not.toHaveBeenCalled();
  expect(banner.querySelector('time')!.dateTime).toBe(new Date((start + 259200) * 1000).toISOString());
  banner.querySelector<HTMLButtonElement>('.btn-close')!.click();
  expect(banner.hidden).toBe(true); expect(createPollBanner(vi.fn(), start).hidden).toBe(true);
});

it('hides the strip at closing in an open tab and on return from sign-in', () => {
  vi.useFakeTimers();
  try {
    const start = 1_795_152_480, close = (start + 259200) * 1000;
    vi.setSystemTime(close - 1000);
    const banner = createPollBanner(vi.fn(), start);
    document.body.append(banner);
    expect(banner.hidden).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(banner.hidden).toBe(true);

    sessionStorage.setItem('guessr-hard-poll-return-v1', JSON.stringify({ path: location.pathname, choice: 'no', at: close - 1000 }));
    const returned = createPollBanner(vi.fn(), start);
    expect(returned.hidden).toBe(true);
    expect(returned.childElementCount).toBe(0);
    expect(fixture.auth).not.toHaveBeenCalled();
  } finally { vi.useRealTimers(); }
});

it('requires an explicit choice and confirms the receipt returned by the server', async () => {
  open(); await vi.waitFor(() => expect(textButton('Cast vote')?.disabled).toBe(true));
  document.querySelector<HTMLInputElement>('input[value=yes]')!.click();
  fixture.ballot.mockResolvedValueOnce({ ...empty, vote: 'no' });
  textButton('Cast vote').click();
  await vi.waitFor(() => expect(afterVote).toHaveBeenCalledOnce());
  expect(fixture.ballot).toHaveBeenLastCalledWith('yes', 'voter');
  expect(document.querySelector<HTMLInputElement>('input[value=no]')!.checked).toBe(true);
  expect(document.querySelector<HTMLFieldSetElement>('fieldset')!.disabled).toBe(true);
});

it('checks a lost acknowledgement without casting again', async () => {
  open(); await vi.waitFor(() => expect(textButton('Cast vote')).toBeTruthy());
  document.querySelector<HTMLInputElement>('input[value=yes]')!.click();
  fixture.ballot.mockRejectedValueOnce(Error('Offline')).mockResolvedValueOnce({ ...empty, vote: 'yes' });
  textButton('Cast vote').click(); await vi.waitFor(() => expect(textButton('Retry')).toBeTruthy());
  textButton('Retry').click(); await vi.waitFor(() => expect(afterVote).toHaveBeenCalledOnce());
  expect(fixture.ballot.mock.calls).toEqual([[], ['yes', 'voter'], []]);
});

it('lets a visitor examine both examples and sign in with a draft without submitting it', async () => {
  fixture.owner = undefined; open();
  await vi.waitFor(() => expect(textButton('Sign in with Twitch')).toBeTruthy());
  const examples = document.querySelectorAll<HTMLButtonElement>('.poll-examples button'); examples[1].click();
  expect(document.querySelector<HTMLImageElement>('dialog img')!.src).toContain('/hell.webp');
  document.querySelector<HTMLInputElement>('input[value=no]')!.click(); textButton('Sign in with Twitch').click();
  expect(beforeLogin).toHaveBeenCalledWith('no'); expect(fixture.loginTwitch).toHaveBeenCalledOnce();
  expect(fixture.ballot.mock.calls).toEqual([[]]);
});
