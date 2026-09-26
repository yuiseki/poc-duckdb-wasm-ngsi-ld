import * as duckdb from '@duckdb/duckdb-wasm';
import mvpWasm from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url';
import mvpWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url';
import ehWasm from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url';
import ehWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url';

const BUNDLES: duckdb.DuckDBBundles = {
  mvp: { mainModule: mvpWasm, mainWorker: mvpWorker },
  eh: { mainModule: ehWasm, mainWorker: ehWorker },
};

/**
 * Open a DuckDB-Wasm database. `path` is either `:memory:` or an
 * `opfs://` path, in which case the database file lives in the
 * Origin Private File System and survives reloads and browser restarts.
 */
export async function openDuckDB(path: string): Promise<duckdb.AsyncDuckDB> {
  const bundle = await duckdb.selectBundle(BUNDLES);
  const worker = new Worker(bundle.mainWorker!);
  const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  const name = path.startsWith('opfs://') ? path.slice('opfs://'.length) : null;
  if (name && (await opfsFileSize(name)) > 0 && (await opfsFileSize(`${name}.wal`)) === 0) {
    // duckdb-wasm 1.32.0 registers only non-empty OPFS files for direct I/O when it
    // opens a database. An existing database with an empty (or missing) WAL, such as
    // a freshly copied seed, then gets a WAL handle that was opened for replay only,
    // and every COMMIT fails with "File is not opened in write mode". Registering the
    // WAL ourselves gives it the same writable handle a non-empty WAL would get.
    const wal = await (await opfsRoot()).getFileHandle(`${name}.wal`, { create: true });
    await db.registerFileHandle(`${path}.wal`, wal, duckdb.DuckDBDataProtocol.BROWSER_FSACCESS, true);
  }
  await db.open({ path, accessMode: duckdb.DuckDBAccessMode.READ_WRITE });
  return db;
}

// OPFS helpers used before DuckDB opens the file (DuckDB holds an exclusive
// sync access handle while it is open).

async function opfsRoot(): Promise<FileSystemDirectoryHandle> {
  return navigator.storage.getDirectory();
}

export async function opfsFileSize(name: string): Promise<number> {
  try {
    return (await (await (await opfsRoot()).getFileHandle(name)).getFile()).size;
  } catch {
    return 0;
  }
}

/**
 * Download a gzip-compressed database file and write it into OPFS under `name`.
 * Returns false (and writes nothing) if the seed is not available.
 */
export async function writeSeed(name: string, url: string, onProgress?: (bytes: number) => void): Promise<boolean> {
  const res = await fetch(url);
  if (!res.ok || !res.body) return false;
  const root = await opfsRoot();
  const writable = await (await root.getFileHandle(name, { create: true })).createWritable();
  let bytes = 0;
  const counter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      bytes += chunk.byteLength;
      onProgress?.(bytes);
      controller.enqueue(chunk);
    },
  });
  // Hosts differ: some send the .gz as is, others (the Vite dev server) add
  // Content-Encoding: gzip and the browser has already inflated it. Look at the bytes.
  const reader = res.body.getReader();
  const first = await reader.read();
  const gzipped = first.value?.[0] === 0x1f && first.value?.[1] === 0x8b;
  let body: ReadableStream<Uint8Array> = new ReadableStream({
    start(c) {
      if (first.value) c.enqueue(first.value);
      if (first.done) c.close();
    },
    async pull(c) {
      const { done, value } = await reader.read();
      if (done) c.close();
      else c.enqueue(value);
    },
  }).pipeThrough(counter);
  if (gzipped) body = body.pipeThrough(new DecompressionStream('gzip') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
  try {
    await body.pipeTo(writable);
  } catch (e) {
    // Never leave a truncated database behind.
    await root.removeEntry(name).catch(() => undefined);
    throw e;
  }
  return true;
}

export async function readOpfsFile(name: string): Promise<File> {
  return (await (await opfsRoot()).getFileHandle(name)).getFile();
}

export async function removeOpfsFiles(names: string[]): Promise<void> {
  const root = await opfsRoot();
  for (const n of names) await root.removeEntry(n).catch(() => undefined);
}
