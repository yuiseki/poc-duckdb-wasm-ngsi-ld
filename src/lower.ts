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
  if (!Array.isArray(parsed)) throw badRequest('coordinates must be a JSON array');

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

const PREDICATES: Record<Exclude<Georel, 'near'>, string> = {
  within: 'ST_Within',
  contains: 'ST_Contains',
  intersects: 'ST_Intersects',
  disjoint: 'ST_Disjoint',
  equals: 'ST_Equals',
  overlaps: 'ST_Overlaps',
};

/**
 * Lower a query to SQL selecting matching entity ids (`SELECT e.id ...`),
 * with `?` placeholders bound in order to `params`.
 */
export function lowerEntityQuery(q: EntityQuery): { sql: string; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];

  if (q.types?.length) {
    where.push(`EXISTS (SELECT 1 FROM entity_types t WHERE t.entity_id = e.id AND t.type IN (${q.types.map(() => '?').join(', ')}))`);
    params.push(...q.types);
  }

  if (q.geo) {
    const g = q.geo;
    const target = 'ST_GeomFromGeoJSON(?)';
    const geomParam = JSON.stringify(g.geometry);
    let pred: string;
    const predParams: unknown[] = [];
    if (g.georel === 'near') {
      // ST_Distance_Sphere expects [lat, lon] axis order and POINT inputs only;
      // stored non-point geometries never match `near`.
      const distance = `ST_Distance_Sphere(ST_FlipCoordinates(a.geom), ST_FlipCoordinates(${target}))`;
      const parts: string[] = [];
      if (g.maxDistance !== undefined) {
        parts.push(`${distance} <= ?`);
        predParams.push(geomParam, g.maxDistance);
      }
      if (g.minDistance !== undefined) {
        parts.push(`${distance} >= ?`);
        predParams.push(geomParam, g.minDistance);
      }
      pred = `ST_GeometryType(a.geom) = 'POINT' AND ${parts.join(' AND ')}`;
    } else {
      pred = `${PREDICATES[g.georel]}(a.geom, ${target})`;
      predParams.push(geomParam);
    }
    where.push(`EXISTS (SELECT 1 FROM attributes a WHERE a.entity_id = e.id AND a.name = ? AND a.geom IS NOT NULL AND ${pred})`);
    params.push(g.geoproperty, ...predParams);
  }

  const sql = `SELECT e.id FROM entities e${where.length ? `\nWHERE ${where.join('\n  AND ')}` : ''}\nORDER BY e.id LIMIT ? OFFSET ?`;
  params.push(q.limit, q.offset);
  return { sql, params };
}
