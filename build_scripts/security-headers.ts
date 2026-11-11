import { createHash } from 'node:crypto';

/** Hash exact emitted inline scripts. No per-request nonce or reporting Worker.
 * Google Analytics is the owner's explicit third-party script trust exception. */
export function contentSecurityPolicy(html: string[]): string {
  const hashes = new Set<string>();
  for (const document of html) for (const match of document.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const source = /\bsrc\s*=\s*(["'])(.*?)\1/i.exec(match[1]);
    if (source) {
      if (/^(?:https?:)?\/\//i.test(source[2]) && !source[2].startsWith('https://www.googletagmanager.com/gtag/js?'))
        throw Error('Untrusted external script in emitted HTML. Bundle or self-host it before release.');
    } else if (match[2].trim()) hashes.add("'sha256-" + createHash('sha256').update(match[2]).digest('base64') + "'");
  }
  const policy = [
    "default-src 'self'",
    "script-src 'self' blob: 'wasm-unsafe-eval' https://www.googletagmanager.com/gtag/js " + [...hashes].sort().join(' '),
    "script-src-attr 'none'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "connect-src 'self' data: blob: https://*.acidflow.stream https://*.sage-data.xyz https://*.runfast.stream https://*.noitamap.com https://*.pages.dev https://noitamap-auth.wuote.workers.dev https://noitamap-image-upload-proxy.wuote.workers.dev https://files.catbox.moe https://qu.ax https://id.twitch.tv https://api.twitch.tv wss://eventsub.wss.twitch.tv https://www.googletagmanager.com https://*.google-analytics.com https://*.google.com",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "frame-src 'none'",
    "form-action 'self'",
  ].join('; ');
  if (policy.length > 1900) throw Error('The generated CSP exceeds the Pages header-line budget.');
  return policy;
}
