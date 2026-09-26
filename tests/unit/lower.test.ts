import { describe, expect, it } from 'vitest';
import { boundingBox, lowerEntityQuery, parseGeoQuery, renderSql } from '../../src/lower';

const params = (s: string) => new URLSearchParams(s);

describe('parseGeoQuery', () => {
  it('returns null when there is no georel', () => {
    expect(parseGeoQuery(params('type=Building'))).toBeNull();
  });

  it('parses near with maxDistance', () => {
    const q = parseGeoQuery(params('georel=near;maxDistance==2000&geometry=Point&coordinates=[139.767,35.681]'));
    expect(q).toEqual({
      georel: 'near',
      maxDistance: 2000,
      geometry: { type: 'Point', coordinates: [139.767, 35.681] },
      geoproperty: 'location',
    });
  });

  it('parses within a polygon and a custom geoproperty', () => {
    const q = parseGeoQuery(
      params('georel=within&geometry=Polygon&coordinates=[[[139,35],[140,35],[140,36],[139,36],[139,35]]]&geoproperty=area'),
    );
    expect(q?.georel).toBe('within');
    expect(q?.geometry.type).toBe('Polygon');
    expect(q?.geoproperty).toBe('area');
  });

  it.each([
    'georel=near&geometry=Point&coordinates=[0,0]',
    'georel=near;maxDistance==abc&geometry=Point&coordinates=[0,0]',
    'georel=near;maxDistance==10&geometry=Polygon&coordinates=[[[0,0],[1,0],[1,1],[0,0]]]',
    'georel=nearby&geometry=Point&coordinates=[0,0]',
    'georel=within&coordinates=[0,0]',
    'georel=within&geometry=Point',
    'georel=within&geometry=Point&coordinates=nope',
    'georel=within&geometry=Circle&coordinates=[0,0]',
    'georel=within&geometry=Point&coordinates=["0",0]',
    'georel=within&geometry=Point&coordinates=[]',
  ])('rejects %s', (s) => {
    expect(() => parseGeoQuery(params(s))).toThrow(expect.objectContaining({ status: 400 }));
  });
});

describe('lowerEntityQuery', () => {
  const LOC = 'https://uri.etsi.org/ngsi-ld/location';
  const point = { type: 'Point', coordinates: [139.767, 35.681] };

  it('lowers a type query to a parameterised IN', () => {
    const q = lowerEntityQuery({ types: ['https://ex.org/A', 'https://ex.org/B'], limit: 20, offset: 0 });
    expect(q.sql).toContain('e.id IN (SELECT t.entity_id FROM entity_types t WHERE t.type IN (?, ?))');
    expect(q.sql).not.toContain('WITH geo');
    expect(q.params).toEqual(['https://ex.org/A', 'https://ex.org/B', 20, 0]);
    expect(q.countSql).toMatch(/^SELECT count\(\*\) AS n FROM entities e/);
    expect(q.countParams).toEqual(['https://ex.org/A', 'https://ex.org/B']);
  });

  it('lowers near;maxDistance to an R-tree box prefilter plus an exact spherical distance', () => {
    const q = lowerEntityQuery({ geo: { georel: 'near', maxDistance: 1000, geometry: point, geoproperty: LOC }, limit: 20, offset: 0 });
    expect(q.sql).toContain('WITH geo AS MATERIALIZED');
    expect(q.sql).toContain('ST_Intersects(g.geom, ST_MakeEnvelope(?, ?, ?, ?))');
    // ST_Distance_Sphere takes [lat, lon]; NGSI-LD/GeoJSON is [lon, lat].
    expect(q.sql).toContain('ST_Distance_Sphere(ST_FlipCoordinates(g.geom), ST_FlipCoordinates(ST_GeomFromGeoJSON(?))) <= ?');
    const [name, ...rest] = q.params;
    expect(name).toBe(LOC);
    expect(rest.slice(0, 4)).toEqual(boundingBox(139.767, 35.681, 1000));
    expect(rest.slice(4)).toEqual([JSON.stringify(point), 1000, 20, 0]);
  });

  it('falls back to a scan for near;minDistance, which no box can prefilter', () => {
    const q = lowerEntityQuery({ geo: { georel: 'near', minDistance: 1000, geometry: point, geoproperty: LOC }, limit: 1, offset: 0 });
    expect(q.sql).not.toContain('WITH geo');
    expect(q.sql).toContain('>= ?');
  });

  it.each([
    ['within', 'ST_Within(g.geom, ST_GeomFromGeoJSON(?))'],
    ['contains', 'ST_Contains(g.geom, ST_GeomFromGeoJSON(?))'],
    ['intersects', 'ST_Intersects(g.geom, ST_GeomFromGeoJSON(?))'],
    ['equals', 'ST_Equals(g.geom, ST_GeomFromGeoJSON(?))'],
    ['overlaps', 'ST_Overlaps(g.geom, ST_GeomFromGeoJSON(?))'],
  ] as const)('lowers %s into the R-tree CTE', (georel, fragment) => {
    const q = lowerEntityQuery({ geo: { georel, geometry: point, geoproperty: 'p' }, limit: 1, offset: 0 });
    expect(q.sql).toContain('WITH geo AS MATERIALIZED');
    expect(q.sql).toContain(fragment);
    expect(q.sql).toContain('e.eid IN (SELECT g.eid FROM geo g)');
  });

  it('lowers disjoint without the index', () => {
    const q = lowerEntityQuery({ geo: { georel: 'disjoint', geometry: point, geoproperty: 'p' }, limit: 1, offset: 0 });
    expect(q.sql).not.toContain('WITH geo');
    expect(q.sql).toContain('ST_Disjoint(g.geom, ST_GeomFromGeoJSON(?))');
  });

  it('combines type and geo with AND, CTE parameters first', () => {
    const q = lowerEntityQuery({ types: ['T'], geo: { georel: 'within', geometry: point, geoproperty: 'p' }, limit: 5, offset: 10 });
    expect(q.sql).toMatch(/FROM geo g\)\n  AND e\.id IN \(SELECT t\.entity_id/);
    expect(q.params).toEqual(['p', JSON.stringify(point), 'T', 5, 10]);
  });
});

describe('boundingBox', () => {
  it('contains the circle, with the longitude span widened by latitude', () => {
    const [minX, minY, maxX, maxY] = boundingBox(139.767, 35.681, 1000)!;
    // 1 km is 0.00899 deg of latitude, and 0.0111 deg of longitude at 35.7N.
    expect(maxY - 35.681).toBeGreaterThan(0.00899);
    expect(maxX - 139.767).toBeGreaterThan(0.0111);
    expect(maxX - 139.767).toBeLessThan(0.0114);
    expect(139.767 - minX).toBeCloseTo(maxX - 139.767, 10);
    expect(35.681 - minY).toBeCloseTo(maxY - 35.681, 10);
  });

  it('gives up near the poles', () => {
    expect(boundingBox(0, 89.99, 5000)).toBeNull();
  });
});

describe('renderSql', () => {
  it('inlines parameters for display, quoting strings', () => {
    expect(renderSql('a = ? AND b = ? AND c = ?', ["it's", 3, null])).toBe("a = 'it''s' AND b = 3 AND c = NULL");
  });
});
