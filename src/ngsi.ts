// NGSI-LD <-> canonical rows. All JSON-LD processing is delegated to the
// `jsonld` library; this module only walks its expanded form.
import jsonldLib from 'jsonld';
import coreContext from './contexts/ngsi-ld-core-context-v1.8.json';
import { badRequest } from './errors';

export const CORE_CONTEXT_URL = 'https://uri.etsi.org/ngsi-ld/v1/ngsi-ld-core-context-v1.8.jsonld';

const NGSI = 'https://uri.etsi.org/ngsi-ld/';
const HAS_VALUE = `${NGSI}hasValue`;
const HAS_OBJECT = `${NGSI}hasObject`;
const DATASET_ID = `${NGSI}datasetId`;
const ATTR_TYPES = ['Property', 'Relationship', 'GeoProperty'] as const;
export type AttrType = (typeof ATTR_TYPES)[number];

/** A user-supplied context: URLs and/or inline objects, without the core context. */
export type UserContext = (string | Record<string, unknown>)[];

export interface CanonicalAttribute {
  name: string; // expanded IRI
  datasetId: string | null;
  attrType: AttrType;
  value: unknown; // expanded ngsi-ld:hasValue, for Property and GeoProperty
  object: string | null; // Relationship target
  geojson: { type: string; coordinates: unknown } | null; // GeoProperty value as GeoJSON
  instance: Record<string, unknown>; // the whole expanded attribute instance, for round-trips
}

export interface CanonicalEntity {
  id: string;
  types: string[]; // expanded IRIs
  attributes: Pick<CanonicalAttribute, 'name' | 'instance'>[];
}

type Expanded = Record<string, any>;

// @types/jsonld does not model remote contexts or loaders well; type only what is used.
const jsonld = jsonldLib as unknown as {
  expand(doc: unknown, options: { documentLoader: typeof documentLoader }): Promise<Expanded[]>;
  compact(doc: unknown, ctx: unknown, options: { documentLoader: typeof documentLoader }): Promise<Expanded>;
};

// The core context is bundled so the broker works offline. Other remote
// contexts are fetched once and cached for the lifetime of the page.
const remoteContexts = new Map<string, Promise<unknown>>();
const documentLoader = async (url: string) => {
  if (url === CORE_CONTEXT_URL) return { contextUrl: undefined, document: coreContext, documentUrl: url };
  if (!remoteContexts.has(url)) {
    remoteContexts.set(
      url,
      fetch(url, { headers: { Accept: 'application/ld+json, application/json' } }).then((r) => {
        if (!r.ok) throw new Error(`failed to load @context ${url}: HTTP ${r.status}`);
        return r.json();
      }),
    );
  }
  try {
    return { contextUrl: undefined, document: await remoteContexts.get(url), documentUrl: url };
  } catch (e) {
    remoteContexts.delete(url);
    throw e;
  }
};

/** The effective context: the user's context with the core context last, so core terms win. */
export const effectiveContext = (user: UserContext) => (user.length ? [...user, CORE_CONTEXT_URL] : CORE_CONTEXT_URL);

export function contextFromLinkHeader(link: string | null): UserContext {
  if (!link) return [];
  const m = link.match(/<([^>]+)>\s*;[^,]*rel="?http:\/\/www\.w3\.org\/ns\/json-ld#context"?/);
  return m ? [m[1]] : [];
}

/** Normalise a body's `@context` into a user context, dropping the core context. */
export function userContextFromBody(ctx: unknown): UserContext {
  if (ctx === undefined) return [];
  const list = Array.isArray(ctx) ? ctx : [ctx];
  return list.filter((c) => c !== CORE_CONTEXT_URL) as UserContext;
}

async function expand(doc: Record<string, unknown>, user: UserContext): Promise<Expanded[]> {
  try {
    return await jsonld.expand({ ...doc, '@context': effectiveContext(user) }, { documentLoader });
  } catch (e) {
    throw badRequest(`JSON-LD expansion failed: ${(e as Error).message}`);
  }
}

export async function expandEntity(body: Record<string, unknown>, user: UserContext): Promise<{
  id: string;
  types: string[];
  attributes: CanonicalAttribute[];
}> {
  if (typeof body.id !== 'string' || !body.id) throw badRequest('entity id is required');
  if (body.type === undefined) throw badRequest('entity type is required');
  const { '@context': _ignored, ...doc } = body;
  const [node] = await expand(doc, user);
  if (!node?.['@id'] || !node['@type']?.length) throw badRequest('entity must have an id and a type');

  const attributes: CanonicalAttribute[] = [];
  for (const [name, instances] of Object.entries(node)) {
    if (name.startsWith('@')) continue;
    for (const instance of instances as Expanded[]) attributes.push(await toAttribute(name, instance));
  }
  return { id: node['@id'], types: node['@type'], attributes };
}

async function toAttribute(name: string, instance: Expanded): Promise<CanonicalAttribute> {
  const attrType = ATTR_TYPES.find((t) => instance['@type']?.includes(NGSI + t));
  if (!attrType) throw badRequest(`attribute ${name} must be a Property, Relationship or GeoProperty`);
  const attr: CanonicalAttribute = {
    name,
    datasetId: instance[DATASET_ID]?.[0]?.['@id'] ?? null,
    attrType,
    value: instance[HAS_VALUE] ?? null,
    object: null,
    geojson: null,
    instance,
  };
  if (attrType === 'Relationship') {
    attr.object = instance[HAS_OBJECT]?.[0]?.['@id'] ?? null;
    if (!attr.object) throw badRequest(`Relationship ${name} must have an object`);
  } else if (attr.value === null) {
    throw badRequest(`${attrType} ${name} must have a value`);
  }
  if (attrType === 'GeoProperty') attr.geojson = await toGeoJSON(name, instance[HAS_VALUE][0]);
  return attr;
}

/** Compact an expanded GeoJSON geometry node back to plain GeoJSON with the core context. */
async function toGeoJSON(name: string, node: Expanded): Promise<CanonicalAttribute['geojson']> {
  const { '@context': _c, ...geo } = await jsonld.compact(node, CORE_CONTEXT_URL, { documentLoader });
  if (typeof geo.type !== 'string' || !Array.isArray(geo.coordinates)) {
    throw badRequest(`GeoProperty ${name} value must be a GeoJSON geometry`);
  }
  return { type: geo.type, coordinates: geo.coordinates };
}

/** Rebuild the expanded entity from stored rows and compact it with the requester's context. */
export async function compactEntity(entity: CanonicalEntity, user: UserContext): Promise<Record<string, any>> {
  const node: Expanded = { '@id': entity.id, '@type': entity.types };
  for (const { name, instance } of entity.attributes) (node[name] ??= []).push(instance);
  return jsonld.compact(node, effectiveContext(user), { documentLoader });
}

/** Expand a type name the way `type` in an entity body is expanded. */
export async function expandTypeTerm(term: string, user: UserContext): Promise<string> {
  const [node] = await expand({ '@id': 'urn:x', type: term }, user);
  return node['@type'][0];
}

/** Expand an attribute name the way a key in an entity body is expanded. */
export async function expandAttrTerm(term: string, user: UserContext): Promise<string> {
  const [node] = await expand({ '@id': 'urn:x', [term]: { '@id': 'urn:y' } }, user);
  const key = Object.keys(node ?? {}).find((k) => !k.startsWith('@'));
  if (!key) throw badRequest(`cannot expand attribute name ${term}`);
  return key;
}
