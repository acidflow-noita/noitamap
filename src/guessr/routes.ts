export type GuessPane = 'home' | 'practice' | 'ranked' | 'history' | 'stream' | 'stream-picker' | 'stream-result';
export interface GuessRoute { pane: GuessPane; channel?: string; result?: string }
const paths: Record<GuessPane, string> = {
  home: '/guess/', practice: '/guess/demo/', ranked: '/guess/daily/', history: '/guess/history/',
  stream: '/guess/stream/', 'stream-picker': '/guess/join/', 'stream-result': '/guess/results/',
};

/** Shared by navigation and the dev server. Assets and OAuth callbacks are excluded. */
export function isGuessrPagePath(path: string): boolean {
  return /^\/guess\/(?:demo|daily|history|join)\/?$/.test(path)
    || /^\/guess\/stream(?:\/[a-z0-9_]{1,25})?\/?$/i.test(path)
    || /^\/guess\/results(?:\/[a-f0-9-]{36})?\/?$/.test(path);
}
export function readGuessRoute(url: URL): GuessRoute {
  const path = url.pathname.replace(/\/$/, '');
  const channel = /^\/guess\/stream\/([a-z0-9_]{1,25})$/i.exec(path)?.[1];
  if (channel) return { pane: 'stream-picker', channel: channel.toLowerCase() };
  const result = /^\/guess\/results\/([a-f0-9-]{36})$/.exec(path)?.[1];
  if (result) return { pane: 'stream-result', result };
  for (const [pane, route] of Object.entries(paths)) {
    if (pane !== 'home' && path === route.replace(/\/$/, '')) return { pane: pane as GuessPane };
  }
  // Keep already-shared links and saved login returns working.
  const legacy = url.searchParams.get('pane');
  const pane: GuessPane = legacy && Object.hasOwn(paths, legacy) ? legacy as GuessPane
    : !legacy && url.searchParams.has('channel') ? 'stream-picker' : 'home';
  return { pane, ...(pane === 'stream-picker' ? { channel: url.searchParams.get('channel')?.toLowerCase() } : {}),
    ...(pane === 'stream-result' ? { result: url.searchParams.get('result') ?? undefined } : {}) };
}
export function guessRouteUrl(pane: GuessPane, from: string | URL, details: { channel?: string; result?: string } = {}): URL {
  const url = new URL(from), previous = readGuessRoute(url);
  const channel = details.channel ?? (previous.pane === pane ? previous.channel : undefined);
  const result = details.result ?? (previous.pane === pane ? previous.result : undefined);
  url.pathname = pane === 'stream-picker' && channel && /^[a-z0-9_]{1,25}$/i.test(channel)
    ? `/guess/stream/${channel.toLowerCase()}/`
    : pane === 'stream-result' && result && /^[a-f0-9-]{36}$/.test(result) ? `/guess/results/${result}/` : paths[pane];
  for (const key of ['pane', 'channel', 'result', 'round']) url.searchParams.delete(key);
  if (pane !== 'ranked') for (const key of ['a', 'c']) url.searchParams.delete(key);
  const fragment = new URLSearchParams(url.hash.slice(1));
  if (pane !== 'stream-picker' && fragment.has('clue')) {
    fragment.delete('clue'); url.hash = fragment.toString();
  }
  return url;
}
