export const ANNOUNCEMENT_SCOPE = 'moderator:manage:announcements';

export class TwitchAnnouncementError extends Error {
  constructor(readonly permissionRequired: boolean, message: string) { super(message); }
}

/** Uses the streamer's existing browser credential, never a Worker relay. */
export async function postTwitchAnnouncement(credentials: {
  accessToken: string; clientId: string; userId: string; scopes?: string[]; expiresAt: number;
} | undefined, hostId: string, message: string, request: typeof fetch = fetch): Promise<void> {
  if (!credentials || credentials.expiresAt <= Date.now() + 5000 || !credentials.scopes?.includes(ANNOUNCEMENT_SCOPE))
    throw new TwitchAnnouncementError(true, 'Allow Twitch announcements to share your game link.');
  if (credentials.userId !== hostId || !/^\d{1,30}$/.test(hostId))
    throw new TwitchAnnouncementError(false, 'Sign in as the streamer to share this game.');
  if (!message.trim() || [...message].length > 500)
    throw new TwitchAnnouncementError(false, 'The game announcement is too long.');
  let response: Response;
  try {
    response = await request(`https://api.twitch.tv/helix/chat/announcements?broadcaster_id=${hostId}&moderator_id=${hostId}`, {
      method: 'POST', credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
      signal: AbortSignal.timeout(10000),
      headers: { Authorization: `Bearer ${credentials.accessToken}`, 'Client-Id': credentials.clientId, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, color: 'primary' }),
    });
  } catch {
    // The request may have reached Twitch. Never automatically retry a post.
    throw new TwitchAnnouncementError(false, 'Could not confirm the post. Check your Twitch chat before trying again.');
  }
  if (response.status === 401 || response.status === 403)
    throw new TwitchAnnouncementError(true, 'Allow Twitch announcements to share your game link.');
  if (response.status === 429)
    throw new TwitchAnnouncementError(false, 'Twitch is limiting announcements. Wait before trying again.');
  if (response.status !== 204)
    throw new TwitchAnnouncementError(false, 'Twitch could not post the game link.');
}
