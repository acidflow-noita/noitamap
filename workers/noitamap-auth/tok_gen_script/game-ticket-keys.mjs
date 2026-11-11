// Run with an explicit private directory, outside any publication/build output.
// Key contents are never printed. Upload the private JWK only to primary auth;
// upload the public JWK to the secondary Guessr Worker's verification binding.
import { generateKeyPairSync } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
if (process.argv.length !== 3) throw Error('Usage: node game-ticket-keys.mjs /private/directory');
const directory = resolve(process.argv[2]);
await mkdir(directory, { recursive: true, mode: 0o700 });
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
await writeFile(join(directory, 'game-ticket.private.jwk'), JSON.stringify(privateKey.export({ format: 'jwk' })) + '\n', { mode: 0o600, flag: 'wx' });
await writeFile(join(directory, 'game-ticket.public.jwk'), JSON.stringify(publicKey.export({ format: 'jwk' })) + '\n', { mode: 0o600, flag: 'wx' });
console.log('Created game-ticket.private.jwk and game-ticket.public.jwk in the requested directory.');
