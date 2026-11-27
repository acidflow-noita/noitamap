/** Run on an existing machine outside the game Worker, using Node 22.18+.
 * Default is a read-only report. --apply writes the D1 snapshot, public JSON and selected edge rule. */
import { writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { DAY_MS, MINUTE, MAX_AGE, utcStart, WORKER_FREE_REQUESTS, disposition } from '../src/capacity-policy.ts';

import { cf, sql } from './cloudflare-api.mjs';
const iso = t => new Date(t).toISOString();
const heartbeat = MINUTE;
const identifier = /^[a-f0-9]{32}$/;
export function usageQuery(account, script, now) {
  if (!identifier.test(account) || !/^[-a-z0-9_]+$/.test(script)) throw Error('Invalid account ID or Worker name.');
  const day = utcStart(now),
    through = Math.max(day, Math.floor(now / MINUTE) * MINUTE - 2 * MINUTE);
  const range = (from, until) =>
    'datetime_geq:' + JSON.stringify(iso(from)) + ',datetime_lt:' + JSON.stringify(iso(until));
  const sum = (label, from, until) =>
    label + ':workersInvocationsAdaptive(limit:1,filter:{' + range(from, until) + '}){sum{requests}}';
  const latest = sum('lastHour', through - 60 * MINUTE, through);
  const peak =
    'peak:workersInvocationsAdaptive(limit:1,filter:{' +
    range(through - 60 * MINUTE, through) +
    '},orderBy:[sum_requests_DESC]){dimensions{datetimeMinute} sum{requests}}';
  const fields = [peak, latest, sum('remainderYesterday', through - DAY_MS, day)];
  if (through > day) fields.push(sum('today', day, through));
  return {
    day,
    through,
    query: '{viewer{accounts(filter:{accountTag:' + JSON.stringify(account) + '}){' + fields.join(' ') + '}}}',
  };
}
export async function observe(account, script, token, now = Date.now()) {
  const { day, through, query } = usageQuery(account, script, now);
  const response = await cf('/graphql', token, { method: 'POST', body: JSON.stringify({ query }) });
  const accounts = response.data?.viewer?.accounts;
  if (!Array.isArray(accounts) || accounts.length !== 1) throw Error('No authorized account usage measurement.');
  const n = key => {
    const rows = accounts[0][key];
    if (!Array.isArray(rows) || rows.length > 1) throw Error('Incomplete usage measurement.');
    const value = rows.length ? rows[0]?.sum?.requests : 0;
    if (!Number.isSafeInteger(value) || value < 0) throw Error('Invalid usage measurement.');
    return value;
  };
  return {
    day_start: day,
    measured_through: through,
    checked_at: now,
    used_requests: through === day ? 0 : n('today'),
    background_requests: Math.max(
      n('remainderYesterday'),
      Math.ceil((n('lastHour') * (day + DAY_MS - now)) / (60 * MINUTE))
    ),
    peak_per_minute: n('peak'),
  };
}
export const startPaths = ['/api/streams/sessions', '/api/games/sessions', '/api/attempts/new'];
export function edgeExpression(host) {
  if (!/^[a-z0-9.-]+$/.test(host)) throw Error('Invalid game API hostname.');
  return (
    '(http.host eq ' +
    JSON.stringify(host) +
    ' and http.request.method in {"POST" "OPTIONS"} and http.request.uri.path in {' +
    startPaths.map(x => JSON.stringify(x)).join(' ') +
    '})'
  );
}
async function closeEdge(config, closed) {
  const base = '/zones/' + config.zone + '/rulesets/' + config.ruleset;
  const current = (await cf(base, config.edgeToken)).result?.rules?.find(rule => rule.id === config.rule);
  const expression = edgeExpression(config.host);
  if (current?.ref !== 'guessr_pause_game_starts' || current.action !== 'block' || current.expression !== expression)
    throw Error('The configured rule must match only new game starts on the Guessr API.');
  if ((current.enabled !== false) === closed) return;
  const update = {
    action: current.action,
    expression,
    ref: current.ref,
    description: current.description,
    enabled: closed,
  };
  for (const field of ['action_parameters', 'logging', 'ratelimit'])
    if (current[field]) update[field] = current[field];
  await cf(base + '/rules/' + config.rule, config.edgeToken, { method: 'PATCH', body: JSON.stringify(update) });
}
async function publishFile(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = path + '.' + crypto.randomUUID() + '.tmp';
  await writeFile(tmp, JSON.stringify(value) + '\n', { encoding: 'utf8', mode: 0o644 });
  await rename(tmp, path);
}
export async function refresh(config, apply, now = Date.now()) {
  let status;
  try {
    const s = await observe(config.account, config.script, config.analytics, now);
    if (!apply) {
      console.log(
        JSON.stringify({
          measuredThrough: iso(s.measured_through),
          accountRequests: s.used_requests,
          freeDailyLimit: WORKER_FREE_REQUESTS,
          projectedBackgroundRequests: s.background_requests,
          peakPerMinute: s.peak_per_minute,
        })
      );
      return;
    }
    await sql(
      config,
      `UPDATE guessr_capacity SET day_start=?,measured_through=?,checked_at=?,used_requests=CASE WHEN day_start=? THEN max(used_requests,?) ELSE ? END,
      background_requests=?,peak_per_minute=? WHERE id=1 AND checked_at<=? AND measured_through<=?`,
      [
        s.day_start,
        s.measured_through,
        s.checked_at,
        s.day_start,
        s.used_requests,
        s.used_requests,
        s.background_requests,
        s.peak_per_minute,
        now,
        s.measured_through,
      ]
    );
    const [current] = await sql(config, 'SELECT * FROM guessr_capacity WHERE id=1');
    status = disposition(current, Date.now());
    if (status.state === 'paused' && current.paused_until < status.retryAt)
      await sql(config, 'UPDATE guessr_capacity SET paused_until=? WHERE id=1 AND day_start=?', [
        status.retryAt,
        s.day_start,
      ]);
  } catch (error) {
    if (!apply) throw error;
    status = { state: 'checking', retryAt: Date.now() + heartbeat };
    console.error('Capacity update unavailable:', error.message);
  }
  const t = Date.now();
  const publicStatus = { ...status, validUntil: status.state === 'paused' ? status.retryAt : t + MAX_AGE };
  // A client observes closure before a start can be refused at the edge; on reopening, open the gate first.
  if (status.state === 'open') {
    await closeEdge(config, false);
    await publishFile(config.path, publicStatus);
  } else {
    try {
      await publishFile(config.path, publicStatus);
    } finally {
      await closeEdge(config, true);
    }
  }
  console.log(JSON.stringify({ state: status.state, checkAt: iso(status.retryAt) }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const apply = process.argv.includes('--apply'),
    watch = process.argv.includes('--watch');
  const config = {
    account: process.env.CLOUDFLARE_ACCOUNT_ID,
    db: process.env.GUESSR_DATABASE_ID,
    script: 'noitamap-guessr',
    analytics: process.env.GUESSR_ANALYTICS_TOKEN,
    control: process.env.GUESSR_CAPACITY_DB_TOKEN,
    path: process.env.GUESSR_PUBLIC_STATUS_FILE,
    host: process.env.GUESSR_API_HOST || 'guessr-api.sage-data.xyz',
    zone: process.env.GUESSR_ZONE_ID,
    ruleset: process.env.GUESSR_RULESET_ID,
    rule: process.env.GUESSR_START_RULE_ID,
    edgeToken: process.env.GUESSR_EDGE_TOKEN,
  };
  if (!identifier.test(config.account || '') || !config.analytics)
    throw Error('Set CLOUDFLARE_ACCOUNT_ID and GUESSR_ANALYTICS_TOKEN (Account Analytics Read).');
  if (
    apply &&
    (!config.db ||
      !config.control ||
      !config.path ||
      !config.edgeToken ||
      ![config.zone, config.ruleset, config.rule].every(v => identifier.test(v || '')))
  )
    throw Error(
      'Live protection requires the Guessr D1 binding, a published static status path, and the designated start-only Cloudflare edge rule.'
    );
  do {
    try {
      await refresh(config, apply);
    } catch (error) {
      console.error(error.message);
      if (!watch) {
        process.exitCode = 1;
        break;
      }
    }
    if (watch) await delay(heartbeat);
  } while (watch);
}
