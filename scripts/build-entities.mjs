// Build the seed dataset: NGSI-LD entities (NDJSON) from the frozen OpenStreetMap
// extract of Tokyo's 23 wards (https://huggingface.co/datasets/yuiseki/osm-tokyo23-src-2026-08, ODbL).
//
//   node scripts/build-entities.mjs
//
// Downloads the point table and the ward boundary into data/cache/ (checked by md5),
// and writes public/seed/tokyo23-entities.ndjson and public/seed/tokyo23-wards.geojson.
import { DuckDBInstance } from '@duckdb/node-api';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const BASE = 'https://huggingface.co/datasets/yuiseki/osm-tokyo23-src-2026-08/resolve/main';
const SOURCES = {
  'planet_osm_point.parquet': { path: 'parquet/planet_osm_point.parquet', md5: '21e33ec8bb2b51178fea3e36833b5a99' },
  'tokyo23_osm_boundary.geojson': { path: 'tokyo23_osm_boundary.geojson', md5: 'a98565308b7d1ec5098b1b5db0df056c' },
};

mkdirSync('data/cache', { recursive: true });
mkdirSync('public/seed', { recursive: true });
for (const [name, { path, md5 }] of Object.entries(SOURCES)) {
  const local = `data/cache/${name}`;
  if (!existsSync(local)) {
    console.log(`downloading ${path}`);
    const res = await fetch(`${BASE}/${path}`);
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    writeFileSync(local, Buffer.from(await res.arrayBuffer()));
  }
  const actual = createHash('md5').update(readFileSync(local)).digest('hex');
  if (actual !== md5) throw new Error(`${local}: md5 ${actual}, expected ${md5}`);
}

// One NGSI-LD type per point, first match wins. `category` keeps the OSM tag value.
const TYPE = `CASE
  WHEN railway = 'station' THEN 'Station'
  WHEN tags->>'emergency' IN ('assembly_point', 'defibrillator') OR amenity = 'shelter' THEN 'EmergencyFacility'
  WHEN amenity IN ('hospital', 'clinic', 'doctors', 'dentist', 'pharmacy') THEN 'HealthcareFacility'
  WHEN amenity IN ('school', 'kindergarten', 'university', 'college', 'prep_school', 'childcare') THEN 'EducationFacility'
  WHEN amenity IN ('townhall', 'police', 'fire_station', 'post_office', 'library', 'community_centre', 'courthouse', 'social_facility') THEN 'PublicFacility'
  WHEN amenity IN ('restaurant', 'cafe', 'fast_food', 'pub', 'bar', 'food_court', 'ice_cream', 'biergarten') THEN 'Restaurant'
  WHEN shop IS NOT NULL THEN 'Shop'
  WHEN tourism IN ('hotel', 'hostel', 'guest_house', 'motel', 'museum', 'gallery', 'attraction', 'viewpoint', 'zoo', 'aquarium', 'theme_park') THEN 'TouristAttraction'
  WHEN amenity = 'place_of_worship' THEN 'PlaceOfWorship'
END`;
const CATEGORY = `CASE
  WHEN railway = 'station' THEN 'station'
  WHEN tags->>'emergency' IS NOT NULL THEN tags->>'emergency'
  WHEN amenity IS NOT NULL THEN amenity
  WHEN shop IS NOT NULL THEN shop
  ELSE tourism
END`;

const db = await DuckDBInstance.create(':memory:');
const c = await db.connect();
await c.run('INSTALL spatial; LOAD spatial;');
// EPSG:3857 -> EPSG:4326 with the inverse spherical Mercator formulas, rounded to ~1 cm.
await c.run(`
CREATE TABLE poi AS
WITH p AS (
  SELECT osm_id, name, ${TYPE} AS type, ${CATEGORY} AS category,
         ST_X(ST_GeomFromWKB(way)) AS x, ST_Y(ST_GeomFromWKB(way)) AS y
  FROM 'data/cache/planet_osm_point.parquet'
),
wards AS (SELECT ST_Union_Agg(geom) AS geom FROM ST_Read('data/cache/tokyo23_osm_boundary.geojson'))
SELECT osm_id, name, type, category,
       round(x / 6378137 * 180 / pi(), 7) AS lon,
       round((2 * atan(exp(y / 6378137)) - pi() / 2) * 180 / pi(), 7) AS lat
FROM p, wards
WHERE type IS NOT NULL
  AND (name IS NOT NULL OR type = 'EmergencyFacility')
  AND ST_Within(ST_Point(round(x / 6378137 * 180 / pi(), 7), round((2 * atan(exp(y / 6378137)) - pi() / 2) * 180 / pi(), 7)), wards.geom)
ORDER BY type, osm_id`);

const rows = (// Hilbert order: entities that are close on the map are inserted next to each other, so
// the rows an R-tree lookup returns sit in a few storage blocks instead of all of them.
await c.runAndReadAll(`SELECT * FROM poi
  ORDER BY ST_Hilbert(ST_Point(lon, lat), {min_x: 139.5, min_y: 35.4, max_x: 140.0, max_y: 35.9}::BOX_2D), osm_id`)).getRowObjectsJson();
const lines = rows.map((r) =>
  JSON.stringify({
    id: `urn:ngsi-ld:${r.type}:osm-node-${r.osm_id}`,
    type: r.type,
    ...(r.name ? { name: { type: 'Property', value: r.name } } : {}),
    category: { type: 'Property', value: r.category },
    source: { type: 'Property', value: `https://www.openstreetmap.org/node/${r.osm_id}` },
    location: { type: 'GeoProperty', value: { type: 'Point', coordinates: [Number(r.lon), Number(r.lat)] } },
  }),
);
writeFileSync('public/seed/tokyo23-entities.ndjson', lines.join('\n') + '\n');

// Ward outlines for an offline-capable base layer, simplified to ~5 m.
const wards = (
  await c.runAndReadAll(`
  SELECT json_object('type', 'FeatureCollection', 'features', json_group_array(json_object(
    'type', 'Feature', 'properties', json_object('name', name),
    'geometry', ST_AsGeoJSON(ST_SimplifyPreserveTopology(geom, 0.00005))::JSON)))::VARCHAR AS fc
  FROM ST_Read('data/cache/tokyo23_osm_boundary.geojson')`)
).getRowObjectsJson()[0].fc;
writeFileSync('public/seed/tokyo23-wards.geojson', wards);

const counts = (await c.runAndReadAll('SELECT type, count(*) AS n FROM poi GROUP BY 1 ORDER BY 2 DESC')).getRowObjectsJson();
console.log(counts.map((r) => `${r.type}: ${r.n}`).join('\n'));
console.log(`total: ${rows.length} entities`);
