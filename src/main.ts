import { Broker } from './broker';
import { openDuckDB } from './db';

const DB_PATH = 'opfs://ngsi-ld.duckdb';

declare global {
  interface Window {
    broker: Promise<Broker>;
  }
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = $('status');

window.broker = (async () => {
  const db = await openDuckDB(DB_PATH);
  return Broker.open(db);
})();
window.broker.then(
  () => ((status.textContent = `ready: ${DB_PATH}`), (status.dataset.state = 'ready')),
  (e) => ((status.textContent = `failed: ${e}`), (status.dataset.state = 'error')),
);

const PRESETS: Record<string, { method: string; path: string; headers?: string; body?: unknown }> = {
  'POST Tokyo Station': {
    method: 'POST',
    path: '/ngsi-ld/v1/entities',
    headers: 'Content-Type: application/json',
    body: {
      id: 'urn:ngsi-ld:Building:tokyo-station',
      type: 'Building',
      name: { type: 'Property', value: 'Tokyo Station' },
      owner: { type: 'Relationship', object: 'urn:ngsi-ld:Organization:jr-east' },
      location: { type: 'GeoProperty', value: { type: 'Point', coordinates: [139.7671, 35.6812] } },
    },
  },
  'POST Shinjuku Station': {
    method: 'POST',
    path: '/ngsi-ld/v1/entities',
    headers: 'Content-Type: application/json',
    body: {
      id: 'urn:ngsi-ld:Building:shinjuku-station',
      type: 'Building',
      name: { type: 'Property', value: 'Shinjuku Station' },
      location: { type: 'GeoProperty', value: { type: 'Point', coordinates: [139.7005, 35.6896] } },
    },
  },
  'POST Osaka Station': {
    method: 'POST',
    path: '/ngsi-ld/v1/entities',
    headers: 'Content-Type: application/json',
    body: {
      id: 'urn:ngsi-ld:Building:osaka-station',
      type: 'Building',
      name: { type: 'Property', value: 'Osaka Station' },
      location: { type: 'GeoProperty', value: { type: 'Point', coordinates: [135.4959, 34.7025] } },
    },
  },
  'GET by id': { method: 'GET', path: '/ngsi-ld/v1/entities/urn:ngsi-ld:Building:tokyo-station' },
  'GET type=Building': { method: 'GET', path: '/ngsi-ld/v1/entities?type=Building' },
  'GET near Tokyo 10km': {
    method: 'GET',
    path: '/ngsi-ld/v1/entities?type=Building&georel=near;maxDistance==10000&geometry=Point&coordinates=[139.7671,35.6812]',
  },
  'GET within Kanto box': {
    method: 'GET',
    path: '/ngsi-ld/v1/entities?georel=within&geometry=Polygon&coordinates=[[[138.5,34.8],[140.9,34.8],[140.9,36.9],[138.5,36.9],[138.5,34.8]]]',
  },
  'DELETE by id': { method: 'DELETE', path: '/ngsi-ld/v1/entities/urn:ngsi-ld:Building:tokyo-station' },
};

const presets = $('presets');
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
  presets.append(b);
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
  const body = $<HTMLTextAreaElement>('body').value;
  const req = new Request(new URL($<HTMLInputElement>('path').value, location.origin), {
    method,
    headers,
    body: method === 'POST' ? body : undefined,
  });
  const started = performance.now();
  const res = await (await window.broker).fetch(req);
  const text = await res.text();
  const ms = (performance.now() - started).toFixed(1);
  let pretty = text;
  try {
    pretty = JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    /* not JSON */
  }
  const head = [...res.headers].map(([k, v]) => `${k}: ${v}`).join('\n');
  out.textContent = `${res.status} (${ms} ms)\n${head}\n\n${pretty}`;
  out.dataset.status = String(res.status);
};
