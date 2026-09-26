// Put the DuckDB-Wasm extensions the broker uses under public/duckdb-extensions/, so the
// page loads them from its own origin (and a Service Worker can keep them for offline use)
// instead of from extensions.duckdb.org.
//
//   node scripts/fetch-extensions.mjs
//
// The layout mirrors the official repository: <version>/<platform>/<name>.duckdb_extension.wasm.
// Files are checked by sha256, so an upstream change fails the build instead of shipping.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const VERSION = 'v1.4.3'; // DuckDB inside @duckdb/duckdb-wasm 1.32.0
const FILES = {
  'wasm_eh/spatial': '04b776946da64a15a7b14501790c75093e38f876acc46b2922f0daeb6aaa1d60',
  'wasm_eh/json': 'b997276c8e15cc3ebdeda340d73d15dc1c4f4755ad281280451cb0a2f79302e9',
  'wasm_mvp/spatial': '7a745cfc5259f69b46f077bc6afeb7a6aefb8ef8d8b336bb0b770e5449708bb4',
  'wasm_mvp/json': '5771b6d57335eca8e2ba4fdaacb491a53b49577bd7f1b0c39e2cd7a39b4e9313',
};

for (const [name, sha256] of Object.entries(FILES)) {
  const path = `public/duckdb-extensions/${VERSION}/${name}.duckdb_extension.wasm`;
  if (!existsSync(path)) {
    const url = `https://extensions.duckdb.org/${VERSION}/${name}.duckdb_extension.wasm`;
    console.log(`downloading ${url}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    mkdirSync(path.slice(0, path.lastIndexOf('/')), { recursive: true });
    writeFileSync(path, Buffer.from(await res.arrayBuffer()));
  }
  const actual = createHash('sha256').update(readFileSync(path)).digest('hex');
  if (actual !== sha256) throw new Error(`${path}: sha256 ${actual}, expected ${sha256}`);
}
console.log(`extensions ok: ${Object.keys(FILES).join(', ')}`);
