// The demo page. Every NGSI-LD operation goes through broker.fetch(Request);
// nothing here talks SQL to DuckDB.
import type { AsyncDuckDB } from '@duckdb/duckdb-wasm';
import { Broker, HEADER_EXPLAIN, HEADER_PLAN, HEADER_SQL, MAX_LIMIT } from './broker';
import { openDuckDB, opfsFileSize, readOpfsFile, removeOpfsFiles, writeSeed } from './db';
import { EntityMap, TYPE_COLORS } from './map';

// ?seed=none starts from an empty database (used by the API tests);
// ?seed=ndjson skips the prebuilt database and imports through the batch API.
const SEED = new URLSearchParams(location.search).get('seed') ?? 'auto';
// The schema version is in the file name: a database from an older build is left
// behind (and removed below) rather than opened with the wrong tables.
const SCHEMA_VERSION = 2;
const DB_FILE = SEED === 'none' ? `ngsi-ld-empty-v${SCHEMA_VERSION}.duckdb` : `ngsi-ld-tokyo23-v${SCHEMA_VERSION}.duckdb`;
const STALE_FILES = ['ngsi-ld.duckdb', 'ngsi-ld-tokyo23.duckdb', 'ngsi-ld-empty.duckdb'].flatMap((f) => [f, `${f}.wal`]);
const SEED_DB_URL = new URL('seed/tokyo23.duckdb.gz', location.href).href;
const SEED_NDJSON_URL = new URL('seed/tokyo23-entities.ndjson', location.href).href;
const WARDS_URL = new URL('seed/tokyo23-wards.geojson', location.href).href;
const EXTENSIONS_URL = new URL('duckdb-extensions', location.href).href;
const ENTITIES = '/ngsi-ld/v1/entities';
const RESULT_LIMIT = 10_000;
const IMPORT_BATCH = 2000;

declare global {
  interface Window {
    broker: Promise<Broker>;
    exportDatabase: () => Promise<Blob>;
    entityMap: Promise<EntityMap>; // for tests: project lon/lat to the pixels to click
  }
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const fmt = (n: number) => n.toLocaleString('en-US');
const ms = (n: number) => `${n < 10 ? n.toFixed(1) : Math.round(n)} ms`;
const setPhase = (text: string) => ($('phase').textContent = text);

let db: AsyncDuckDB;
// What the map already holds about every entity, to label query results by id.
const known = new Map<string, GeoJSON.Feature<GeoJSON.Geometry, { id: string; type: string; name: string; category: string }>>();
let resolveBroker: (b: Broker) => void;
window.broker = new Promise((r) => (resolveBroker = r));

/** Call the broker with a path relative to the origin, as a client of a remote broker would. */
async function call(path: string, init: RequestInit = {}): Promise<Response> {
  return (await window.broker).fetch(new Request(new URL(path, location.origin), init));
}

// ---- status bar --------------------------------------------------------------

function showNetwork() {
  const el = $('stat-network');
  el.textContent = navigator.onLine ? 'ONLINE' : 'OFFLINE';
  el.dataset.online = String(navigator.onLine);
}
window.addEventListener('online', showNetwork);
window.addEventListener('offline', showNetwork);
showNetwork();

async function refreshCount(): Promise<number> {
  const res = await call(`${ENTITIES}?count=true&limit=0`);
  const n = Number(res.headers.get('NGSILD-Results-Count'));
  $('stat-entities').textContent = fmt(n);
  return n;
}

// ---- boot ----------------------------------------------------------------------

async function importNdjson() {
  setPhase('Downloading seed entities (NDJSON)…');
  const res = await fetch(SEED_NDJSON_URL);
  if (!res.ok) throw new Error(`seed NDJSON: HTTP ${res.status}`);
  const lines = (await res.text()).split('\n').filter(Boolean);
  for (let i = 0; i < lines.length; i += IMPORT_BATCH) {
    setPhase(`Importing through POST /ngsi-ld/v1/entityOperations/create: ${fmt(i)} / ${fmt(lines.length)}`);
    const r = await call('/ngsi-ld/v1/entityOperations/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: `[${lines.slice(i, i + IMPORT_BATCH).join(',')}]`,
    });
    if (r.status !== 201) throw new Error(`batch create returned ${r.status}: ${await r.text()}`);
  }
}

async function boot(map: Promise<EntityMap>) {
  const started = performance.now();
  await removeOpfsFiles(STALE_FILES);
  let origin: string;
  if ((await opfsFileSize(DB_FILE)) > 0) {
    origin = 'restored from OPFS';
  } else if (SEED === 'auto') {
    setPhase('Downloading the seed database…');
    const ok = await writeSeed(DB_FILE, SEED_DB_URL, (b) => setPhase(`Downloading the seed database… ${(b / 1e6).toFixed(1)} MB`));
    origin = ok ? 'seed database copied into OPFS' : 'imported from NDJSON';
  } else {
    origin = SEED === 'none' ? 'empty' : 'imported from NDJSON';
  }

  setPhase('Opening DuckDB-Wasm on OPFS…');
  db = await openDuckDB(`opfs://${DB_FILE}`, EXTENSIONS_URL);
  $('stat-database').textContent = `DuckDB-Wasm ${await db.getVersion()}`;
  const broker = await Broker.open(db);
  resolveBroker(broker);

  let count = await refreshCount();
  if (count === 0 && SEED !== 'none') {
    await importNdjson();
    count = await refreshCount();
  }
  $('seed-info').textContent = `${origin}, file opfs://${DB_FILE}`;

  setPhase('Loading entities onto the map…');
  const res = await call(`${ENTITIES}?limit=${MAX_LIMIT}`, { headers: { Accept: 'application/geo+json' } });
  const fc = (await res.json()) as GeoJSON.FeatureCollection;
  const m = await map;
  m.setEntities(slim(fc));
  // One throwaway GeoQuery pulls the R-tree and the tables into DuckDB's buffer
  // pool, so the first click is not the one that pays for reading them from OPFS.
  await call(`${ENTITIES}?georel=near;maxDistance==100&geometry=Point&coordinates=[139.7671,35.6812]&pick=id`);
  // Let MapLibre finish tiling the points before inviting clicks: until then it
  // keeps the main thread busy, and query timings would include that wait.
  await m.idle();
  const secs = ((performance.now() - started) / 1000).toFixed(1);
  setPhase(`Ready in ${secs} s: ${fmt(count)} entities ${origin}.${m.basemapOnline ? '' : ' Basemap unavailable offline.'}`);
  document.body.dataset.state = 'ready';
  document.body.dataset.origin = origin;
}

/** Keep only what the map draws, to spare MapLibre's worker from full documents. */
function slim(fc: GeoJSON.FeatureCollection): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: fc.features
      .filter((f) => f.geometry)
      .map((f) => {
        const p = f.properties ?? {};
        const feature = {
          type: 'Feature' as const,
          geometry: f.geometry,
          properties: { id: p.id, type: p.type, name: p.name?.value ?? '', category: p.category?.value ?? '' },
        };
        known.set(p.id, feature);
        return feature;
      }),
  };
}

// ---- GeoQuery from the map ------------------------------------------------------

const round = (n: number) => Math.round(n * 1e6) / 1e6;

function typeParam(): string {
  const t = $<HTMLSelectElement>('type-filter').value;
  return t ? `type=${t}&` : '';
}

async function runQuery(query: string, m: EntityMap) {
  // pick=id: the map already has every entity's geometry and name, so the broker
  // only has to say which ones matched.
  const path = `${ENTITIES}?${query}&pick=id&limit=${RESULT_LIMIT}&count=true`;
  const t = performance.now();
  const res = await call(path);
  const elapsed = performance.now() - t;
  if (!res.ok) {
    $('q-request').textContent = `GET ${path}\n\n${res.status} ${await res.text()}`;
    return;
  }
  const ids = ((await res.json()) as { id: string }[]).map((e) => e.id);
  m.setResults(ids.flatMap((id) => known.get(id) ?? []));

  const timing = Object.fromEntries(
    (res.headers.get('Server-Timing') ?? '').split(',').map((p) => {
      const [name, dur] = p.trim().split(';dur=');
      return [name, Number(dur)];
    }),
  );
  const sqlMs = timing.sql + (timing.count ?? 0);
  const count = Number(res.headers.get('NGSILD-Results-Count'));
  $('query').hidden = false;
  $('m-count').textContent = fmt(count);
  $('m-sql').textContent = ms(sqlMs);
  $('m-total').textContent = ms(elapsed);
  $('stat-last-query').textContent = `${ms(sqlMs)} SQL, ${ms(elapsed)} total`;
  $('q-request').textContent = `GET ${path}`;
  $('q-sql').textContent = decodeURIComponent(res.headers.get(HEADER_SQL) ?? '');
  $('q-shown').textContent = ids.length < count ? `(first ${fmt(ids.length)} drawn)` : '';

  $('results-list').replaceChildren(
    ...ids.slice(0, 30).map((id) => {
      const e = known.get(id)?.properties;
      const li = document.createElement('li');
      const sw = document.createElement('span');
      sw.className = 'swatch';
      sw.style.background = TYPE_COLORS[e?.type ?? ''] ?? '#868e96';
      const small = document.createElement('small');
      small.textContent = `${e?.type ?? ''} / ${e?.category ?? ''}`;
      li.append(sw, `${e?.name || '(no name)'} `, small);
      li.title = id;
      return li;
    }),
  );
  document.body.dataset.queries = String(Number(document.body.dataset.queries ?? 0) + 1);

  // Ask the broker for DuckDB's plan of the same query, to show the index at work.
  const plan = await call(path, { headers: { [HEADER_EXPLAIN]: '1' } });
  const text = decodeURIComponent(plan.headers.get(HEADER_PLAN) ?? '');
  $('q-plan').textContent = text;
  const badge = $('index-badge');
  const used = text.includes('RTREE_INDEX_SCAN');
  badge.dataset.used = String(used);
  badge.textContent = used ? 'RTREE_INDEX_SCAN' : 'no index (sequential scan)';
}

function bindControls(m: EntityMap) {
  for (const type of Object.keys(TYPE_COLORS)) $('type-filter').append(new Option(type, type));
  const setMode = (mode: 'near' | 'within') => {
    m.setMode(mode);
    $('mode-near').setAttribute('aria-pressed', String(mode === 'near'));
    $('mode-within').setAttribute('aria-pressed', String(mode === 'within'));
    $('mode-hint').textContent =
      mode === 'near'
        ? 'Click the map to find entities within the radius.'
        : 'Click to add vertices; double-click, press Enter or click the first vertex to finish. Esc cancels.';
  };
  $('mode-near').onclick = () => setMode('near');
  $('mode-within').onclick = () => setMode('within');
  $('clear').onclick = () => m.clear();
  setMode('near');

  // Draw the shape first and let that frame render, so the query does not share
  // the main thread with MapLibre and its timing reflects DuckDB.
  const afterPaint = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  m.onNear = async ([lon, lat]) => {
    const r = Number($<HTMLSelectElement>('radius').value);
    m.showCircle([lon, lat], r);
    await afterPaint();
    void runQuery(`${typeParam()}georel=near;maxDistance==${r}&geometry=Point&coordinates=[${round(lon)},${round(lat)}]`, m);
  };
  m.onWithin = async (ring) => {
    await afterPaint();
    const coords = JSON.stringify([ring.map(([x, y]) => [round(x), round(y)])]);
    void runQuery(`${typeParam()}georel=within&geometry=Polygon&coordinates=${coords}`, m);
  };
}

// ---- Advanced / Debug ------------------------------------------------------------

const PRESETS: Record<string, { method: string; path: string; headers?: string; body?: unknown }> = {
  'Count all': { method: 'GET', path: `${ENTITIES}?count=true&limit=0` },
  'Stations (5)': { method: 'GET', path: `${ENTITIES}?type=Station&limit=5` },
  'Near Tokyo Station 300 m': {
    method: 'GET',
    path: `${ENTITIES}?georel=near;maxDistance==300&geometry=Point&coordinates=[139.7671,35.6812]&count=true`,
  },
  'POST an entity': {
    method: 'POST',
    path: ENTITIES,
    headers: 'Content-Type: application/json',
    body: {
      id: 'urn:ngsi-ld:TouristAttraction:my-spot',
      type: 'TouristAttraction',
      name: { type: 'Property', value: 'My spot' },
      location: { type: 'GeoProperty', value: { type: 'Point', coordinates: [139.7454, 35.6586] } },
    },
  },
  'GET it': { method: 'GET', path: `${ENTITIES}/urn:ngsi-ld:TouristAttraction:my-spot` },
  'DELETE it': { method: 'DELETE', path: `${ENTITIES}/urn:ngsi-ld:TouristAttraction:my-spot` },
};

function bindConsole() {
  for (const [label, p] of Object.entries(PRESETS)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.onclick = () => {
      $<HTMLSelectElement>('method').value = p.method;
      $<HTMLInputElement>('path').value = p.path;
      $<HTMLTextAreaElement>('headers').value = p.headers ?? '';
      $<HTMLTextAreaElement>('body').value = p.body ? JSON.stringify(p.body, null, 2) : '';
    };
    $('presets').append(b);
  }

  $<HTMLFormElement>('console').onsubmit = async (ev) => {
    ev.preventDefault();
    const out = $('response');
    out.textContent = '…';
    const method = $<HTMLSelectElement>('method').value;
    const headers = new Headers();
    for (const line of $<HTMLTextAreaElement>('headers').value.split('\n')) {
      const i = line.indexOf(':');
      if (i > 0) headers.set(line.slice(0, i).trim(), line.slice(i + 1).trim());
    }
    const started = performance.now();
    const res = await call($<HTMLInputElement>('path').value, {
      method,
      headers,
      body: method === 'POST' ? $<HTMLTextAreaElement>('body').value : undefined,
    });
    const text = await res.text();
    let pretty = text;
    try {
      pretty = JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      /* not JSON */
    }
    const head = [...res.headers].map(([k, v]) => `${k}: ${k === HEADER_SQL.toLowerCase() ? decodeURIComponent(v) : v}`).join('\n');
    out.textContent = `${res.status} (${ms(performance.now() - started)})\n${head}\n\n${pretty}`;
    out.dataset.status = String(res.status);
    if (method !== 'GET') await refreshCount();
  };

  // Every write ends with CHECKPOINT, so the OPFS file is complete once DuckDB lets go of it.
  window.exportDatabase = async () => {
    await db.terminate();
    const file = await readOpfsFile(DB_FILE);
    setPhase('Database exported; reload the page to use it again.');
    return file;
  };
  $('export-db').onclick = async () => {
    const blob = await window.exportDatabase();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = DB_FILE;
    a.click();
  };
  $('reset-db').onclick = async () => {
    if (!confirm(`Delete opfs://${DB_FILE}? The seed will be copied again on reload.`)) return;
    await db.terminate();
    await removeOpfsFiles([DB_FILE, `${DB_FILE}.wal`]);
    location.reload();
  };
}

// ---- start -------------------------------------------------------------------------

// Production only: the Service Worker keeps the app itself for offline use (sw/sw.js).
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('service worker:', e));
}

const map = EntityMap.create($('map'), WARDS_URL);
window.entityMap = map;
map.then(bindControls);
bindConsole();
boot(map).catch((e) => {
  console.error(e);
  document.body.dataset.state = 'error';
  setPhase(`Failed: ${e}`);
});
