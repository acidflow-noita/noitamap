// Pipe directly to a secret-setting tool. This script never writes a file.
const crypto = require('node:crypto');
process.stdout.write(crypto.randomBytes(32).toString('base64') + '\n');
