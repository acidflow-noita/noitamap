import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { accountDatabase } from './helpers/auth-account-db';
import { verifyGameTicket } from '../workers/noitamap-guessr/src/tickets';

let worker: { fetch(request: Request, env: unknown): Promise<Response> };
const secret = (value: string) => ({ get: async () => value });
const signingKey = 'local-only-account-link-test-secret-long-enough';
const gameKey = 'local-only-separate-game-ticket-secret-long-enough';
let db: ReturnType<typeof accountDatabase>;
let env: Record<string, unknown>;
let providerFetch: ReturnType<typeof vi.fn>;
type Person = { id: string; login: string; displayName?: string; subscriber: boolean; scope: string[]; campaign?: string; patronStatus?: string; amount?: number };
let people: Record<string, Person>;
let validation: Record<string, unknown> | null;

beforeAll(async () => {
  const result = await build({ entryPoints: ['workers/noitamap-auth/src/index.ts'], bundle: true, write: false,
    format: 'iife', globalName: 'AuthTest', platform: 'neutral', target: 'es2022' });
  worker = new Function(result.outputFiles[0].text + '\nreturn AuthTest.default;')();
});
beforeEach(() => {
  db = accountDatabase();
  env = { JWT_SECRET: secret(signingKey), ACCOUNT_DB: db.binding, GAME_SIGNING_SECRET: gameKey,
    PATREON_CLIENT_ID: secret('patreon-client'), PATREON_CLIENT_SECRET: secret('patreon-secret'),
    PATREON_CAMPAIGN_ID: secret('campaign'), CREATOR_USER_ID: secret('creator'),
    TWITCH_CLIENT_ID: secret('twitch-client'), TWITCH_CLIENT_SECRET: secret('twitch-secret'),
    WORKER_URL: 'https://auth.test', ALLOWED_ORIGINS: 'https://noitamap.test,https://dynamic-map.noitamap.test' };
  people = {
    patron: { id: 'patreon-1', login: 'PatronOne', subscriber: true, scope: [] },
    patron2: { id: 'patreon-2', login: 'PatronTwo', subscriber: false, scope: [] },
    twitch: { id: '12345', login: 'mychannel', subscriber: false, scope: [] },
    twitch2: { id: '67890', login: 'anotherchannel', subscriber: false, scope: [] },
  };
  validation = null;
  providerFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const auth = new Headers(init?.headers).get('Authorization') || '';
    if (url.pathname.endsWith('/token')) {
      const body = new URLSearchParams(String(init?.body));
      const key = body.get('code') || body.get('refresh_token')?.replace('refresh-', '') || '';
      const person = people[key];
      if (!person) return Response.json({ error: 'invalid_grant' }, { status: 400 });
      return Response.json({ access_token: `access-${key}`, refresh_token: `refresh-${key}`, expires_in: 3600,
        scope: url.hostname.includes('patreon') ? 'identity identity.memberships' : person.scope });
    }
    const key = auth.replace(/^(Bearer|OAuth) access-/, '');
    const person = people[key];
    if (!person) throw new Error(`Unknown provider token: ${url.href}`);
    if (url.pathname.endsWith('/identity')) return Response.json({
      data: { id: person.id, type: 'user', attributes: { vanity: person.login } },
      included: [{ type: 'member', id: 'membership', attributes: {
        patron_status: person.patronStatus || (person.subscriber ? 'active_patron' : 'declined_patron'),
        currently_entitled_amount_cents: person.amount ?? (person.subscriber ? 100 : 0),
      }, relationships: { campaign: { data: { id: person.campaign || 'campaign', type: 'campaign' } } } }],
    });
    if (url.pathname === '/helix/users') return Response.json({ data: [{ id: person.id, login: person.login, display_name: person.displayName ?? person.login }] });
    if (url.pathname === '/oauth2/validate') return Response.json(validation || {
      client_id: 'twitch-client', user_id: person.id, login: person.login, scopes: person.scope, expires_in: 3500,
    });
    throw new Error(`Unexpected provider request: ${url.href}`);
  });
  vi.stubGlobal('fetch', providerFetch);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); db.sqlite.close(); });

async function request(path: string, token?: string, body?: unknown, origin = 'https://noitamap.test') {
  return worker.fetch(new Request('https://auth.test' + path, { method: body === undefined ? 'GET' : 'POST',
    headers: { Origin: origin, ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }), env);
}
async function oauth(start: Response, person: string, cookie = true) {
  expect(start.status).toBe(302);
  const auth = new URL(start.headers.get('Location')!);
  const callback = new URL(auth.searchParams.get('redirect_uri')!);
  callback.searchParams.set('state', auth.searchParams.get('state')!);
  callback.searchParams.set('code', person);
  const response = await worker.fetch(new Request(callback, { headers: cookie ? { Cookie: start.headers.get('Set-Cookie')!.split(';')[0] } : {} }), env);
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get('Location')!);
  return { location, fragment: new URLSearchParams(location.hash.slice(1)) };
}
async function login(provider: 'patreon' | 'twitch', person = provider === 'patreon' ? 'patron' : 'twitch', chat = false, announcements = false) {
  const start = await request(`/auth/${provider === 'twitch' ? 'twitch/login' : 'login'}?redirect=https://noitamap.test/guess/${chat ? '&chat=1' : ''}${announcements ? '&announcements=1' : ''}`);
  const result = await oauth(start, person);
  expect(result.fragment.get('auth')).toBe('success');
  return { token: result.fragment.get('token')!, refresh: result.fragment.get('refresh_token')! };
}
async function beginLink(token: string, provider: string, chat = false, announcements = false) {
  const begin = await request('/auth/link/start', token, { provider, chat, announcements, redirect: 'https://noitamap.test/guess/' });
  expect(begin.status).toBe(200);
  const { url } = await begin.json() as { url: string };
  return worker.fetch(new Request(url), env);
}
async function link(token: string, provider: string, person: string, chat = false) {
  const result = await oauth(await beginLink(token, provider, chat), person);
  expect(result.fragment.get('auth')).toBe('linked');
  expect(result.fragment.has('token')).toBe(false);
  return request('/auth/link/complete', token, { linkToken: result.fragment.get('link_token') });
}
const check = async (token: string) => (await request('/auth/check', token)).json() as Promise<any>;

describe('durable linked Pro accounts', () => {
  it('preserves Patreon Pro when connecting an unsubscribed Twitch and uses verified Twitch ticket claims', async () => {
    const patron = await login('patreon');
    const before = await check(patron.token);
    const response = await link(patron.token, 'twitch', 'twitch');
    expect(response.status).toBe(200);
    const linked = await response.json() as any;
    expect(linked).toMatchObject({ accountId: before.accountId, provider: 'patreon', isSubscriber: true });
    expect(linked.linkedAccounts).toMatchObject([
      { provider: 'patreon', membershipStatus: 'active', isSubscriber: true },
      { provider: 'twitch', userId: '12345', login: 'mychannel', membershipStatus: 'inactive', isSubscriber: false },
    ]);
    const calls = providerFetch.mock.calls.length;
    await check(linked.token); await check(linked.token);
    const ticket = await (await request('/auth/game-ticket', linked.token, {})).json() as any;
    expect(await verifyGameTicket(ticket.token, gameKey)).toMatchObject({
      sub: `account:${before.accountId}`, name: 'mychannel', twitchUserId: '12345', twitchLogin: 'mychannel', pro: true,
    });
    expect(providerFetch).toHaveBeenCalledTimes(calls);
    const decoded = JSON.parse(Buffer.from(linked.token.split('.')[1], 'base64url').toString());
    expect(decoded.is_subscriber).toBe(true); // Existing Pro asset Worker contract.
    const credentials = db.sqlite.prepare('SELECT credentials FROM auth_identities').all();
    expect(JSON.stringify(credentials)).not.toContain('refresh-patron');
    expect(JSON.stringify(credentials)).not.toContain('access-twitch');
    expect(JSON.stringify(JSON.parse(Buffer.from(linked.refresh_token.split('.')[1], 'base64url').toString()))).not.toContain('refresh-patron');
    const signedInWithTwitch = await login('twitch');
    expect(await check(signedInWithTwitch.token)).toMatchObject({ accountId: before.accountId, isSubscriber: true });
  });

  it.each(['', 'PatreonAlias'])('uses the linked Twitch display name while keeping Patreon Pro (vanity: %s)', async vanity => {
    people.patron.login = vanity;
    people.twitch.displayName = 'MyChannel';
    const patron = await login('patreon');
    const standaloneTicket = await (await request('/auth/game-ticket', patron.token, {})).json() as { token: string };
    expect(await verifyGameTicket(standaloneTicket.token, gameKey)).toMatchObject({ name: vanity || 'Patron', pro: true });
    const linked = await (await link(patron.token, 'twitch', 'twitch')).json() as { token: string; accountId: string };
    const calls = providerFetch.mock.calls.length;
    const ticket = await (await request('/auth/game-ticket', linked.token, {})).json() as { token: string };
    expect(await verifyGameTicket(ticket.token, gameKey)).toMatchObject({
      sub: `account:${linked.accountId}`, name: 'MyChannel', twitchUserId: '12345', twitchLogin: 'mychannel', pro: true,
    });
    expect(providerFetch).toHaveBeenCalledTimes(calls);
    expect(await check(linked.token)).toMatchObject({ provider: 'patreon', isSubscriber: true });
  });

  it('merges independently signed-in single-provider accounts only after both ownership proofs', async () => {
    const patron = await login('patreon');
    const twitch = await login('twitch');
    const response = await link(patron.token, 'twitch', 'twitch');
    expect(response.status).toBe(200);
    expect(await check(twitch.token)).toEqual({ authenticated: false });
    expect((await check(patron.token)).linkedAccounts).toHaveLength(2);
  });

  it('requires the original authenticated account to complete a link and rejects replay', async () => {
    const owner = await login('patreon');
    const other = await login('patreon', 'patron2');
    const result = await oauth(await beginLink(owner.token, 'twitch'), 'twitch');
    const body = { linkToken: result.fragment.get('link_token') };
    expect((await request('/auth/link/complete', undefined, body)).status).toBe(401);
    expect((await request('/auth/link/complete', other.token, body)).status).toBe(409);
    expect((await request('/auth/link/complete', owner.token, body)).status).toBe(200);
    expect((await request('/auth/link/complete', owner.token, body)).status).toBe(409);
    expect((await check(other.token)).linkedAccounts).toHaveLength(1);
  });

  it('binds OAuth callbacks to the browser cookie and requires allowed-origin authenticated starts', async () => {
    const owner = await login('patreon');
    expect((await request('/auth/link/start', undefined, { provider: 'twitch' })).status).toBe(401);
    expect((await request('/auth/link/start', owner.token, { provider: 'twitch' }, 'https://attacker.test')).status).toBe(403);
    const response = await oauth(await beginLink(owner.token, 'twitch'), 'twitch', false);
    expect(response.location.searchParams.get('auth_error')).toBe('invalid_state');
    expect((await check(owner.token)).linkedAccounts).toHaveLength(1);
  });

  it('strips session credentials from a caller-supplied return URL before link completion', async () => {
    const owner = await login('patreon');
    const start = await request('/auth/link/start', owner.token, { provider: 'twitch',
      redirect: 'https://noitamap.test/guess/?auth=success&token=injected&refresh_token=injected&link_token=injected&mode=stream' });
    const { url } = await start.json() as any;
    const returned = await oauth(await worker.fetch(new Request(url), env), 'twitch');
    expect(returned.location.search).toBe('?mode=stream');
    expect(returned.fragment.get('auth')).toBe('linked');
  });

  it('upgrades legacy provider refresh JWTs into durable accounts without losing membership', async () => {
    const database = env.ACCOUNT_DB;
    delete env.ACCOUNT_DB;
    const legacy = await login('patreon');
    expect((await check(legacy.token)).accountId).toBeUndefined();
    env.ACCOUNT_DB = database;
    const migrated = await (await request('/auth/refresh', legacy.refresh, {})).json() as any;
    expect(migrated).toMatchObject({ authenticated: true, isSubscriber: true, provider: 'patreon' });
    expect(typeof migrated.accountId).toBe('string');
    expect((await link(migrated.token, 'twitch', 'twitch')).status).toBe(200);
  });

  it('rejects replacing an existing provider identity and does not absorb another multi-provider account', async () => {
    const first = await login('patreon');
    expect((await link(first.token, 'twitch', 'twitch')).status).toBe(200);
    expect((await link(first.token, 'twitch', 'twitch2')).status).toBe(409);
    const second = await login('patreon', 'patron2');
    expect((await link(second.token, 'twitch', 'twitch')).status).toBe(409);
    expect((await check(first.token)).linkedAccounts[1].userId).toBe('12345');
    expect((await check(second.token)).linkedAccounts).toHaveLength(1);
  });

  it('keeps a usable sign-in method and revokes old sessions after unlinking', async () => {
    const owner = await login('patreon');
    expect((await request('/auth/unlink', owner.token, { provider: 'patreon' })).status).toBe(409);
    const linked = await (await link(owner.token, 'twitch', 'twitch')).json() as any;
    const result = await request('/auth/unlink', linked.token, { provider: 'patreon' });
    const remaining = await result.json() as any;
    expect(remaining).toMatchObject({ authenticated: true, provider: 'twitch', isSubscriber: false });
    expect(remaining.linkedAccounts).toHaveLength(1);
    expect(await check(linked.token)).toEqual({ authenticated: false });
    expect(await (await request('/auth/refresh', linked.refresh_token, {})).json()).toEqual({ authenticated: false });
    expect((await request('/auth/unlink', remaining.token, { provider: 'twitch' })).status).toBe(409);
    expect((await request('/auth/game-ticket', remaining.token, {})).status).toBe(403);
  });

  it.each([
    { campaign: 'unrelated', patronStatus: 'active_patron', amount: 100 },
    { campaign: 'campaign', patronStatus: 'declined_patron', amount: 100 },
    { campaign: 'campaign', patronStatus: 'active_patron', amount: 0 },
  ])('preserves the existing campaign/status/payment gate: %o', async (membership) => {
    Object.assign(people.patron, membership);
    const patron = await login('patreon');
    expect(await check(patron.token)).toMatchObject({ isSubscriber: false });
  });

  it('fails closed when the configured Patreon campaign is missing', async () => {
    env.PATREON_CAMPAIGN_ID = secret('');
    const patron = await login('patreon');
    expect(await check(patron.token)).toMatchObject({ isSubscriber: false });
  });

  it('rechecks cached membership on renewal, removing cancelled Pro and keeping provider IDs stable', async () => {
    const patron = await login('patreon');
    const linked = await (await link(patron.token, 'twitch', 'twitch')).json() as any;
    const later = Date.now() + 25 * 3600000;
    vi.spyOn(Date, 'now').mockReturnValue(later);
    people.patron.subscriber = false;
    const renewed = await (await request('/auth/refresh', linked.refresh_token, {})).json() as any;
    expect(renewed).toMatchObject({ authenticated: true, isSubscriber: false, accountId: linked.accountId });
    expect(renewed.linkedAccounts.every((row: any) => row.membershipStatus === 'inactive')).toBe(true);
    people.patron.id = 'different-provider-owner';
    vi.spyOn(Date, 'now').mockReturnValue(later + 25 * 3600000);
    const mismatch = await (await request('/auth/refresh', renewed.refresh_token, {})).json() as any;
    expect(mismatch.linkedAccounts[0]).toMatchObject({ userId: 'patreon-1', membershipStatus: 'reconnect', isSubscriber: false });
  });
});

describe('explicit Twitch chat consent', () => {
  it.each([false, true])('requests announcement scope only when selected (%s), preserving Patreon Pro', async announcements => {
    const patron = await login('patreon');
    const linked = await (await link(patron.token, 'twitch', 'twitch')).json() as any;
    expect((await request('/auth/twitch/chat-session', linked.token)).status).toBe(409);
    const start = await beginLink(linked.token, 'twitch', true, announcements);
    const authorize = new URL(start.headers.get('Location')!);
    const scopes = ['user:read:chat', 'user:write:chat', ...(announcements ? ['moderator:manage:announcements'] : [])];
    expect(authorize.searchParams.get('scope')).toBe(scopes.join(' '));
    expect(authorize.searchParams.get('force_verify')).toBe('true');
    people.twitch.scope = scopes;
    const returned = await oauth(start, 'twitch');
    const result = await request('/auth/link/complete', linked.token, { linkToken: returned.fragment.get('link_token') });
    const connected = await result.json() as any;
    expect(connected.isSubscriber).toBe(true);
    const response = await request('/auth/twitch/chat-session', connected.token);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toContain('no-store');
    expect(await response.json()).toMatchObject({ accessToken: 'access-twitch', clientId: 'twitch-client', userId: '12345', login: 'mychannel',
      scopes });
  });

  it.each([false, true])('keeps the same optional scope choice for a direct Twitch sign-in (%s)', async announcements => {
    const start = await request(`/auth/twitch/login?chat=1&announcements=${announcements ? '1' : '0'}`);
    const scope = new URL(start.headers.get('Location')!).searchParams.get('scope');
    expect(scope).toBe('user:read:chat user:write:chat' + (announcements ? ' moderator:manage:announcements' : ''));
    const ordinary = await request('/auth/twitch/login?announcements=1');
    expect(new URL(ordinary.headers.get('Location')!).searchParams.get('scope')).toBe('');
  });

  it.each([
    { client_id: 'wrong-client' }, { user_id: 'different-owner' },
    { scopes: ['user:read:chat', 'channel:manage:broadcast'] }, { scopes: [] }, { expires_in: 0 },
  ])('refuses a token with invalid owner/client/scope/lifetime: %o', async (override) => {
    people.twitch.scope = ['user:read:chat'];
    const twitch = await login('twitch', 'twitch', true);
    validation = { client_id: 'twitch-client', user_id: '12345', login: 'mychannel', scopes: ['user:read:chat'], expires_in: 3500, ...override };
    expect((await request('/auth/twitch/chat-session', twitch.token)).status).toBe(409);
  });

  it('rotates an expired chat credential server-side and never returns its refresh token', async () => {
    people.twitch.scope = ['user:read:chat'];
    const twitch = await login('twitch', 'twitch', true);
    const later = Date.now() + 2 * 3600000;
    vi.spyOn(Date, 'now').mockReturnValue(later);
    const response = await request('/auth/twitch/chat-session', twitch.token);
    expect(response.status).toBe(200);
    const session = await response.json() as any;
    expect(session).toMatchObject({ accessToken: 'access-twitch', userId: '12345' });
    expect(session.expiresAt).toBeGreaterThan(later);
    expect(JSON.stringify(session)).not.toContain('refresh');
    expect(providerFetch.mock.calls.some(([, options]) => String(options?.body).includes('grant_type=refresh_token'))).toBe(true);
  });

  it('keeps existing chat consent when signing in normally with Twitch later', async () => {
    people.twitch.scope = ['user:read:chat'];
    await login('twitch', 'twitch', true);
    const old = db.sqlite.prepare("SELECT credentials FROM auth_identities WHERE provider = 'twitch'").get()!.credentials;
    people.twitch.scope = [];
    await login('twitch');
    expect(db.sqlite.prepare("SELECT credentials FROM auth_identities WHERE provider = 'twitch'").get()!.credentials).toBe(old);
  });
});
