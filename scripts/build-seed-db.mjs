// Build public/seed/tokyo23.duckdb.gz: the database the page copies into OPFS on first load.
//
//   node scripts/build-seed-db.mjs
//
// Runs the app itself in headless Chromium with ?seed=ndjson, so the entities go in
// through POST /ngsi-ld/v1/entityOperations/create and the file is written by the same
// DuckDB-Wasm build that will read it. Needs public/seed/tokyo23-entities.ndjson
// (scripts/build-entities.mjs).
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const PORT = 5188;
const OUT = 'public/seed/tokyo23.duckdb.gz';
if (!existsSync('public/seed/tokyo23-entities.ndjson')) throw new Error('run scripts/build-entities.mjs first');
// A stale seed would be copied instead of importing the NDJSON; the page must not see it.
rmSync(OUT, { force: true });

// detached: its own process group, so killing it also stops the vite child of npx.
const server = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { stdio: ['ignore', 'pipe', 'inherit'], detached: true });
await new Promise((resolve, reject) => {
  server.stdout.on('data', (d) => String(d).includes('Local:') && resolve());
  server.on('exit', (code) => reject(new Error(`vite exited with ${code}`)));
});

const profile = mkdtempSync(join(tmpdir(), 'ngsi-ld-seed-'));
try {
  const ctx = await chromium.launchPersistentContext(profile);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error('pageerror:', e.message));
  const started = Date.now();
  await page.goto(`http://localhost:${PORT}/?seed=ndjson`);
  let last = '';
  for (;;) {
    const s = await page.evaluate(() => ({ state: document.body.dataset.state, phase: document.getElementById('phase').textContent }));
    if (s.phase !== last) console.log(`${((Date.now() - started) / 1000).toFixed(0)}s ${(last = s.phase)}`);
    if (s.state === 'error') throw new Error(s.phase);
    if (s.state === 'ready') break;
    await page.waitForTimeout(1000);
  }
  // The page's "Download .duckdb" button hands the OPFS file over as a download.
  const download = page.waitForEvent('download');
  await page.locator('#advanced summary').click();
  await page.locator('#export-db').click();
  const raw = readFileSync(await (await download).path());
  writeFileSync(OUT, gzipSync(raw, { level: 9 }));
  console.log(`${OUT}: ${(raw.length / 1e6).toFixed(1)} MB raw, ${(statSync(OUT).size / 1e6).toFixed(1)} MB gzipped`);
  await ctx.close();
} finally {
  rmSync(profile, { recursive: true, force: true });
  process.kill(-server.pid);
}
