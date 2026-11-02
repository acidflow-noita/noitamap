export const ANNOUNCEMENT_SCOPE = 'moderator:manage:announcements';
export const MESSAGE_SCOPE = 'user:write:chat';

interface SharingCredentials {
  accessToken: string; clientId: string; userId: string; scopes?: string[]; expiresAt: number;
}
export function canShareGameLink(credentials: Pick<SharingCredentials, 'scopes' | 'expiresAt'> | undefined, announcements: boolean): boolean {
  return !!credentials && credentials.expiresAt > Date.now() + 5000
    && !!credentials.scopes?.includes(announcements ? ANNOUNCEMENT_SCOPE : MESSAGE_SCOPE);
}

export class TwitchAnnouncementError extends Error {
  constructor(readonly permissionRequired: boolean, message: string) { super(message); }
}

/** Uses the streamer's existing browser credential, never a Worker relay. */
export async function postTwitchGameLink(credentials: SharingCredentials | undefined,
  hostId: string, message: string, announcements: boolean, request: typeof fetch = fetch): Promise<void> {
  if (!credentials || !canShareGameLink(credentials, announcements))
    throw new TwitchAnnouncementError(true, 'Sharing permission is unavailable. You can copy the game link.');
  if (credentials.userId !== hostId || !/^\d{1,30}$/.test(hostId))
    throw new TwitchAnnouncementError(false, 'Sign in as the streamer to share this game.');
  if (!message.trim() || [...message].length > 500)
    throw new TwitchAnnouncementError(false, 'The game announcement is too long.');
  let response: Response;
  try {
    response = await request(announcements
      ? `https://api.twitch.tv/helix/chat/announcements?broadcaster_id=${hostId}&moderator_id=${hostId}`
      : 'https://api.twitch.tv/helix/chat/messages', {
      method: 'POST', credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
      signal: AbortSignal.timeout(10000),
      headers: { Authorization: `Bearer ${credentials.accessToken}`, 'Client-Id': credentials.clientId, 'Content-Type': 'application/json' },
      body: JSON.stringify(announcements ? { message, color: 'primary' } : { broadcaster_id: hostId, sender_id: hostId, message }),
    });
  } catch {
    // The request may have reached Twitch. Never automatically retry a post.
    throw new TwitchAnnouncementError(false, 'Could not confirm the post. Check your Twitch chat before trying again.');
  }
  if (response.status === 401 || response.status === 403)
    throw new TwitchAnnouncementError(true, 'Sharing permission is unavailable. You can copy the game link.');
  if (response.status === 429)
    throw new TwitchAnnouncementError(false, 'Twitch is limiting messages. Wait before sending again.');
  if (response.status !== (announcements ? 204 : 200))
    throw new TwitchAnnouncementError(false, 'Twitch could not post the game link.');
  if (!announcements) {
    const data = await response.json().catch(() => null) as { data?: { is_sent?: boolean; message_id?: string }[] } | null;
    const sent = data?.data?.length === 1 ? data.data[0] : null;
    if (sent?.is_sent !== true || typeof sent.message_id !== 'string' || !sent.message_id)
      throw new TwitchAnnouncementError(false, 'Twitch did not confirm delivery. Check chat before sending again.');
  }
}
