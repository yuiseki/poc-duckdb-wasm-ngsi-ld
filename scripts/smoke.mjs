// Smoke-test a deployed copy: node scripts/smoke.mjs <url> [screenshot.png]
// Loads the page in a fresh Chromium, POSTs the three preset stations and runs the near query.
import { chromium } from '@playwright/test';
const url = process.argv[2];
if (!url) throw new Error('usage: node scripts/smoke.mjs <url> [screenshot.png]');
const b = await chromium.launch(); const p = await b.newPage();
const failed = []; p.on('response', r => { if (r.status() >= 400) failed.push(r.status() + ' ' + r.url()); });
await p.goto(url);
await p.waitForFunction(() => document.getElementById('status').dataset.state !== 'loading', null, { timeout: 90000 });
console.log('status:', await p.textContent('#status'));
for (const name of ['POST Tokyo Station', 'POST Shinjuku Station', 'POST Osaka Station', 'GET near Tokyo 10km']) {
  await p.getByRole('button', { name }).click(); await p.locator('#send').click();
  await p.waitForFunction(() => document.getElementById('response').dataset.status, null, { timeout: 30000 });
  const t = await p.textContent('#response'); console.log(name, '->', t.split('\n')[0], (t.match(/"id": "[^"]+"/g) || []).join(' '));
  await p.evaluate(() => delete document.getElementById('response').dataset.status);
}
if (process.argv[3]) await p.screenshot({ path: process.argv[3], fullPage: true });
console.log('4xx/5xx:', failed.length ? failed : 'none');
await b.close();
