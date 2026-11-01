import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { accountDatabase } from './helpers/auth-account-db';

let worker: { fetch(request: Request, env: unknown): Promise<Response> };
const secret = (value: string) => ({ get: async () => value });
const env = {
  JWT_SECRET: secret('local-only-patreon-gift-test-signing-key'),
  PATREON_CLIENT_ID: secret('test-patreon-client'),
  PATREON_CLIENT_SECRET: secret('test-patreon-secret'),
  PATREON_CAMPAIGN_ID: secret('configured-campaign'),
  CREATOR_USER_ID: secret('campaign-owner'),
  WORKER_URL: 'https://auth.test',
  ALLOWED_ORIGINS: 'https://noitamap.test',
};

beforeAll(async () => {
  const result = await build({ entryPoints: ['workers/noitamap-auth/src/index.ts'], bundle: true, write: false,
    format: 'iife', globalName: 'AuthTest', platform: 'neutral', target: 'es2022' });
  worker = new Function(result.outputFiles[0].text + '\nreturn AuthTest.default;')();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

type Included = {
  type: string;
  id: string;
  attributes: Record<string, unknown>;
  relationships?: {
    campaign?: { data: { id: string; type: string } };
    currently_entitled_tiers?: { data: { id: string; type: string }[] };
  };
};
function giftIdentity() {
  return {
    data: { id: 'gift-recipient', type: 'user', attributes: { vanity: 'Recipient' },
      relationships: { memberships: { data: [{ type: 'member', id: 'membership' }] } } },
    included: [
      { type: 'member', id: 'membership', attributes: {
        patron_status: 'active_patron', currently_entitled_amount_cents: 0,
        campaign_lifetime_support_cents: 0, is_gifted: true,
      }, relationships: {
        campaign: { data: { type: 'campaign', id: 'configured-campaign' } },
        currently_entitled_tiers: { data: [{ type: 'tier', id: 'paid-tier' }] },
      } },
      { type: 'tier', id: 'paid-tier', attributes: { amount_cents: 500 } },
    ] as Included[],
  };
}

function provider(identity: ReturnType<typeof giftIdentity>) {
  const calls = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.href === 'https://www.patreon.com/api/oauth2/token') {
      return Response.json({ access_token: 'provider-access', refresh_token: 'provider-refresh',
        expires_in: 3600, scope: 'identity identity.memberships' });
    }
    if (url.origin === 'https://www.patreon.com' && url.pathname === '/api/oauth2/v2/identity') {
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer provider-access');
      expect(url.searchParams.get('include')?.split(',')).toContain('memberships.currently_entitled_tiers');
      expect(url.searchParams.get('fields[member]')?.split(',')).toContain('is_gifted');
      expect(url.searchParams.get('fields[tier]')).toBe('amount_cents');
      // Membership evaluation needs no names, contact details, or payment history.
      expect(url.searchParams.get('fields[user]')).toBe('vanity,image_url');
      expect(url.searchParams.get('fields[member]')).not.toMatch(/lifetime|last_charge|email|full_name/);
      return Response.json(identity);
    }
    throw new Error(`Unexpected provider request: ${url.href}`);
  });
  vi.stubGlobal('fetch', calls);
  return calls;
}

async function login(bindings: unknown = env) {
  const start = await worker.fetch(new Request('https://auth.test/auth/login?redirect=https://noitamap.test/guess/'), bindings);
  expect(start.status).toBe(302);
  const state = new URL(start.headers.get('Location')!).searchParams.get('state')!;
  const callback = new URL('https://auth.test/auth/callback');
  callback.searchParams.set('state', state);
  callback.searchParams.set('code', 'provider-code');
  const result = await worker.fetch(new Request(callback, {
    headers: { Cookie: start.headers.get('Set-Cookie')!.split(';')[0] },
  }), bindings);
  expect(result.status).toBe(302);
  const fragment = new URLSearchParams(new URL(result.headers.get('Location')!).hash.slice(1));
  expect(fragment.get('auth')).toBe('success');
  return { token: fragment.get('token')!, refresh: fragment.get('refresh_token')! };
}
async function check(token: string, bindings: unknown = env) {
  const response = await worker.fetch(new Request('https://auth.test/auth/check', {
    headers: { Origin: 'https://noitamap.test', Authorization: `Bearer ${token}` },
  }), bindings);
  expect(response.status).toBe(200);
  return response.json();
}
async function refresh(token: string, bindings: unknown = env) {
  const response = await worker.fetch(new Request('https://auth.test/auth/refresh', {
    method: 'POST', headers: { Origin: 'https://noitamap.test', Authorization: `Bearer ${token}` },
  }), bindings);
  expect(response.status).toBe(200);
  return response.json();
}

describe('Patreon gift Pro entitlement', () => {
  it.each(['active_patron', null])('recognizes a current paid-tier gift with status %s and no recipient payments', async status => {
    const identity = giftIdentity();
    identity.included[0].attributes.patron_status = status;
    const calls = provider(identity);
    const session = await login();
    expect(await check(session.token)).toMatchObject({ authenticated: true, provider: 'patreon', isSubscriber: true });
    // The expanded identity response replaces the existing request, adding none.
    expect(calls).toHaveBeenCalledTimes(2);
    expect(await refresh(session.refresh)).toMatchObject({ authenticated: true, isSubscriber: true });
    expect(calls).toHaveBeenCalledTimes(4);
  });

  const rejected: [string, (identity: ReturnType<typeof giftIdentity>) => void][] = [
    ['expired gift with no current tiers', identity => {
      identity.included[0].relationships!.currently_entitled_tiers!.data = [];
      identity.included[0].attributes.campaign_lifetime_support_cents = 10000;
    }],
    ['missing current-tier relationship', identity => { delete identity.included[0].relationships!.currently_entitled_tiers; }],
    ['unresolved tier', identity => { identity.included[1].id = 'unrelated-paid-tier'; }],
    ['free-tier-only entitlement', identity => {
      identity.included[1].attributes.amount_cents = 0;
      identity.included.push({ type: 'tier', id: 'unrelated-paid-tier', attributes: { amount_cents: 10000 } });
    }],
    ['missing gift marker and zero payment', identity => { delete identity.included[0].attributes.is_gifted; }],
    ['false gift marker and zero payment', identity => { identity.included[0].attributes.is_gifted = false; }],
    ['former patron despite retained gift marker', identity => { identity.included[0].attributes.patron_status = 'former_patron'; }],
    ['declined patron despite retained gift marker', identity => { identity.included[0].attributes.patron_status = 'declined_patron'; }],
    ['missing patron status', identity => { delete identity.included[0].attributes.patron_status; }],
    ['unknown patron status', identity => { identity.included[0].attributes.patron_status = 'pending'; }],
    ['tier without a price', identity => { delete identity.included[1].attributes.amount_cents; }],
    ['malformed tier price', identity => { identity.included[1].attributes.amount_cents = '500'; }],
    ['negative tier price', identity => { identity.included[1].attributes.amount_cents = -500; }],
    ['unrelated included resource', identity => { identity.included[1].type = 'campaign'; }],
    ['gift to another campaign', identity => { identity.included[0].relationships!.campaign!.data.id = 'other-campaign'; }],
  ];
  it.each(rejected)('rejects %s on login and refresh', async (_description, change) => {
    const identity = giftIdentity();
    change(identity);
    provider(identity);
    const session = await login();
    expect(await check(session.token)).toMatchObject({ authenticated: true, isSubscriber: false });
    expect(await refresh(session.refresh)).toMatchObject({ authenticated: true, isSubscriber: false });
  });

  it('revokes the gifted entitlement when its current tier disappears on refresh', async () => {
    const identity = giftIdentity();
    provider(identity);
    const session = await login();
    expect(await check(session.token)).toMatchObject({ isSubscriber: true });
    identity.included[0].relationships!.currently_entitled_tiers!.data = [];
    expect(await refresh(session.refresh)).toMatchObject({ authenticated: true, isSubscriber: false });
  });

  it('retains regular active paid membership without gift or tier fields', async () => {
    const identity = giftIdentity();
    identity.included = [{ type: 'member', id: 'paid-member', attributes: {
      patron_status: 'active_patron', currently_entitled_amount_cents: 100,
    }, relationships: { campaign: { data: { type: 'campaign', id: 'configured-campaign' } } } }];
    provider(identity);
    const session = await login();
    expect(await check(session.token)).toMatchObject({ isSubscriber: true });
    expect(await refresh(session.refresh)).toMatchObject({ isSubscriber: true });
  });

  it('retains the campaign-owner grant without membership data', async () => {
    const identity = giftIdentity();
    identity.data.id = 'campaign-owner';
    identity.included = [];
    provider(identity);
    expect(await check((await login()).token)).toMatchObject({ isSubscriber: true });
  });

  it('stores and refreshes gifted membership through the shared account path', async () => {
    const db = accountDatabase();
    try {
      const bindings = { ...env, ACCOUNT_DB: db.binding };
      const identity = giftIdentity();
      provider(identity);
      const session = await login(bindings);
      expect(await check(session.token, bindings)).toMatchObject({
        accountId: expect.any(String), isSubscriber: true,
        linkedAccounts: [{ provider: 'patreon', membershipStatus: 'active', isSubscriber: true }],
      });
      identity.included[0].relationships!.currently_entitled_tiers!.data = [];
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 25 * 3600000);
      expect(await refresh(session.refresh, bindings)).toMatchObject({ authenticated: true, isSubscriber: false });
    } finally {
      db.sqlite.close();
    }
  });
});
