// Canonical table representation of NGSI-LD entities in DuckDB.
import type { AsyncDuckDB, AsyncDuckDBConnection } from '@duckdb/duckdb-wasm';
import type { CanonicalAttribute, CanonicalEntity } from './ngsi';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS entities (
  id          VARCHAR PRIMARY KEY,
  created_at  TIMESTAMPTZ NOT NULL,
  modified_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS entity_types (
  entity_id VARCHAR NOT NULL,
  type      VARCHAR NOT NULL          -- expanded IRI
);
CREATE TABLE IF NOT EXISTS attributes (
  entity_id  VARCHAR NOT NULL,
  name       VARCHAR NOT NULL,        -- expanded IRI
  dataset_id VARCHAR,
  attr_type  VARCHAR NOT NULL,        -- Property | Relationship | GeoProperty
  value      JSON,                    -- expanded ngsi-ld:hasValue
  object     VARCHAR,                 -- Relationship target
  geom       GEOMETRY,                -- GeoProperty value
  instance   JSON NOT NULL            -- whole expanded attribute instance
);
`;

export class Store {
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(
    readonly db: AsyncDuckDB,
    private readonly conn: AsyncDuckDBConnection,
  ) {}

  static async open(db: AsyncDuckDB): Promise<Store> {
    const conn = await db.connect();
    await conn.query('INSTALL spatial; LOAD spatial;');
    await conn.query(SCHEMA);
    return new Store(db, conn);
  }

  /** Run `fn` exclusively: one connection is shared, so transactions must not interleave. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async all(sql: string, params: unknown[] = []): Promise<Record<string, any>[]> {
    const stmt = await this.conn.prepare(sql);
    try {
      return (await stmt.query(...params)).toArray().map((r) => r.toJSON());
    } finally {
      await stmt.close();
    }
  }

  /** Run `fn` in a transaction, then checkpoint so the OPFS .duckdb file is self-contained. */
  private async transaction(fn: () => Promise<void>): Promise<void> {
    await this.conn.query('BEGIN TRANSACTION');
    try {
      await fn();
      await this.conn.query('COMMIT');
    } catch (err) {
      await this.conn.query('ROLLBACK');
      throw err;
    }
    await this.conn.query('CHECKPOINT');
  }

  /** Insert an entity. Returns false if an entity with that id already exists. */
  insert(e: { id: string; types: string[]; attributes: CanonicalAttribute[] }): Promise<boolean> {
    return this.exclusive(async () => {
      if ((await this.all('SELECT 1 FROM entities WHERE id = ?', [e.id])).length) return false;
      await this.transaction(async () => {
        const now = new Date().toISOString();
        await this.all('INSERT INTO entities VALUES (?, ?::TIMESTAMPTZ, ?::TIMESTAMPTZ)', [e.id, now, now]);
        for (const t of e.types) await this.all('INSERT INTO entity_types VALUES (?, ?)', [e.id, t]);
        for (const a of e.attributes) {
          await this.all(
            `INSERT INTO attributes VALUES (?, ?, ?, ?, ?::JSON, ?, ${a.geojson ? 'ST_GeomFromGeoJSON(?)' : 'NULL'}, ?::JSON)`,
            [
              e.id,
              a.name,
              a.datasetId,
              a.attrType,
              a.value === null ? null : JSON.stringify(a.value),
              a.object,
              ...(a.geojson ? [JSON.stringify(a.geojson)] : []),
              JSON.stringify(a.instance),
            ],
          );
        }
      });
      return true;
    });
  }

  delete(id: string): Promise<boolean> {
    return this.exclusive(async () => {
      if (!(await this.all('SELECT 1 FROM entities WHERE id = ?', [id])).length) return false;
      await this.transaction(async () => {
        for (const table of ['attributes', 'entity_types']) await this.all(`DELETE FROM ${table} WHERE entity_id = ?`, [id]);
        await this.all('DELETE FROM entities WHERE id = ?', [id]);
      });
      return true;
    });
  }

  /** Load the entities whose ids are selected by `idSql` (e.g. from lowerEntityQuery), in id order. */
  select(idSql: string, params: unknown[]): Promise<CanonicalEntity[]> {
    return this.exclusive(async () => {
      const rows = await this.all(
        `WITH hits AS (${idSql})
         SELECT h.id,
           (SELECT to_json(list(t.type ORDER BY t.type)) FROM entity_types t WHERE t.entity_id = h.id)::VARCHAR AS types,
           (SELECT to_json(list({'name': a.name, 'instance': a.instance} ORDER BY a.name, a.dataset_id NULLS FIRST))
              FROM attributes a WHERE a.entity_id = h.id)::VARCHAR AS attributes
         FROM hits h ORDER BY h.id`,
        params,
      );
      return rows.map((r) => ({ id: r.id, types: JSON.parse(r.types), attributes: JSON.parse(r.attributes ?? '[]') ?? [] }));
    });
  }

  async get(id: string): Promise<CanonicalEntity | undefined> {
    return (await this.select('SELECT id FROM entities WHERE id = ?', [id]))[0];
  }
}
