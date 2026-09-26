// The demo scenario end to end: first load imports the seed, GeoQueries are issued
// from the map, and the same database and queries come back after a reload and
// after the browser is closed and relaunched.
import { chromium, expect, test, type Page } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TOKYO_STATION: [number, number] = [139.7671, 35.6812];
// A triangle around the Imperial Palace, well inside central Tokyo.
const TRIANGLE: [number, number][] = [
  [139.745, 35.678],
  [139.765, 35.678],
  [139.755, 35.692],
];

async function waitReady(page: Page) {
  await expect(page.locator('body')).toHaveAttribute('data-state', 'ready', { timeout: 120_000 });
}

async function clickAt(page: Page, [lon, lat]: [number, number]) {
  const p = await page.evaluate(async (ll) => (await window.entityMap).map.project(ll), [lon, lat] as [number, number]);
  await page.mouse.click(p.x, p.y);
}

/** Run an action that issues one map query and wait for its results and plan to be shown. */
async function query(page: Page, action: () => Promise<void>) {
  const before = Number((await page.locator('body').getAttribute('data-queries')) ?? 0);
  await page.evaluate(() => (document.getElementById('index-badge')!.textContent = ''));
  await action();
  await expect(page.locator('body')).toHaveAttribute('data-queries', String(before + 1));
  await expect(page.locator('#index-badge')).not.toHaveText('');
  return {
    count: Number((await page.locator('#m-count').textContent())!.replace(/,/g, '')),
    request: (await page.locator('#q-request').textContent())!,
    sql: (await page.locator('#q-sql').textContent())!,
    badge: (await page.locator('#index-badge').textContent())!,
  };
}

const entityCount = async (page: Page) => Number((await page.locator('#stat-entities').textContent())!.replace(/,/g, ''));

test('first load, GeoQueries from the map, reload, relaunch', async ({ baseURL }) => {
  const profile = mkdtempSync(join(tmpdir(), 'ngsi-ld-demo-'));
  try {
    let ctx = await chromium.launchPersistentContext(profile, { baseURL, viewport: { width: 1400, height: 900 } });
    let page = await ctx.newPage();

    // 1. First load copies the seed database into OPFS.
    await page.goto('/');
    await waitReady(page);
    expect(await page.locator('body').getAttribute('data-origin')).toBe('seed database copied into OPFS');
    const total = await entityCount(page);
    expect(total).toBeGreaterThan(70_000);
    await expect(page.locator('#stats')).toContainText('Server:NONE');
    await expect(page.locator('#stats')).toContainText('Storage:OPFS');
    const rendered = (layer: string) => page.evaluate(async (l) => (await window.entityMap).map.queryRenderedFeatures({ layers: [l] }).length, layer);
    await expect.poll(() => rendered('entities')).toBeGreaterThan(10_000);

    // 2. near: a click on the map becomes an NGSI-LD GeoQuery, lowered to SQL on the R-tree.
    const near = await query(page, () => clickAt(page, TOKYO_STATION));
    expect(near.request).toMatch(/^GET \/ngsi-ld\/v1\/entities\?georel=near;maxDistance==1000&geometry=Point&coordinates=\[139\.767\d*,35\.681\d*\]/);
    expect(near.sql).toContain('ST_Distance_Sphere');
    expect(near.badge).toBe('RTREE_INDEX_SCAN');
    expect(near.count).toBeGreaterThan(500);
    await expect(page.locator('#stat-last-query')).toHaveText(/^[\d.]+ ms SQL, [\d.]+ ms total$/);
    await expect(page.locator('#results-list li')).toHaveCount(30);
    // Every match is highlighted on the map.
    await expect.poll(() => rendered('results')).toBe(near.count);

    // 3. within: a polygon drawn on the map.
    await page.locator('#mode-within').click();
    const within = await query(page, async () => {
      for (const v of TRIANGLE) await clickAt(page, v);
      await page.keyboard.press('Enter');
    });
    // Pixels round-trip through the map projection, so vertices come back within a few metres.
    expect(within.request).toMatch(/georel=within&geometry=Polygon&coordinates=\[\[\[139\.74\d+,35\.67\d+\],/);
    expect(within.sql).toContain('ST_Within(g.geom');
    expect(within.badge).toBe('RTREE_INDEX_SCAN');
    expect(within.count).toBeGreaterThan(0);

    // The type filter narrows the same query.
    await page.locator('#type-filter').selectOption('Station');
    await page.locator('#mode-near').click();
    const stations = await query(page, () => clickAt(page, TOKYO_STATION));
    expect(stations.request).toContain('type=Station&');
    expect(stations.count).toBeGreaterThan(0);
    expect(stations.count).toBeLessThan(near.count);
    await page.locator('#type-filter').selectOption('');

    // 4. Reload: the database is restored from OPFS, not copied again.
    await page.reload();
    await waitReady(page);
    expect(await page.locator('body').getAttribute('data-origin')).toBe('restored from OPFS');
    expect(await entityCount(page)).toBe(total);
    expect((await query(page, () => clickAt(page, TOKYO_STATION))).count).toBe(near.count);
    await ctx.close();

    // 5. Relaunch the browser on the same profile.
    ctx = await chromium.launchPersistentContext(profile, { baseURL, viewport: { width: 1400, height: 900 } });
    page = await ctx.newPage();
    await page.goto('/');
    await waitReady(page);
    expect(await page.locator('body').getAttribute('data-origin')).toBe('restored from OPFS');
    const again = await query(page, () => clickAt(page, TOKYO_STATION));
    expect(again.count).toBe(near.count);
    expect(again.badge).toBe('RTREE_INDEX_SCAN');

    // 6. The restored seed stays writable (a copied database once was not).
    await page.locator('#advanced summary').click();
    await page.getByRole('button', { name: 'POST an entity' }).click();
    await page.locator('#send').click();
    await expect(page.locator('#response')).toHaveAttribute('data-status', '201');
    await expect(page.locator('#stat-entities')).toHaveText((total + 1).toLocaleString('en-US'));
    await ctx.close();
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
});
