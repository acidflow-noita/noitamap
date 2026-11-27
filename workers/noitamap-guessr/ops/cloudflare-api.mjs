const api = 'https://api.cloudflare.com/client/v4';

export async function cf(endpoint, token, args = {}) {
  const response = await fetch(api + endpoint, {
    ...args,
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw Error('Cloudflare returned HTTP ' + response.status + ' for ' + endpoint.split('?')[0]);
  const result = await response.json();
  if (result.success === false || result.errors?.length)
    throw Error('Cloudflare rejected ' + endpoint.split('?')[0] + ' (check the token scopes and query).');
  return result;
}

export async function sql(config, text, params = []) {
  const response = await cf('/accounts/' + config.account + '/d1/database/' + config.db + '/query', config.control, {
    method: 'POST',
    body: JSON.stringify({ sql: text, params }),
  });
  const reply = response.result?.[0];
  if (!reply?.success) throw Error('Capacity database did not confirm the operation.');
  return reply.results;
}
