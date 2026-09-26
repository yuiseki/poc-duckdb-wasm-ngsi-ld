// NGSI-LD query parameters -> SQL over the canonical tables (see store.ts).
import { badRequest } from './errors';

export const GEORELS = ['near', 'within', 'contains', 'intersects', 'disjoint', 'equals', 'overlaps'] as const;
export type Georel = (typeof GEORELS)[number];
const GEOMETRIES = ['Point', 'MultiPoint', 'LineString', 'MultiLineString', 'Polygon', 'MultiPolygon'];

export interface GeoQuery {
  georel: Georel;
  maxDistance?: number; // metres, near only
  minDistance?: number; // metres, near only
  geometry: { type: string; coordinates: unknown };
  geoproperty: string; // a term before expansion, an IRI after
}

export interface EntityQuery {
  types?: string[]; // expanded IRIs, OR-ed
  geo?: GeoQuery; // geoproperty expanded
  limit: number;
  offset: number;
}

export interface LoweredQuery {
  sql: string; // selects the matching entity ids, ordered and paged
  params: unknown[];
  countSql: string; // counts all matches, ignoring limit and offset
  countParams: unknown[];
}

const isNumberArray = (v: unknown): boolean =>
  Array.isArray(v) && v.length > 0 && v.every((x) => (Array.isArray(x) ? isNumberArray(x) : Number.isFinite(x)));

/** Parse `georel`, `geometry`, `coordinates` and `geoproperty`. Returns null when there is no geo-query. */
export function parseGeoQuery(params: URLSearchParams): GeoQuery | null {
  const georelParam = params.get('georel');
  if (georelParam === null) return null;
  const [rel, ...modifiers] = georelParam.split(';');
  if (!(GEORELS as readonly string[]).includes(rel)) throw badRequest(`unsupported georel ${rel}`);

  const type = params.get('geometry');
  const coordinates = params.get('coordinates');
  if (!type || !coordinates) throw badRequest('georel requires geometry and coordinates');
  if (!GEOMETRIES.includes(type)) throw badRequest(`unsupported geometry ${type}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(coordinates);
  } catch {
    throw badRequest('coordinates must be a JSON array');
  }
  if (!isNumberArray(parsed)) throw badRequest('coordinates must be a JSON array of numbers');

  const q: GeoQuery = {
    georel: rel as Georel,
    geometry: { type, coordinates: parsed },
    geoproperty: params.get('geoproperty') ?? 'location',
  };
  for (const m of modifiers) {
    const [key, value] = m.split('==');
    const n = Number(value);
    if ((key !== 'maxDistance' && key !== 'minDistance') || value === undefined || !Number.isFinite(n) || n < 0) {
      throw badRequest(`invalid georel modifier ${m}`);
    }
    q[key] = n;
  }
  if (q.georel === 'near') {
    if (q.maxDistance === undefined && q.minDistance === undefined) throw badRequest('near requires maxDistance or minDistance');
    if (type !== 'Point') throw badRequest('near is only supported with a Point geometry');
  } else if (modifiers.length) {
    throw badRequest(`${q.georel} takes no modifiers`);
  }
  return q;
}

// Predicates the DuckDB Spatial R-tree index can answer. ST_Disjoint cannot.
const INDEXED: Record<string, string> = {
  within: 'ST_Within',
  contains: 'ST_Contains',
  intersects: 'ST_Intersects',
  equals: 'ST_Equals',
  overlaps: 'ST_Overlaps',
};

// A radius smaller than the Earth's, so the box around a circle is never too small.
const EARTH_RADIUS_MIN = 6_356_752;
const deg = (rad: number) => (rad * 180) / Math.PI;

/** The lon/lat box that contains every point within `metres` of (lon, lat), or null if it wraps a pole. */
export function boundingBox(lon: number, lat: number, metres: number): [number, number, number, number] | null {
  const angle = (metres / EARTH_RADIUS_MIN) * 1.01;
  const sinLon = Math.sin(angle) / Math.cos((lat * Math.PI) / 180);
  if (angle >= Math.PI / 2 || sinLon >= 1) return null;
  const dLat = deg(angle);
  const dLon = deg(Math.asin(sinLon));
  return [lon - dLon, lat - dLat, lon + dLon, lat + dLat];
}

/**
 * Lower a query to SQL. Geo predicates the R-tree can answer run in a
 * MATERIALIZED CTE directly over `geometries`: only a filter sitting right on
 * the table scan is rewritten into RTREE_INDEX_SCAN, and a correlated EXISTS,
 * or a distance test in the same filter, would turn it back into a full scan.
 */
export function lowerEntityQuery(q: EntityQuery): LoweredQuery {
  let cte: string | null = null;
  const cteParams: unknown[] = [];
  const where: string[] = [];
  const whereParams: unknown[] = [];

  if (q.geo) {
    const g = q.geo;
    const target = 'ST_GeomFromGeoJSON(?)';
    const geomParam = JSON.stringify(g.geometry);
    if (g.georel === 'near') {
      // ST_Distance_Sphere expects [lat, lon] axis order and POINT inputs only;
      // stored non-point geometries never match `near`.
      const distance = `ST_Distance_Sphere(ST_FlipCoordinates(g.geom), ST_FlipCoordinates(${target}))`;
      const tests = [`ST_GeometryType(g.geom) = 'POINT'`];
      const testParams: unknown[] = [];
      if (g.maxDistance !== undefined) tests.push(`${distance} <= ?`), testParams.push(geomParam, g.maxDistance);
      if (g.minDistance !== undefined) tests.push(`${distance} >= ?`), testParams.push(geomParam, g.minDistance);
      const [lon, lat] = g.geometry.coordinates as number[];
      const box = g.maxDistance !== undefined ? boundingBox(lon, lat, g.maxDistance) : null;
      if (box) {
        cte = 'SELECT g.eid, g.geom FROM geometries g WHERE g.name = ? AND ST_Intersects(g.geom, ST_MakeEnvelope(?, ?, ?, ?))';
        cteParams.push(g.geoproperty, ...box);
        where.push(`e.eid IN (SELECT g.eid FROM geo g WHERE ${tests.join(' AND ')})`);
      } else {
        where.push(`e.eid IN (SELECT g.eid FROM geometries g WHERE g.name = ? AND ${tests.join(' AND ')})`);
        whereParams.push(g.geoproperty);
      }
      whereParams.push(...testParams);
    } else if (INDEXED[g.georel]) {
      cte = `SELECT g.eid, g.geom FROM geometries g WHERE g.name = ? AND ${INDEXED[g.georel]}(g.geom, ${target})`;
      cteParams.push(g.geoproperty, geomParam);
      where.push('e.eid IN (SELECT g.eid FROM geo g)');
    } else {
      where.push(`e.eid IN (SELECT g.eid FROM geometries g WHERE g.name = ? AND ST_Disjoint(g.geom, ${target}))`);
      whereParams.push(g.geoproperty, geomParam);
    }
  }

  if (q.types?.length) {
    where.push(`e.id IN (SELECT t.entity_id FROM entity_types t WHERE t.type IN (${q.types.map(() => '?').join(', ')}))`);
    whereParams.push(...q.types);
  }

  const withClause = cte ? `WITH geo AS MATERIALIZED (\n  ${cte}\n)\n` : '';
  const whereClause = where.length ? `\nWHERE ${where.join('\n  AND ')}` : '';
  return {
    sql: `${withClause}SELECT e.id FROM entities e${whereClause}\nORDER BY e.id LIMIT ? OFFSET ?`,
    params: [...cteParams, ...whereParams, q.limit, q.offset],
    countSql: `${withClause}SELECT count(*) AS n FROM entities e${whereClause}`,
    countParams: [...cteParams, ...whereParams],
  };
}

/** Inline parameters into SQL for display only; execution always uses the prepared statement. */
export function renderSql(sql: string, params: unknown[]): string {
  let i = 0;
  return sql.replace(/\?/g, () => {
    const p = params[i++];
    return typeof p === 'number' ? String(p) : p === null || p === undefined ? 'NULL' : `'${String(p).replace(/'/g, "''")}'`;
  });
}
