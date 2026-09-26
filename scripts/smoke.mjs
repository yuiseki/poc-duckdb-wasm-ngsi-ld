// Smoke-test a deployed copy: node scripts/smoke.mjs <url> [screenshot.jpg]
// Loads the page in a fresh Chromium, waits for the seed, clicks Tokyo Station for a
// 1 km near query, and POSTs an entity from the Advanced panel.
import { chromium } from '@playwright/test';

const url = process.argv[2];
if (!url) throw new Error('usage: node scripts/smoke.mjs <url> [screenshot.jpg]');
// A real GPU if there is one: with software GL, map repaints inflate the query timings.
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=gl-egl', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 860 } });
const failed = [];
page.on('response', (r) => r.status() >= 400 && failed.push(`${r.status()} ${r.url()}`));
page.on('pageerror', (e) => failed.push(`pageerror ${e.message}`));

const started = Date.now();
await page.goto(url);
await page.waitForFunction(() => document.body.dataset.state !== 'loading', null, { timeout: 180_000 });
console.log(`${((Date.now() - started) / 1000).toFixed(1)} s: ${await page.textContent('#phase')}`);
console.log(`stats: ${(await page.textContent('#stats')).replace(/\s+/g, ' ').trim()}`);

const pt = await page.evaluate(async () => (await window.entityMap).map.project([139.7671, 35.6812]));
await page.mouse.click(pt.x, pt.y);
await page.waitForFunction(() => document.getElementById('index-badge').textContent !== '', null, { timeout: 30_000 });
console.log(`near 1 km at Tokyo Station: ${await page.textContent('#m-count')} matches, ${await page.textContent('#stat-last-query')}, plan ${await page.textContent('#index-badge')}`);

await page.locator('#advanced summary').click();
await page.getByRole('button', { name: 'POST an entity' }).click();
await page.locator('#send').click();
await page.waitForFunction(() => document.getElementById('response').dataset.status);
console.log(`POST from the Advanced panel: ${await page.getAttribute('#response', 'data-status')}`);

if (process.argv[3]) await page.screenshot({ path: process.argv[3], type: 'jpeg', quality: 82 });
console.log('4xx/5xx and page errors:', failed.length ? failed : 'none');
await browser.close();
