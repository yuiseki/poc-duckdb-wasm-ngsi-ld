// A minimal NGSI-LD context broker exposed as a Fetch-API-shaped function:
// broker.fetch(Request) -> Promise<Response>. No HTTP server is involved.
import type { AsyncDuckDB } from '@duckdb/duckdb-wasm';
import { NgsiError, badRequest } from './errors';
import { lowerEntityQuery, parseGeoQuery, type EntityQuery } from './lower';
import {
  CORE_CONTEXT_URL,
  compactEntity,
  contextFromLinkHeader,
  expandAttrTerm,
  expandEntity,
  expandTypeTerm,
  userContextFromBody,
  type CanonicalEntity,
  type UserContext,
} from './ngsi';
import { Store } from './store';

const BASE = '/ngsi-ld/v1/entities';
const JSONLD = 'application/ld+json';

export class Broker {
  private constructor(readonly store: Store) {}

  static async open(db: AsyncDuckDB): Promise<Broker> {
    return new Broker(await Store.open(db));
  }

  async fetch(input: Request | string, init?: RequestInit): Promise<Response> {
    const req = input instanceof Request ? input : new Request(new URL(input, 'http://broker.invalid'), init);
    try {
      return await this.route(req);
    } catch (e) {
      if (e instanceof NgsiError) return e.toResponse();
      console.error(e);
      return new NgsiError(500, 'InternalError', (e as Error).message).toResponse();
    }
  }

  private async route(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === BASE || url.pathname === `${BASE}/`) {
      if (req.method === 'POST') return this.create(req);
      if (req.method === 'GET') return this.query(req, url.searchParams);
    } else if (url.pathname.startsWith(`${BASE}/`)) {
      const id = decodeURIComponent(url.pathname.slice(BASE.length + 1));
      if (req.method === 'GET') return this.retrieve(req, id);
      if (req.method === 'DELETE') return this.remove(id);
    } else {
      throw new NgsiError(404, 'ResourceNotFound', `no such endpoint ${url.pathname}`);
    }
    throw new NgsiError(405, 'OperationNotSupported', `${req.method} ${url.pathname}`);
  }

  private async create(req: Request): Promise<Response> {
    const contentType = mediaType(req.headers.get('Content-Type'));
    if (contentType !== 'application/json' && contentType !== JSONLD) {
      throw new NgsiError(415, 'InvalidRequest', 'Content-Type must be application/json or application/ld+json');
    }
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      throw new NgsiError(400, 'InvalidRequest', 'request body is not valid JSON');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('request body must be a JSON object');

    const hasBodyContext = '@context' in body;
    let context: UserContext;
    if (contentType === JSONLD) {
      if (!hasBodyContext) throw badRequest('application/ld+json requires @context in the body');
      context = userContextFromBody((body as any)['@context']);
    } else {
      if (hasBodyContext) throw badRequest('application/json must not carry @context; use a Link header');
      context = contextFromLinkHeader(req.headers.get('Link'));
    }

    const entity = await expandEntity(body as Record<string, unknown>, context);
    if (!(await this.store.insert(entity))) throw new NgsiError(409, 'AlreadyExists', `entity ${entity.id} already exists`);
    return new Response(null, { status: 201, headers: { Location: `${BASE}/${encodeURIComponent(entity.id)}` } });
  }

  private async retrieve(req: Request, id: string): Promise<Response> {
    const entity = await this.store.get(id);
    if (!entity) throw new NgsiError(404, 'ResourceNotFound', `entity ${id} not found`);
    return this.respond(req, [entity], false);
  }

  private async remove(id: string): Promise<Response> {
    if (!(await this.store.delete(id))) throw new NgsiError(404, 'ResourceNotFound', `entity ${id} not found`);
    return new Response(null, { status: 204 });
  }

  private async query(req: Request, params: URLSearchParams): Promise<Response> {
    const context = contextFromLinkHeader(req.headers.get('Link'));
    const q: EntityQuery = { limit: intParam(params, 'limit', 20, 1000), offset: intParam(params, 'offset', 0) };

    const type = params.get('type');
    if (type) q.types = await Promise.all(type.split(',').map((t) => expandTypeTerm(t.trim(), context)));
    const geo = parseGeoQuery(params);
    if (geo) q.geo = { ...geo, geoproperty: await expandAttrTerm(geo.geoproperty, context) };

    const { sql, params: sqlParams } = lowerEntityQuery(q);
    return this.respond(req, await this.store.select(sql, sqlParams), true);
  }

  /** Compact with the requester's context and pick JSON vs JSON-LD from the Accept header. */
  private async respond(req: Request, entities: CanonicalEntity[], asList: boolean): Promise<Response> {
    const context = contextFromLinkHeader(req.headers.get('Link'));
    const ld = (req.headers.get('Accept') ?? '').includes(JSONLD);
    const docs = await Promise.all(
      entities.map(async (e) => {
        const doc = await compactEntity(e, context);
        if (!ld) delete doc['@context'];
        return doc;
      }),
    );
    const headers: Record<string, string> = { 'Content-Type': ld ? JSONLD : 'application/json' };
    if (!ld) {
      const ctx = typeof context[0] === 'string' ? context[0] : CORE_CONTEXT_URL;
      headers.Link = `<${ctx}>; rel="http://www.w3.org/ns/json-ld#context"; type="application/ld+json"`;
    }
    return new Response(JSON.stringify(asList ? docs : docs[0]), { status: 200, headers });
  }
}

const mediaType = (h: string | null) => (h ?? '').split(';')[0].trim().toLowerCase();

function intParam(params: URLSearchParams, name: string, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  const raw = params.get(name);
  if (raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > max) throw badRequest(`${name} must be an integer between 0 and ${max}`);
  return n;
}
