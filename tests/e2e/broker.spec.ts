import { chromium, expect, test, type Page } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface Result {
  status: number;
  headers: Record<string, string>;
  body: any;
}

/** Call broker.fetch() inside the page and bring the response back as plain data. */
async function call(page: Page, method: string, path: string, opts: { body?: unknown; headers?: Record<string, string> } = {}) {
  return page.evaluate(
    async ({ method, path, body, headers }) => {
      const broker = await window.broker;
      const res = await broker.fetch(
        new Request(new URL(path, location.origin), {
          method,
          headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
      );
      const text = await res.text();
      return { status: res.status, headers: Object.fromEntries(res.headers), body: text ? JSON.parse(text) : null } as Result;
    },
    { method, path, body: opts.body, headers: opts.headers },
  );
}

const station = (key: string, name: string, lon: number, lat: number, type = 'Building') => ({
  id: `urn:ngsi-ld:${type}:${key}`,
  type,
  name: { type: 'Property', value: name },
  location: { type: 'GeoProperty', value: { type: 'Point', coordinates: [lon, lat] } },
});
const TOKYO = station('tokyo', 'Tokyo Station', 139.7671, 35.6812);
const SHINJUKU = station('shinjuku', 'Shinjuku Station', 139.7005, 35.6896); // ~6.1 km from Tokyo
const OSAKA = station('osaka', 'Osaka Station', 135.4959, 34.7025); // ~400 km from Tokyo
const SENSOR = station('sensor-1', 'Sensor near Tokyo', 139.768, 35.6815, 'Sensor');
const PARK = {
  id: 'urn:ngsi-ld:Park:imperial',
  type: 'Park',
  location: {
    type: 'GeoProperty',
    value: { type: 'Polygon', coordinates: [[[139.745, 35.679], [139.76, 35.679], [139.76, 35.69], [139.745, 35.69], [139.745, 35.679]]] },
  },
};

async function openApp(page: Page) {
  await page.goto('/');
  await expect(page.locator('#status')).toHaveAttribute('data-state', 'ready', { timeout: 60_000 });
}

const ids = (r: Result) => (r.body as any[]).map((e) => e.id).sort();

test.describe('broker.fetch', () => {
  test.beforeEach(async ({ page }) => openApp(page));

  test('POST then GET round-trips Property, Relationship and GeoProperty', async ({ page }) => {
    const entity = {
      ...TOKYO,
      height: { type: 'Property', value: 46.1, unitCode: 'MTR' },
      owner: { type: 'Relationship', object: 'urn:ngsi-ld:Organization:jr-east' },
    };
    const created = await call(page, 'POST', '/ngsi-ld/v1/entities', { body: entity });
    expect(created.status).toBe(201);
    expect(created.headers.location).toBe('/ngsi-ld/v1/entities/urn%3Angsi-ld%3ABuilding%3Atokyo');

    const got = await call(page, 'GET', created.headers.location);
    expect(got.status).toBe(200);
    expect(got.headers['content-type']).toBe('application/json');
    expect(got.headers.link).toContain('ngsi-ld-core-context');
    expect(got.body).toEqual(entity);

    const ld = await call(page, 'GET', created.headers.location, { headers: { Accept: 'application/ld+json' } });
    expect(ld.body['@context']).toBe('https://uri.etsi.org/ngsi-ld/v1/ngsi-ld-core-context-v1.8.jsonld');
  });

  test('rejects duplicates, missing entities and bad bodies', async ({ page }) => {
    expect((await call(page, 'POST', '/ngsi-ld/v1/entities', { body: TOKYO })).status).toBe(201);
    const dup = await call(page, 'POST', '/ngsi-ld/v1/entities', { body: TOKYO });
    expect(dup.status).toBe(409);
    expect(dup.body.type).toBe('https://uri.etsi.org/ngsi-ld/errors/AlreadyExists');
    expect((await call(page, 'GET', '/ngsi-ld/v1/entities/urn:ngsi-ld:Building:none')).status).toBe(404);
    expect((await call(page, 'POST', '/ngsi-ld/v1/entities', { body: { type: 'Building' } })).status).toBe(400);
    expect((await call(page, 'GET', '/ngsi-ld/v1/entities?georel=near&geometry=Point&coordinates=[0,0]')).status).toBe(400);
  });

  test('accepts application/ld+json with an inline @context', async ({ page }) => {
    const ctx = { Building: 'https://smartdatamodels.org/dataModel.Building/Building' };
    const res = await call(page, 'POST', '/ngsi-ld/v1/entities', {
      body: { ...TOKYO, '@context': [ctx, 'https://uri.etsi.org/ngsi-ld/v1/ngsi-ld-core-context-v1.8.jsonld'] },
      headers: { 'Content-Type': 'application/ld+json' },
    });
    expect(res.status).toBe(201);
    // Without that context, "Building" expands to the default vocabulary and does not match.
    expect((await call(page, 'GET', '/ngsi-ld/v1/entities?type=Building')).body).toEqual([]);
    const full = await call(page, 'GET', '/ngsi-ld/v1/entities?type=https://smartdatamodels.org/dataModel.Building/Building');
    expect(ids(full)).toEqual([TOKYO.id]);
  });

  test.describe('queries', () => {
    test.beforeEach(async ({ page }) => {
      for (const e of [TOKYO, SHINJUKU, OSAKA, SENSOR, PARK]) {
        expect((await call(page, 'POST', '/ngsi-ld/v1/entities', { body: e })).status).toBe(201);
      }
    });

    test('type query', async ({ page }) => {
      expect(ids(await call(page, 'GET', '/ngsi-ld/v1/entities?type=Building'))).toEqual([OSAKA.id, SHINJUKU.id, TOKYO.id].sort());
      expect(ids(await call(page, 'GET', '/ngsi-ld/v1/entities?type=Sensor,Park'))).toEqual([PARK.id, SENSOR.id].sort());
      expect(ids(await call(page, 'GET', '/ngsi-ld/v1/entities?type=Nothing'))).toEqual([]);
      expect((await call(page, 'GET', '/ngsi-ld/v1/entities?type=Building&limit=2')).body).toHaveLength(2);
    });

    test('near;maxDistance measures metres on the sphere', async ({ page }) => {
      const near = (d: number, extra = '') =>
        call(page, 'GET', `/ngsi-ld/v1/entities?georel=near;maxDistance==${d}&geometry=Point&coordinates=[139.7671,35.6812]${extra}`);
      // Tokyo-Shinjuku is ~6.13 km. With lon/lat not flipped it would come out as ~7.5 km.
      expect(ids(await near(6500, '&type=Building'))).toEqual([SHINJUKU.id, TOKYO.id].sort());
      expect(ids(await near(6000, '&type=Building'))).toEqual([TOKYO.id]);
      // The Polygon park is never matched by near and must not break the query.
      expect(ids(await near(1000))).toEqual([SENSOR.id, TOKYO.id].sort());
      expect(ids(await near(500_000, '&type=Building'))).toEqual([OSAKA.id, SHINJUKU.id, TOKYO.id].sort());
    });

    test('near;minDistance', async ({ page }) => {
      const r = await call(page, 'GET', '/ngsi-ld/v1/entities?type=Building&georel=near;minDistance==10000&geometry=Point&coordinates=[139.7671,35.6812]');
      expect(ids(r)).toEqual([OSAKA.id]);
    });

    test('within, intersects and contains', async ({ page }) => {
      const kanto = '[[[138.5,34.8],[140.9,34.8],[140.9,36.9],[138.5,36.9],[138.5,34.8]]]';
      expect(ids(await call(page, 'GET', `/ngsi-ld/v1/entities?georel=within&geometry=Polygon&coordinates=${kanto}`))).toEqual(
        [PARK.id, SENSOR.id, SHINJUKU.id, TOKYO.id].sort(),
      );
      // A point inside the park polygon: the park contains it and intersects it.
      const p = 'geometry=Point&coordinates=[139.75,35.685]';
      expect(ids(await call(page, 'GET', `/ngsi-ld/v1/entities?georel=contains&${p}`))).toEqual([PARK.id]);
      expect(ids(await call(page, 'GET', `/ngsi-ld/v1/entities?georel=intersects&${p}`))).toEqual([PARK.id]);
    });
  });

  test('entities survive a page reload', async ({ page }) => {
    expect((await call(page, 'POST', '/ngsi-ld/v1/entities', { body: TOKYO })).status).toBe(201);
    await page.reload();
    await expect(page.locator('#status')).toHaveAttribute('data-state', 'ready', { timeout: 60_000 });
    const got = await call(page, 'GET', `/ngsi-ld/v1/entities/${TOKYO.id}`);
    expect(got.status).toBe(200);
    expect(got.body).toEqual(TOKYO);
  });

  test('the page UI sends requests to the broker', async ({ page }) => {
    await page.getByRole('button', { name: 'POST Tokyo Station' }).click();
    await page.locator('#send').click();
    await expect(page.locator('#response')).toHaveAttribute('data-status', '201');
    await page.getByRole('button', { name: 'GET near Tokyo 10km' }).click();
    await page.locator('#send').click();
    await expect(page.locator('#response')).toHaveAttribute('data-status', '200');
    await expect(page.locator('#response')).toContainText('urn:ngsi-ld:Building:tokyo-station');
  });
});

test('entities survive closing and relaunching the browser (OPFS)', async ({ baseURL }) => {
  const profile = mkdtempSync(join(tmpdir(), 'ngsi-ld-opfs-'));
  try {
    let ctx = await chromium.launchPersistentContext(profile, { baseURL });
    let page = await ctx.newPage();
    await openApp(page);
    expect((await call(page, 'POST', '/ngsi-ld/v1/entities', { body: OSAKA })).status).toBe(201);
    await ctx.close();

    ctx = await chromium.launchPersistentContext(profile, { baseURL });
    page = await ctx.newPage();
    await openApp(page);
    const got = await call(page, 'GET', `/ngsi-ld/v1/entities/${OSAKA.id}`);
    expect(got.status).toBe(200);
    expect(got.body).toEqual(OSAKA);
    const r = await call(page, 'GET', '/ngsi-ld/v1/entities?georel=near;maxDistance==1000&geometry=Point&coordinates=[135.4959,34.7025]');
    expect(ids(r)).toEqual([OSAKA.id]);
    await ctx.close();
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
});
