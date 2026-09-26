# poc-duckdb-wasm-ngsi-ld

A minimal NGSI-LD context broker that runs entirely in the browser.
DuckDB-Wasm is both the storage and the query engine, the database file
lives in the Origin Private File System (OPFS), and GeoQueries run on the
DuckDB Spatial extension. There is no server, no Docker and no external
database: the app is a set of static files.

This is a proof of concept, not a conformant NGSI-LD implementation.

## Run

```sh
npm install
npm run dev          # http://localhost:5173
npm run build        # static files in dist/, serve them with any static host
npm run preview      # serve dist/ locally
```

Open the page, wait for `ready: opfs://ngsi-ld.duckdb`, then use the preset
buttons (POST three stations, query by type, query near Tokyo, ...) or type
a request into the console. From the devtools console:

```js
const broker = await window.broker;
const res = await broker.fetch(new Request('/ngsi-ld/v1/entities?type=Building', { headers: { Accept: 'application/ld+json' } }));
await res.json();
```

### Tests

```sh
npm test             # unit tests (vitest, Node): JSON-LD lowering and SQL lowering
npm run test:e2e     # end-to-end (Playwright, Chromium) against the production build
```

The end-to-end suite covers POST and GET round-trips, type queries, the
GeoQueries below, persistence across a page reload, and persistence across
closing and relaunching the browser with the same profile (OPFS restore).
It needs a Playwright Chromium (`npx playwright install chromium`) and
network access to `extensions.duckdb.org` (see Constraints).

## API

The broker is not an HTTP server. It is a Fetch-API-shaped function:

```ts
broker.fetch(request: Request): Promise<Response>
```

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/ngsi-ld/v1/entities` | `application/json` (context from the `Link` header, else core) or `application/ld+json` (`@context` in the body). `201` + `Location`, `409` if the id exists. |
| `GET` | `/ngsi-ld/v1/entities/{id}` | Normalized representation. `404` if missing. |
| `GET` | `/ngsi-ld/v1/entities?type=...` | Comma-separated types are OR-ed. `limit` (default 20, max 1000) and `offset`. |
| `GET` | `/ngsi-ld/v1/entities?georel=...&geometry=...&coordinates=...` | Optional `geoproperty` (default `location`). Combines with `type` by AND. |
| `DELETE` | `/ngsi-ld/v1/entities/{id}` | Added for the demo and tests. |

Responses are `application/json` with a `Link` header to the context, or
`application/ld+json` with `@context` in the body when the request's
`Accept` asks for it. Errors are NGSI-LD ProblemDetails
(`https://uri.etsi.org/ngsi-ld/errors/BadRequestData`, `AlreadyExists`,
`ResourceNotFound`, ...).

Supported `georel`: `near;maxDistance==<m>`, `near;minDistance==<m>`,
`within`, `contains`, `intersects`, `disjoint`, `equals`, `overlaps`.
Supported `geometry`: `Point`, `MultiPoint`, `LineString`,
`MultiLineString`, `Polygon`, `MultiPolygon`.

Supported attribute types: `Property`, `Relationship`, `GeoProperty`,
including multi-attributes distinguished by `datasetId`.

## Architecture

```
 page (main thread)                                 dedicated Worker
 ┌────────────────────────────────────────────┐    ┌───────────────────────┐
 │ broker.fetch(Request) ── src/broker.ts     │    │ DuckDB-Wasm (1.4.3)   │
 │   routing, content negotiation, errors     │    │  + spatial extension  │
 │        │                                   │    │                       │
 │        ├─ src/ngsi.ts   jsonld.expand /    │    │  opfs://ngsi-ld.duckdb│
 │        │                jsonld.compact     │SQL │  (sync access handle) │
 │        ├─ src/lower.ts  query -> SQL  ─────┼───▶│                       │
 │        └─ src/store.ts  canonical tables ──┼───▶│                       │
 └────────────────────────────────────────────┘    └───────────────────────┘
```

JSON-LD. Expansion and compaction are done by the
[`jsonld`](https://github.com/digitalbazaar/jsonld.js) library. The
NGSI-LD core context v1.8 is bundled (`src/contexts/`) and served by a
custom document loader, so the broker works offline; other remote
contexts are fetched and cached. The user context is placed before the
core context so the protected core terms always win.

Canonical tables. An entity is expanded and then walked into rows
keyed by expanded IRIs, so `Building` under two different contexts is
two different types:

```sql
entities     (id PRIMARY KEY, created_at, modified_at)
entity_types (entity_id, type)                    -- expanded IRI, one row per type
attributes   (entity_id, name, dataset_id,        -- name: expanded IRI
              attr_type,                          -- Property | Relationship | GeoProperty
              value JSON,                         -- expanded ngsi-ld:hasValue
              object VARCHAR,                     -- Relationship target
              geom GEOMETRY,                      -- GeoProperty value
              instance JSON)                      -- whole expanded attribute instance
```

`geom` is filled by compacting the expanded GeoJSON back to plain GeoJSON
with the core context and passing it to `ST_GeomFromGeoJSON`. `instance`
keeps the expanded attribute (sub-properties such as `unitCode`
included), so a GET rebuilds the expanded entity and compacts it with the
requester's context; the result equals the POSTed body.

Query lowering. `lower.ts` turns query parameters into a parameterised
`SELECT e.id FROM entities e WHERE ...`: one `EXISTS` over `entity_types`
for `type`, one `EXISTS` over `attributes` for the GeoQuery, for example

```sql
EXISTS (SELECT 1 FROM attributes a
        WHERE a.entity_id = e.id AND a.name = ? AND a.geom IS NOT NULL
          AND ST_Within(a.geom, ST_GeomFromGeoJSON(?)))
```

`near` lowers to
`ST_Distance_Sphere(ST_FlipCoordinates(a.geom), ST_FlipCoordinates(query)) <= ?`.
DuckDB's `ST_Distance_Sphere` assumes `[lat, lon]` axis order while
GeoJSON is `[lon, lat]`; without the flip, Tokyo to Shinjuku Station
comes out as 7.49 km instead of 6.13 km. The store then loads the matching
entities with that query as a CTE.

Persistence. Each write runs in a transaction followed by
`CHECKPOINT`, so the OPFS `.duckdb` file is self-contained after every
request.

Service Worker. The broker cannot run inside a Service Worker:
DuckDB-Wasm needs a dedicated Worker and OPFS sync access handles are only
available in dedicated Workers, neither of which a Service Worker can
create. Because the API is `Request -> Response`, a Service Worker can
still expose it at real URLs by relaying: intercept `/ngsi-ld/v1/*` in
`fetch`, post the request to a client page that owns the broker, and
answer with the `Response` it sends back. This relay is not implemented.

## Constraints

- duckdb-wasm is pinned to 1.32.0 (DuckDB 1.4.3).
  1.33.1-dev57.0 (DuckDB 1.5.4) opens `opfs://` databases but logs
  `Buffering missing file: opfs:/...` and keeps the data in memory: the
  OPFS files stay at 0 bytes and nothing survives a restart.
- The spatial extension is downloaded at startup from
  `extensions.duckdb.org` by `INSTALL spatial; LOAD spatial`. Everything
  else is static and local, but the first load (and any load the HTTP
  cache does not cover) needs network access. Self-hosting the extension
  under the app's origin with `custom_extension_repository` would remove
  this; not done here.
- One tab per origin. A second tab fails to open the database with
  `Access Handles cannot be created if there is another open Access Handle`.
- `near` matches Point attributes only, and the query geometry for
  `near` must be a `Point`.
- No spatial index: GeoQueries scan the `attributes` table.
- A single connection is shared and requests are serialised.
- Not implemented: update/patch/append, attribute projection (`attrs`),
  `q`, `id`/`idPattern`, `options=keyValues|sysAttrs`, `count`,
  batch operations, `LanguageProperty`/`JsonProperty`/`VocabProperty`,
  `@json` values (JSON object values are expanded as JSON-LD nodes like
  any other object).

## Non-goals

Subscriptions, the temporal API, federation and context source
registration, multi-tenancy, full NGSI-LD v1.9.1 conformance, and a
home-made JSON-LD processor.
