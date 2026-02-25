const crypto = require('crypto');
const fs = require('fs');

const prod = crypto.randomBytes(32).toString('base64');
const dev = crypto.randomBytes(32).toString('base64');

fs.writeFileSync('tmp.txt', `JWT_SECRET_PROD: ${prod}\nJWT_SECRET_DEV: ${dev}\n`);
console.log('Secrets written to tmp.txt');
