const encoder = new TextEncoder();
export const SESSION_FORMAT = 2;
export const SESSION_KEY_ID = 'auth-v2';

export interface CredentialKeys {
  key: string;
  id: string;
  previousKey?: string;
  previousId?: string;
  /** Only for migrating stored provider data. Never used to verify a session. */
  legacyKey?: string;
}
export function encode64(value: ArrayBuffer | Uint8Array): string {
  return btoa(String.fromCharCode(...new Uint8Array(value instanceof Uint8Array ? value : new Uint8Array(value))))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function decode64(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) throw Error('Invalid encoding.');
  const raw = atob(value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '='));
  return Uint8Array.from(raw, character => character.charCodeAt(0));
}
async function derive(secret: string, purpose: string,
  algorithm: { name: 'HMAC'; hash: 'SHA-256'; length: number } | { name: 'AES-GCM'; length: number },
  usages: ('sign' | 'verify' | 'encrypt' | 'decrypt')[]) {
  if (secret.length < 32) throw Error('Authentication key is not configured.');
  const material = await crypto.subtle.importKey('raw', encoder.encode(secret), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: encoder.encode('noitamap-auth-v2'),
    info: encoder.encode(purpose) }, material, algorithm, false, usages);
}
export function authKey(secret: string, purpose: 'access' | 'refresh' | 'oauth-state') {
  return derive(secret, purpose, { name: 'HMAC', hash: 'SHA-256', length: 256 }, ['sign', 'verify']);
}
export async function secretMatches(expected: string, provided: string): Promise<boolean> {
  if (!provided || provided.length > 1024) return false;
  const key = await crypto.subtle.importKey('raw', encoder.encode(expected), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(expected));
  return crypto.subtle.verify('HMAC', key, signature, encoder.encode(provided));
}
export async function encryptCredential(value: string, keys: CredentialKeys): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await derive(keys.key, 'provider-credentials/' + keys.id, { name: 'AES-GCM', length: 256 }, ['encrypt', 'decrypt']);
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode('c2.' + keys.id) }, key, encoder.encode(value));
  return `c2.${keys.id}.${encode64(iv)}.${encode64(encrypted)}`;
}
export async function decryptCredential(value: string, keys: CredentialKeys): Promise<string | null> {
  try {
    if (value.length > 32768) return null;
    const parts = value.split('.');
    let key: CryptoKey, iv: Uint8Array, encrypted: Uint8Array, additionalData: Uint8Array | undefined;
    if (parts.length === 4 && parts[0] === 'c2') {
      const secret = parts[1] === keys.id ? keys.key : parts[1] === keys.previousId ? keys.previousKey : undefined;
      if (!secret) return null;
      key = await derive(secret, 'provider-credentials/' + parts[1], { name: 'AES-GCM', length: 256 }, ['decrypt']);
      iv = decode64(parts[2]); encrypted = decode64(parts[3]); additionalData = encoder.encode('c2.' + parts[1]);
    } else if (parts.length === 2 && keys.legacyKey) {
      const oldKey = await crypto.subtle.digest('SHA-256', encoder.encode('refresh-enc:' + keys.legacyKey));
      key = await crypto.subtle.importKey('raw', oldKey, { name: 'AES-GCM' }, false, ['decrypt']);
      iv = decode64(parts[0]); encrypted = decode64(parts[1]);
    } else return null;
    if (iv.byteLength !== 12) return null;
    return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(iv), ...(additionalData ? { additionalData: new Uint8Array(additionalData) } : {}) }, key, new Uint8Array(encrypted)));
  } catch { return null; }
}
