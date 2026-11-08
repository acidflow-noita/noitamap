#!/usr/bin/env node
// Check installation only. Browser/WebGL execution belongs to the measured run.
import { chromium, firefox } from 'playwright';
import { access, constants, stat } from 'node:fs/promises';

if (process.platform === 'linux' && process.env.HOME) {
  const owner = (await stat(process.env.HOME)).uid;
  if (owner !== process.getuid()) throw Error('Browser user does not own its home directory; check the container user setting.');
}

for (const [name, browser] of [['chromium', chromium], ['firefox', firefox]]) {
  const binary = browser.executablePath();
  try { await access(binary, constants.X_OK); }
  catch { throw Error(`${name} is missing from the selected Playwright image: ${binary}`); }
  console.log(`[Performance setup] ${name}: installed`);
}
