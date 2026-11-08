#!/usr/bin/env node
// Check installation only. Browser/WebGL execution belongs to the measured run.
import { chromium, firefox } from 'playwright';
import { access, constants } from 'node:fs/promises';

for (const [name, browser] of [['chromium', chromium], ['firefox', firefox]]) {
  const binary = browser.executablePath();
  try { await access(binary, constants.X_OK); }
  catch { throw Error(`${name} is missing from the selected Playwright image: ${binary}`); }
  console.log(`[Performance setup] ${name}: installed`);
}
