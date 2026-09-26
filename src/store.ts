// Canonical table representation of NGSI-LD entities in DuckDB.
import type { AsyncDuckDB, AsyncDuckDBConnection } from '@duckdb/duckdb-wasm';
import type { CanonicalAttribute, CanonicalEntity } from './ngsi';

const SCHEMA = `
CREATE SEQUENCE IF NOT EXISTS entity_eid;
CREATE TABLE IF NOT EXISTS entities (
  id          VARCHAR PRIMARY KEY,
  eid         INTEGER NOT NULL DEFAULT nextval('entity_eid'),  -- compact key for geometries
  created_at  TIMESTAMPTZ NOT NULL,
  modified_at TIMESTAMPTZ NOT NULL,
  doc         JSON NOT NULL           -- normalized representation, compacted with the core context
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
  instance   JSON NOT NULL            -- whole expanded attribute instance
);
-- One row per GeoProperty instance. Kept narrow and keyed by an integer because every
-- row an R-tree lookup returns is fetched one by one, and that fetch is the cost.
CREATE TABLE IF NOT EXISTS geometries (
  eid  INTEGER NOT NULL,
  name VARCHAR NOT NULL,              -- expanded IRI of the GeoProperty
  geom GEOMETRY NOT NULL
);
CREATE INDEX IF NOT EXISTS geometries_rtree ON geometries USING RTREE (geom);
`;

export interface StoredEntity {
  id: string;
  types: string[];
  attributes: CanonicalAttribute[];
  doc: Record<string, unknown>; // compacted with the core context, without @context
}

export interface Timed<T> {
  value: T;
  sqlMs: number; // time spent in DuckDB, including the round trip to its worker
}

export class Store {
  private queue: Promise<unknown> = Promise.resolve();
  private staged = 0;

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
      // A failed COMMIT has already ended the transaction; report the original error.
      await this.conn.query('ROLLBACK').catch(() => undefined);
      throw err;
    }
    await this.conn.query('CHECKPOINT');
  }

  /** Register rows as an in-memory NDJSON file and return a read_json() over it. */
  private async stage(files: string[], rows: unknown[], columns: string): Promise<string> {
    const name = `stage-${++this.staged}.ndjson`;
    files.push(name);
    await this.db.registerFileText(name, rows.map((r) => JSON.stringify(r)).join('\n'));
    return `read_json('${name}', format = 'newline_delimited', columns = {${columns}})`;
  }

  /**
   * Insert entities in bulk. Entities whose id already exists, in the table or
   * earlier in the same batch, are skipped and reported as conflicts.
   */
  insertMany(entities: StoredEntity[]): Promise<{ created: string[]; conflicts: string[] }> {
    return this.exclusive(async () => {
      const files: string[] = [];
      try {
        const seen = new Set<string>();
        const conflicts: string[] = [];
        let batch = entities.filter((e) => (seen.has(e.id) ? (conflicts.push(e.id), false) : seen.add(e.id)));
        if (!batch.length) return { created: [], conflicts };

        const ids = await this.stage(files, batch.map((e) => ({ id: e.id })), "id: 'VARCHAR'");
        const existing = new Set((await this.all(`SELECT s.id FROM ${ids} s JOIN entities e ON e.id = s.id`)).map((r) => r.id as string));
        conflicts.push(...existing);
        batch = batch.filter((e) => !existing.has(e.id));
        if (!batch.length) return { created: [], conflicts };

        const now = new Date().toISOString();
        const docs = await this.stage(files, batch.map((e) => ({ id: e.id, doc: e.doc })), "id: 'VARCHAR', doc: 'JSON'");
        const types = await this.stage(
          files,
          batch.flatMap((e) => e.types.map((type) => ({ entity_id: e.id, type }))),
          "entity_id: 'VARCHAR', type: 'VARCHAR'",
        );
        const attributes = await this.stage(
          files,
          batch.flatMap((e) =>
            e.attributes.map((a) => ({
              entity_id: e.id,
              name: a.name,
              dataset_id: a.datasetId,
              attr_type: a.attrType,
              value: a.value,
              object: a.object,
              instance: a.instance,
            })),
          ),
          "entity_id: 'VARCHAR', name: 'VARCHAR', dataset_id: 'VARCHAR', attr_type: 'VARCHAR', value: 'JSON', object: 'VARCHAR', instance: 'JSON'",
        );
        const geometries = await this.stage(
          files,
          batch.flatMap((e) =>
            e.attributes.filter((a) => a.geojson).map((a) => ({ entity_id: e.id, name: a.name, geojson: JSON.stringify(a.geojson) })),
          ),
          "entity_id: 'VARCHAR', name: 'VARCHAR', geojson: 'VARCHAR'",
        );
        await this.transaction(async () => {
          await this.all(
            `INSERT INTO entities (id, created_at, modified_at, doc) SELECT id, ?::TIMESTAMPTZ, ?::TIMESTAMPTZ, doc FROM ${docs}`,
            [now, now],
          );
          await this.all(`INSERT INTO entity_types SELECT entity_id, type FROM ${types}`);
          await this.all(`INSERT INTO attributes SELECT * FROM ${attributes}`);
          await this.all(
            `INSERT INTO geometries SELECT e.eid, g.name, ST_GeomFromGeoJSON(g.geojson) FROM ${geometries} g JOIN entities e ON e.id = g.entity_id`,
          );
        });
        return { created: batch.map((e) => e.id), conflicts };
      } finally {
        if (files.length) await this.db.dropFiles(files);
      }
    });
  }

  delete(id: string): Promise<boolean> {
    return this.exclusive(async () => {
      if (!(await this.all('SELECT 1 FROM entities WHERE id = ?', [id])).length) return false;
      await this.transaction(async () => {
        await this.all('DELETE FROM geometries WHERE eid = (SELECT eid FROM entities WHERE id = ?)', [id]);
        for (const table of ['attributes', 'entity_types']) await this.all(`DELETE FROM ${table} WHERE entity_id = ?`, [id]);
        await this.all('DELETE FROM entities WHERE id = ?', [id]);
      });
      return true;
    });
  }

  /** The ids selected by `idSql`, in order, without touching the documents. */
  selectIds(idSql: string, params: unknown[]): Promise<Timed<string[]>> {
    return this.timed(async () => (await this.all(idSql, params)).map((r) => r.id as string));
  }

  /** The stored core-context documents of the entities selected by `idSql`, in id order. */
  selectDocs(idSql: string, params: unknown[]): Promise<Timed<Record<string, any>[]>> {
    return this.timed(async () => {
      const rows = await this.all(
        `WITH hits AS (${idSql}) SELECT e.doc::VARCHAR AS doc FROM hits h JOIN entities e ON e.id = h.id ORDER BY e.id`,
        params,
      );
      return rows.map((r) => JSON.parse(r.doc));
    });
  }

  /** The canonical rows of the entities selected by `idSql`, for compaction with another context. */
  select(idSql: string, params: unknown[]): Promise<Timed<CanonicalEntity[]>> {
    return this.timed(async () => {
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

  count(countSql: string, params: unknown[]): Promise<Timed<number>> {
    return this.timed(async () => Number((await this.all(countSql, params))[0].n));
  }

  /** EXPLAIN a query and return DuckDB's rendered physical plan. */
  explain(sql: string, params: unknown[]): Promise<string> {
    return this.exclusive(async () => (await this.all(`EXPLAIN ${sql}`, params)).map((r) => r.explain_value).join('\n'));
  }

  private timed<T>(fn: () => Promise<T>): Promise<Timed<T>> {
    return this.exclusive(async () => {
      const t = performance.now();
      const value = await fn();
      return { value, sqlMs: performance.now() - t };
    });
  }
}
