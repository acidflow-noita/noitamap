export type GuessPane = 'home' | 'practice' | 'ranked' | 'history' | 'stream' | 'stream-picker' | 'stream-result';
export interface GuessRoute { pane: GuessPane; channel?: string; result?: string; game?: string; transport?: 'twitch' }
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const codeAlphabet = '0123456789abcdefghjkmnpqrstvwxyz';
/** All 128 bits, without a lookup. 26 characters cannot collide with a legacy
 * Twitch username (at most 25 characters) under /guess/stream/<channel>/. */
export function gameCode(id: string, transport?: 'twitch'): string {
  if (!uuid.test(id)) throw new Error('Invalid game ID.');
  let value = BigInt('0x' + id.replaceAll('-', '')) | (transport === 'twitch' ? 1n << 128n : 0n), code = '';
  for (let i = 0; i < 26; i++) { code = codeAlphabet[Number(value & 31n)] + code; value >>= 5n; }
  return code;
}
export function gameIdFromCode(code: string): string | undefined {
  if (!/^[0-9abcdefghjkmnpqrstvwxyz]{26}$/i.test(code)) return;
  let value = 0n;
  for (const char of code.toLowerCase()) value = value * 32n + BigInt(codeAlphabet.indexOf(char));
  if (value >= 1n << 129n) return;
  value &= (1n << 128n) - 1n;
  const hex = value.toString(16).padStart(32, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
const paths: Record<GuessPane, string> = {
  home: '/guess/', practice: '/guess/demo/', ranked: '/guess/daily/', history: '/guess/history/',
  stream: '/guess/stream/', 'stream-picker': '/guess/join/', 'stream-result': '/guess/results/',
};

/** Shared by navigation and the dev server. Assets and OAuth callbacks are excluded. */
export function isGuessrPagePath(path: string): boolean {
  return /^\/guess\/(?:demo|daily|history|join)\/?$/.test(path)
    || /^\/guess\/stream(?:\/[a-z0-9_]{1,25})?\/?$/i.test(path)
    || /^\/guess\/results(?:\/[a-f0-9-]{36})?\/?$/.test(path)
    || /^\/guess\/[a-z0-9_]{1,25}\/[0-9abcdefghjkmnpqrstvwxyz]{26}\/?$/i.test(path);
}
export function readGuessRoute(url: URL): GuessRoute {
  const path = url.pathname.replace(/\/$/, '');
  const channel = /^\/guess\/stream\/([a-z0-9_]{1,25})$/i.exec(path)?.[1];
  if (channel) return { pane: 'stream-picker', channel: channel.toLowerCase() };
  const gamePath = /^\/guess\/([a-z0-9_]{1,25})\/([0-9abcdefghjkmnpqrstvwxyz]{26})$/i.exec(path);
  if (gamePath) {
    const game = gameIdFromCode(gamePath[2]);
    if (game) return { pane: 'stream-picker', channel: gamePath[1].toLowerCase(), game,
      ...(codeAlphabet.indexOf(gamePath[2][0].toLowerCase()) >= 8 ? { transport: 'twitch' as const } : {}) };
  }
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
export function guessRouteUrl(pane: GuessPane, from: string | URL, details: { channel?: string; result?: string; game?: string; transport?: 'twitch' } = {}): URL {
  const url = new URL(from), previous = readGuessRoute(url);
  const channel = details.channel ?? (previous.pane === pane ? previous.channel : undefined);
  const result = details.result ?? (previous.pane === pane ? previous.result : undefined);
  const game = details.game ?? (previous.pane === pane && previous.channel === channel ? previous.game : undefined);
  const transport = details.transport ?? (previous.pane === pane && previous.channel === channel ? previous.transport : undefined);
  url.pathname = pane === 'stream-picker' && channel && /^[a-z0-9_]{1,25}$/i.test(channel)
    ? game ? `/guess/${channel.toLowerCase()}/${gameCode(game, transport)}/` : `/guess/stream/${channel.toLowerCase()}/`
    : pane === 'stream-result' && result && /^[a-f0-9-]{36}$/.test(result) ? `/guess/results/${result}/` : paths[pane];
  for (const key of ['pane', 'channel', 'result', 'round']) url.searchParams.delete(key);
  if (pane !== 'ranked') for (const key of ['a', 'c']) url.searchParams.delete(key);
  const fragment = new URLSearchParams(url.hash.slice(1));
  if (pane !== 'stream-picker' && fragment.has('clue')) {
    fragment.delete('clue'); url.hash = fragment.toString();
  }
  return url;
}
