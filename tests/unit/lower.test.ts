import { describe, expect, it } from 'vitest';
import { lowerEntityQuery, parseGeoQuery } from '../../src/lower';

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
  ])('rejects %s', (s) => {
    expect(() => parseGeoQuery(params(s))).toThrow(expect.objectContaining({ status: 400 }));
  });
});

describe('lowerEntityQuery', () => {
  it('lowers a type query to a parameterised EXISTS', () => {
    const { sql, params } = lowerEntityQuery({ types: ['https://ex.org/A', 'https://ex.org/B'], limit: 20, offset: 0 });
    expect(sql).toContain('FROM entity_types t WHERE t.entity_id = e.id AND t.type IN (?, ?)');
    expect(params).toEqual(['https://ex.org/A', 'https://ex.org/B', 20, 0]);
  });

  it('lowers near;maxDistance to a spherical distance on flipped coordinates', () => {
    const { sql, params } = lowerEntityQuery({
      geo: {
        georel: 'near',
        maxDistance: 2000,
        geometry: { type: 'Point', coordinates: [139.767, 35.681] },
        geoproperty: 'https://uri.etsi.org/ngsi-ld/location',
      },
      limit: 20,
      offset: 0,
    });
    // ST_Distance_Sphere takes [lat, lon]; NGSI-LD/GeoJSON is [lon, lat].
    expect(sql).toContain('ST_Distance_Sphere(ST_FlipCoordinates(a.geom), ST_FlipCoordinates(ST_GeomFromGeoJSON(?))) <= ?');
    expect(params).toEqual([
      'https://uri.etsi.org/ngsi-ld/location',
      '{"type":"Point","coordinates":[139.767,35.681]}',
      2000,
      20,
      0,
    ]);
  });

  it.each([
    ['within', 'ST_Within(a.geom, ST_GeomFromGeoJSON(?))'],
    ['contains', 'ST_Contains(a.geom, ST_GeomFromGeoJSON(?))'],
    ['intersects', 'ST_Intersects(a.geom, ST_GeomFromGeoJSON(?))'],
    ['disjoint', 'ST_Disjoint(a.geom, ST_GeomFromGeoJSON(?))'],
    ['equals', 'ST_Equals(a.geom, ST_GeomFromGeoJSON(?))'],
    ['overlaps', 'ST_Overlaps(a.geom, ST_GeomFromGeoJSON(?))'],
  ] as const)('lowers %s', (georel, fragment) => {
    const { sql } = lowerEntityQuery({
      geo: { georel, geometry: { type: 'Point', coordinates: [0, 0] }, geoproperty: 'p' },
      limit: 1,
      offset: 0,
    });
    expect(sql).toContain(fragment);
  });

  it('combines type and geo with AND', () => {
    const { sql } = lowerEntityQuery({
      types: ['T'],
      geo: { georel: 'within', geometry: { type: 'Point', coordinates: [0, 0] }, geoproperty: 'p' },
      limit: 1,
      offset: 0,
    });
    expect(sql).toMatch(/t\.type IN \(\?\)\)\s+AND EXISTS/);
  });
});
