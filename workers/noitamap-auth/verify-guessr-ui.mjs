// Public, read-only deployment checks. No account credentials are needed.
const origin = 'https://dynamic-map.noitamap.com';
const worker = 'https://noitamap-auth.wuote.workers.dev';
const read = path => fetch(new URL(path, worker), {
  headers: { Origin: origin }, redirect: 'manual', signal: AbortSignal.timeout(15000),
});
const report = {};
try {
  for (const [name, path] of [['playerTicket', '/auth/player-ticket'], ['membershipRefresh', '/auth/membership/refresh']]) {
    report[name] = (await read(path)).status;
  }
  const login = new URL('/auth/twitch/login', worker);
  login.searchParams.set('redirect', origin + '/guess/?auth_nonce=' + 'a'.repeat(64));
  const response = await read(login.href);
  const target = new URL(response.headers.get('location') || worker);
  report.twitchLogin = response.status;
  report.identityOnly = target.hostname === 'id.twitch.tv' && !target.searchParams.get('scope');
  report.ready = report.playerTicket === 405 && report.membershipRefresh === 405 && report.twitchLogin === 302 && report.identityOnly;
} catch {
  report.ready = false; report.error = 'Deployment check could not reach the auth Worker.';
}
console.log(JSON.stringify(report, null, 2));
if (!report.ready) process.exitCode = 1;
