type Fetcher = typeof fetch;
const helix = 'https://api.twitch.tv/helix/chat/color';
const tokens = new Map<string, { value: string; until: number }>();
const colors = new Map<string, { value?: string; until: number }>();

/** Chat color is public Helix data. An expired player login must not prevent a lookup. */
export async function verifiedChatColor(
  userId: string,
  clientId: string,
  userToken: string | undefined,
  clientSecret: () => Promise<string | null | undefined>,
  fetcher: Fetcher = fetch,
  now = Date.now()
): Promise<string | undefined> {
  if (!/^\d{1,30}$/.test(userId) || !clientId) return;
  const key = clientId + '/' + userId;
  const cached = colors.get(key);
  if (cached && cached.until > now) return cached.value;
  const lookup = async (token: string) => {
    const response = await fetcher(helix + '?user_id=' + userId, {
      headers: { Authorization: 'Bearer ' + token, 'Client-Id': clientId },
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return { status: response.status };
    }
    const data = (await response.json()) as { data?: { user_id: string; color: string }[] };
    const color = data.data?.find(row => row.user_id === userId)?.color;
    if (typeof color !== 'string' || (color && !/^#[\da-f]{6}$/i.test(color))) return { status: 502 };
    return { status: 200, value: color.toUpperCase() || undefined };
  };
  try {
    let result = userToken ? await lookup(userToken) : undefined;
    if (!result || result.status === 401 || result.status === 403) {
      let app = tokens.get(clientId);
      if (!app || app.until <= now) {
        const secret = await clientSecret();
        if (!secret) return cached?.value;
        const issued = await fetcher('https://id.twitch.tv/oauth2/token', {
          method: 'POST',
          body: new URLSearchParams({ client_id: clientId, client_secret: secret, grant_type: 'client_credentials' }),
          signal: AbortSignal.timeout(3000),
        });
        if (!issued.ok) {
          await issued.body?.cancel();
          return cached?.value;
        }
        const data = (await issued.json()) as { access_token?: string; expires_in?: number };
        if (!data.access_token || !Number.isFinite(data.expires_in) || data.expires_in! <= 0) return cached?.value;
        app = { value: data.access_token, until: now + Math.max(0, data.expires_in! - 60) * 1000 };
        tokens.set(clientId, app);
      }
      result = await lookup(app.value);
      if (result.status === 401) tokens.delete(clientId);
    }
    if (result.status !== 200) return cached?.value;
    if (colors.size >= 4096 && !cached) colors.delete(colors.keys().next().value!);
    colors.set(key, { value: result.value, until: now + 15 * 60_000 });
    return result.value;
  } catch {
    return cached?.value;
  }
}
