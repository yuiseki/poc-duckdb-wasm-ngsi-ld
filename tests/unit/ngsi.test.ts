import { describe, expect, it } from 'vitest';
import { compactEntity, contextFromLinkHeader, expandEntity, expandTypeTerm, expandAttrTerm, CORE_CONTEXT_URL } from '../../src/ngsi';

const building = {
  id: 'urn:ngsi-ld:Building:tokyo-station',
  type: 'Building',
  name: { type: 'Property', value: 'Tokyo Station' },
  height: { type: 'Property', value: 46.1, unitCode: 'MTR' },
  owner: { type: 'Relationship', object: 'urn:ngsi-ld:Organization:jr-east' },
  location: { type: 'GeoProperty', value: { type: 'Point', coordinates: [139.767, 35.681] } },
};

describe('expandEntity', () => {
  it('lowers an entity to canonical rows with expanded IRIs', async () => {
    const e = await expandEntity(building, []);
    expect(e.id).toBe('urn:ngsi-ld:Building:tokyo-station');
    expect(e.types).toEqual(['https://uri.etsi.org/ngsi-ld/default-context/Building']);
    const byName = Object.fromEntries(e.attributes.map((a) => [a.name, a]));

    const name = byName['https://uri.etsi.org/ngsi-ld/default-context/name'];
    expect(name.attrType).toBe('Property');
    expect(name.value).toEqual([{ '@value': 'Tokyo Station' }]);

    const owner = byName['https://uri.etsi.org/ngsi-ld/default-context/owner'];
    expect(owner.attrType).toBe('Relationship');
    expect(owner.object).toBe('urn:ngsi-ld:Organization:jr-east');

    const location = byName['https://uri.etsi.org/ngsi-ld/location'];
    expect(location.attrType).toBe('GeoProperty');
    expect(location.geojson).toEqual({ type: 'Point', coordinates: [139.767, 35.681] });
  });

  it('keeps datasetId so multi-attributes are separate rows', async () => {
    const e = await expandEntity(
      {
        id: 'urn:ngsi-ld:Sensor:1',
        type: 'Sensor',
        temperature: [
          { type: 'Property', value: 20 },
          { type: 'Property', value: 21, datasetId: 'urn:ngsi-ld:Dataset:b' },
        ],
      },
      [],
    );
    expect(e.attributes.map((a) => a.datasetId)).toEqual([null, 'urn:ngsi-ld:Dataset:b']);
  });

  it('honours a user @context', async () => {
    const e = await expandEntity(building, [{ Building: 'https://smartdatamodels.org/dataModel.Building/Building' }]);
    expect(e.types).toEqual(['https://smartdatamodels.org/dataModel.Building/Building']);
  });

  it('rejects entities without id or type', async () => {
    await expect(expandEntity({ type: 'Building' }, [])).rejects.toMatchObject({ status: 400 });
    await expect(expandEntity({ id: 'urn:ngsi-ld:X:1' }, [])).rejects.toMatchObject({ status: 400 });
  });

  it('rejects a GeoProperty whose value is not GeoJSON', async () => {
    await expect(
      expandEntity({ id: 'urn:x:1', type: 'T', location: { type: 'GeoProperty', value: 'here' } }, []),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe('compactEntity', () => {
  it('round-trips an expanded entity back to the input', async () => {
    const e = await expandEntity(building, []);
    const out = await compactEntity(e, []);
    expect(out).toEqual({ '@context': CORE_CONTEXT_URL, ...building });
  });

  it('round-trips with a user context', async () => {
    const ctx = [{ Building: 'https://smartdatamodels.org/dataModel.Building/Building' }];
    const e = await expandEntity(building, ctx);
    const out = await compactEntity(e, ctx);
    expect(out.type).toBe('Building');
  });
});

describe('terms', () => {
  it('expands type and attribute terms like the entity body does', async () => {
    expect(await expandTypeTerm('Building', [])).toBe('https://uri.etsi.org/ngsi-ld/default-context/Building');
    expect(await expandTypeTerm('https://example.org/B', [])).toBe('https://example.org/B');
    expect(await expandAttrTerm('location', [])).toBe('https://uri.etsi.org/ngsi-ld/location');
    expect(await expandAttrTerm('area', [])).toBe('https://uri.etsi.org/ngsi-ld/default-context/area');
  });
});

describe('contextFromLinkHeader', () => {
  it('reads the JSON-LD context link', () => {
    expect(
      contextFromLinkHeader('<https://example.org/ctx.jsonld>; rel="http://www.w3.org/ns/json-ld#context"; type="application/ld+json"'),
    ).toEqual(['https://example.org/ctx.jsonld']);
    expect(contextFromLinkHeader(null)).toEqual([]);
    expect(contextFromLinkHeader('<https://example.org/x>; rel="next"')).toEqual([]);
  });
});
