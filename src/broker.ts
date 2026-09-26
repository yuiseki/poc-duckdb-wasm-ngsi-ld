// A minimal NGSI-LD context broker exposed as a Fetch-API-shaped function:
// broker.fetch(Request) -> Promise<Response>. No HTTP server is involved.
import type { AsyncDuckDB } from '@duckdb/duckdb-wasm';
import { NgsiError, badRequest } from './errors';
import { lowerEntityQuery, parseGeoQuery, renderSql, type EntityQuery } from './lower';
import {
  CORE_CONTEXT_URL,
  compactEntity,
  contextFromLinkHeader,
  expandAttrTerm,
  expandEntity,
  expandTypeTerm,
  userContextFromBody,
  type UserContext,
} from './ngsi';
import { Store, type StoredEntity } from './store';

const BASE = '/ngsi-ld/v1/entities';
const BATCH_CREATE = '/ngsi-ld/v1/entityOperations/create';
const JSONLD = 'application/ld+json';
const GEOJSON = 'application/geo+json';
export const MAX_LIMIT = 100_000;

/**
 * Debugging aids, all carried in headers so they never change a response body:
 * - every query response has X-Lowered-SQL (the SQL with parameters inlined,
 *   percent-encoded) and Server-Timing (sql, count and total durations);
 * - a query request with `X-Explain: 1` also gets X-Query-Plan, DuckDB's EXPLAIN
 *   of that SQL, percent-encoded.
 */
export const HEADER_SQL = 'X-Lowered-SQL';
export const HEADER_PLAN = 'X-Query-Plan';
export const HEADER_EXPLAIN = 'X-Explain';

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
    } else if (url.pathname === BATCH_CREATE) {
      if (req.method === 'POST') return this.batchCreate(req);
    } else {
      throw new NgsiError(404, 'ResourceNotFound', `no such endpoint ${url.pathname}`);
    }
    throw new NgsiError(405, 'OperationNotSupported', `${req.method} ${url.pathname}`);
  }

  /** Parse a JSON body and work out the @context it is to be read with. */
  private async readBody(req: Request): Promise<{ body: unknown; contentType: string; linkContext: UserContext }> {
    const contentType = mediaType(req.headers.get('Content-Type'));
    if (contentType !== 'application/json' && contentType !== JSONLD) {
      throw new NgsiError(415, 'InvalidRequest', 'Content-Type must be application/json or application/ld+json');
    }
    if (contentType === JSONLD && req.headers.get('Link')) throw badRequest('application/ld+json must not carry a Link header');
    try {
      return { body: await req.json(), contentType, linkContext: contextFromLinkHeader(req.headers.get('Link')) };
    } catch {
      throw new NgsiError(400, 'InvalidRequest', 'request body is not valid JSON');
    }
  }

  /** Expand one entity body and compact it once with the core context for storage. */
  private async toStored(body: unknown, contentType: string, linkContext: UserContext): Promise<StoredEntity> {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('an entity must be a JSON object');
    const hasBodyContext = '@context' in body;
    let context: UserContext;
    if (contentType === JSONLD) {
      if (!hasBodyContext) throw badRequest('application/ld+json requires @context in the body');
      context = userContextFromBody((body as any)['@context']);
    } else {
      if (hasBodyContext) throw badRequest('application/json must not carry @context; use a Link header');
      context = linkContext;
    }
    const entity = await expandEntity(body as Record<string, unknown>, context);
    const { '@context': _, ...doc } = await compactEntity(entity, []);
    return { ...entity, doc };
  }

  private async create(req: Request): Promise<Response> {
    const { body, contentType, linkContext } = await this.readBody(req);
    const entity = await this.toStored(body, contentType, linkContext);
    const { conflicts } = await this.store.insertMany([entity]);
    if (conflicts.length) throw new NgsiError(409, 'AlreadyExists', `entity ${entity.id} already exists`);
    return new Response(null, { status: 201, headers: { Location: `${BASE}/${encodeURIComponent(entity.id)}` } });
  }

  /** POST /entityOperations/create: 201 with the ids if all were created, else 207 with a BatchOperationResult. */
  private async batchCreate(req: Request): Promise<Response> {
    const { body, contentType, linkContext } = await this.readBody(req);
    if (!Array.isArray(body)) throw badRequest('batch create expects a JSON array of entities');
    const errors: { entityId: string; error: Record<string, unknown> }[] = [];
    const entities: StoredEntity[] = [];
    for (const item of body) {
      try {
        entities.push(await this.toStored(item, contentType, linkContext));
      } catch (e) {
        if (!(e instanceof NgsiError)) throw e;
        errors.push({ entityId: String((item as any)?.id ?? ''), error: problem(e) });
      }
    }
    const { created, conflicts } = await this.store.insertMany(entities);
    for (const id of conflicts) errors.push({ entityId: id, error: problem(new NgsiError(409, 'AlreadyExists', `entity ${id} already exists`)) });
    if (!errors.length) return Response.json(created, { status: 201 });
    return Response.json({ success: created, errors }, { status: 207 });
  }

  private async retrieve(req: Request, id: string): Promise<Response> {
    const docs = await this.load(req, 'SELECT id FROM entities WHERE id = ?', [id]);
    if (!docs.value.length) throw new NgsiError(404, 'ResourceNotFound', `entity ${id} not found`);
    return this.respond(req, docs.value, false);
  }

  private async remove(id: string): Promise<Response> {
    if (!(await this.store.delete(id))) throw new NgsiError(404, 'ResourceNotFound', `entity ${id} not found`);
    return new Response(null, { status: 204 });
  }

  private async query(req: Request, params: URLSearchParams): Promise<Response> {
    const started = performance.now();
    const context = contextFromLinkHeader(req.headers.get('Link'));
    const q: EntityQuery = { limit: intParam(params, 'limit', 20, MAX_LIMIT), offset: intParam(params, 'offset', 0) };

    const type = params.get('type');
    if (type) q.types = await Promise.all(type.split(',').map((t) => expandTypeTerm(t.trim(), context)));
    const geo = parseGeoQuery(params);
    if (geo) q.geo = { ...geo, geoproperty: await expandAttrTerm(geo.geoproperty, context) };
    const geoproperty = geo?.geoproperty ?? 'location';

    // pick (NGSI-LD 1.8 projection). pick=id alone is answered from the id query
    // without loading any document.
    const pick = params.get('pick')?.split(',').map((a) => a.trim()).filter(Boolean);
    const lowered = lowerEntityQuery(q);
    let docs: { value: Record<string, any>[]; sqlMs: number };
    if (pick?.length === 1 && pick[0] === 'id') {
      const ids = await this.store.selectIds(lowered.sql, lowered.params);
      docs = { value: ids.value.map((id) => ({ id })), sqlMs: ids.sqlMs };
    } else {
      docs = await this.load(req, lowered.sql, lowered.params);
      if (pick) docs.value = docs.value.map((d) => Object.fromEntries(Object.entries(d).filter(([k]) => pick.includes(k))));
    }
    const headers: Record<string, string> = { [HEADER_SQL]: encodeURIComponent(renderSql(lowered.sql, lowered.params)) };
    const timing = [`sql;dur=${docs.sqlMs.toFixed(1)}`];
    if (params.get('count') === 'true') {
      if (q.offset === 0 && docs.value.length < q.limit) {
        // Everything that matched is already in hand.
        headers['NGSILD-Results-Count'] = String(docs.value.length);
      } else {
        const count = await this.store.count(lowered.countSql, lowered.countParams);
        headers['NGSILD-Results-Count'] = String(count.value);
        timing.push(`count;dur=${count.sqlMs.toFixed(1)}`);
      }
    }
    if (req.headers.get(HEADER_EXPLAIN) === '1') {
      headers[HEADER_PLAN] = encodeURIComponent(await this.store.explain(lowered.sql, lowered.params));
    }
    const res = await this.respond(req, docs.value, true, geoproperty);
    timing.push(`total;dur=${(performance.now() - started).toFixed(1)}`);
    headers['Server-Timing'] = timing.join(', ');
    for (const [k, v] of Object.entries(headers)) res.headers.set(k, v);
    return res;
  }

  /**
   * Load the selected entities compacted with the requester's context. With the
   * core context, which is the common case, the document stored at write time is
   * returned as is; any other context goes through jsonld.compact again.
   */
  private async load(req: Request, sql: string, params: unknown[]) {
    const context = contextFromLinkHeader(req.headers.get('Link'));
    if (!context.length) return this.store.selectDocs(sql, params);
    const rows = await this.store.select(sql, params);
    const value = await Promise.all(
      rows.value.map(async (e) => {
        const { '@context': _, ...doc } = await compactEntity(e, context);
        return doc;
      }),
    );
    return { value, sqlMs: rows.sqlMs };
  }

  /** Render as JSON, JSON-LD or GeoJSON according to the Accept header. */
  private async respond(req: Request, docs: Record<string, any>[], asList: boolean, geoproperty = 'location'): Promise<Response> {
    const context = contextFromLinkHeader(req.headers.get('Link'));
    const accept = req.headers.get('Accept') ?? '';
    const contextUrl = typeof context[0] === 'string' ? context[0] : CORE_CONTEXT_URL;
    const link = `<${contextUrl}>; rel="http://www.w3.org/ns/json-ld#context"; type="application/ld+json"`;
    if (accept.includes(GEOJSON)) {
      const features = docs.map((doc) => ({ id: doc.id, type: 'Feature', geometry: doc[geoproperty]?.value ?? null, properties: doc }));
      const body = asList ? { type: 'FeatureCollection', features } : features[0];
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': GEOJSON, Link: link } });
    }
    if (accept.includes(JSONLD)) {
      const ctx = context.length ? [...context, CORE_CONTEXT_URL] : CORE_CONTEXT_URL;
      const withContext = docs.map((doc) => ({ '@context': ctx, ...doc }));
      return new Response(JSON.stringify(asList ? withContext : withContext[0]), { status: 200, headers: { 'Content-Type': JSONLD } });
    }
    return new Response(JSON.stringify(asList ? docs : docs[0]), { status: 200, headers: { 'Content-Type': 'application/json', Link: link } });
  }
}

const mediaType = (h: string | null) => (h ?? '').split(';')[0].trim().toLowerCase();

const problem = (e: NgsiError) => ({ type: `https://uri.etsi.org/ngsi-ld/errors/${e.problem}`, title: e.problem, detail: e.detail });

function intParam(params: URLSearchParams, name: string, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  const raw = params.get(name);
  if (raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > max) throw badRequest(`${name} must be an integer between 0 and ${max}`);
  return n;
}
