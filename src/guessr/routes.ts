export type GuessPane = 'home' | 'practice' | 'ranked' | 'history' | 'stream' | 'stream-picker' | 'stream-result' | 'pvp' | 'pvp-game';
export interface GuessRoute { pane: GuessPane; channel?: string; result?: string; game?: string; transport?: 'twitch' | 'parallel' }
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const codeAlphabet = '0123456789abcdefghjkmnpqrstvwxyz';
/** All 128 bits, without a lookup. 26 characters cannot collide with a legacy
 * Twitch username (at most 25 characters) under /guess/stream/<channel>/. */
export function gameCode(id: string, transport?: 'twitch' | 'parallel' | 'pvp'): string {
  if (!uuid.test(id)) throw new Error('Invalid game ID.');
  let value = BigInt('0x' + id.replaceAll('-', '')) | ((transport === 'pvp' ? 3n : transport === 'parallel' ? 2n : transport === 'twitch' ? 1n : 0n) << 128n), code = '';
  for (let i = 0; i < 26; i++) { code = codeAlphabet[Number(value & 31n)] + code; value >>= 5n; }
  return code;
}
export function gameIdFromCode(code: string): string | undefined {
  if (!/^[0-9abcdefghjkmnpqrstvwxyz]{26}$/i.test(code)) return;
  let value = 0n;
  for (const char of code.toLowerCase()) value = value * 32n + BigInt(codeAlphabet.indexOf(char));
  if (value >= 4n << 128n) return;
  value &= (1n << 128n) - 1n;
  const hex = value.toString(16).padStart(32, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
const paths: Record<GuessPane, string> = {
  home: '/guess/', practice: '/guess/demo/', ranked: '/guess/daily/', history: '/guess/history/',
  stream: '/guess/stream/', 'stream-picker': '/guess/join/', 'stream-result': '/guess/results/',
  pvp: '/guess/pvp/', 'pvp-game': '/guess/pvp/',
};
const reservedChannels = new Set(['demo', 'daily', 'history', 'join', 'stream', 'results', 'pvp']);
const validChannel = (value?: string | null) => value && /^[a-z0-9_]{1,25}$/i.test(value) ? value.toLowerCase() : undefined;

/** Shared by navigation and the dev server. Assets and OAuth callbacks are excluded. */
export function isGuessrPagePath(path: string): boolean {
  return /^\/guess\/(?:demo|daily|history|join|pvp)\/?$/.test(path)
    || /^\/guess\/stream(?:\/[a-z0-9_]{1,25})?\/?$/i.test(path)
    || /^\/guess\/results(?:\/[a-f0-9-]{36})?\/?$/.test(path)
    || /^\/guess\/[a-z0-9_]{1,25}\/[0-9abcdefghjkmnpqrstvwxyz]{26}\/?$/i.test(path)
    || /^\/guess\/[a-z0-9_]{1,25}\/?$/i.test(path) && !reservedChannels.has(path.split('/')[2].toLowerCase());
}
export function readGuessRoute(url: URL): GuessRoute {
  const path = url.pathname.replace(/\/$/, '');
  const pvp = /^\/guess\/pvp\/([0-9abcdefghjkmnpqrstvwxyz]{26})$/i.exec(path);
  if (pvp && codeAlphabet.indexOf(pvp[1][0].toLowerCase()) >= 24) { const game = gameIdFromCode(pvp[1]); if (game) return { pane: 'pvp-game', game, transport: 'parallel' }; }
  const channel = /^\/guess\/stream\/([a-z0-9_]{1,25})$/i.exec(path)?.[1];
  if (channel) return { pane: 'stream-picker', channel: channel.toLowerCase() };
  const gamePath = /^\/guess\/([a-z0-9_]{1,25})\/([0-9abcdefghjkmnpqrstvwxyz]{26})$/i.exec(path);
  if (gamePath) {
    const game = gameIdFromCode(gamePath[2]);
    if (game && codeAlphabet.indexOf(gamePath[2][0].toLowerCase()) >= 24) return { pane: 'pvp-game', game, transport: 'parallel' };
    if (game) return { pane: 'stream-picker', channel: gamePath[1].toLowerCase(), game,
      ...(codeAlphabet.indexOf(gamePath[2][0].toLowerCase()) >= 16 ? { transport: 'parallel' as const }
        : codeAlphabet.indexOf(gamePath[2][0].toLowerCase()) >= 8 ? { transport: 'twitch' as const } : {}) };
  }
  const result = /^\/guess\/results\/([a-f0-9-]{36})$/.exec(path)?.[1];
  if (result) return { pane: 'stream-result', result };
  for (const [pane, route] of Object.entries(paths)) {
    if (pane !== 'home' && path.toLowerCase() === route.replace(/\/$/, '')) {
      const channel = pane === 'history' ? validChannel(url.searchParams.get('channel')) : undefined;
      return { pane: pane as GuessPane, ...(channel ? { channel } : {}) };
    }
  }
  const historyChannel = /^\/guess\/([a-z0-9_]{1,25})$/i.exec(path)?.[1];
  if (historyChannel && !reservedChannels.has(historyChannel.toLowerCase())) return { pane: 'history', channel: historyChannel.toLowerCase() };
  // Keep already-shared links and saved login returns working.
  const legacy = url.searchParams.get('pane');
  const pane: GuessPane = legacy && Object.hasOwn(paths, legacy) ? legacy as GuessPane
    : !legacy && url.searchParams.has('channel') ? 'stream-picker' : 'home';
  return { pane, ...(pane === 'stream-picker' ? { channel: url.searchParams.get('channel')?.toLowerCase() }
    : pane === 'history' && validChannel(url.searchParams.get('channel')) ? { channel: validChannel(url.searchParams.get('channel')) } : {}),
    ...(pane === 'stream-result' ? { result: url.searchParams.get('result') ?? undefined } : {}) };
}
export function guessRouteUrl(pane: GuessPane, from: string | URL, details: { channel?: string; result?: string; game?: string; transport?: 'twitch' | 'parallel' } = {}): URL {
  const url = new URL(from), previous = readGuessRoute(url);
  const channel = validChannel(details.channel ?? (previous.pane === pane ? previous.channel : undefined));
  const result = details.result ?? (previous.pane === pane ? previous.result : undefined);
  const game = details.game ?? (previous.pane === pane && previous.channel === channel ? previous.game : undefined);
  const transport = details.transport ?? (previous.pane === pane && previous.channel === channel ? previous.transport : undefined);
  url.pathname = pane === 'pvp-game' && game ? `/guess/pvp/${gameCode(game, 'pvp')}/`
    : pane === 'stream-picker' && channel && /^[a-z0-9_]{1,25}$/i.test(channel)
    ? game ? `/guess/${channel.toLowerCase()}/${gameCode(game, transport)}/` : `/guess/stream/${channel.toLowerCase()}/`
    : pane === 'stream-result' && result && /^[a-f0-9-]{36}$/.test(result) ? `/guess/results/${result}/`
    : pane === 'history' && channel && !reservedChannels.has(channel) ? `/guess/${channel}/` : paths[pane];
  for (const key of ['pane', 'channel', 'result', 'round']) {
    url.searchParams.delete(key);
  }
  if (pane === 'history' && channel && reservedChannels.has(channel)) url.searchParams.set('channel', channel);
  if (pane !== 'ranked') for (const key of ['a', 'c']) url.searchParams.delete(key);
  const fragment = new URLSearchParams(url.hash.slice(1));
  if (pane !== 'stream-picker' && fragment.has('clue')) {
    fragment.delete('clue'); url.hash = fragment.toString();
  }
  return url;
}
