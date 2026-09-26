import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

// Not precached: the seed (only needed until it is in OPFS), the MVP builds (Chromium,
// Firefox and Safari all take the EH build) and source maps.
const NOT_PRECACHED = [/^seed\/.*\.(ndjson|gz)$/, /mvp/, /\.map$/, /^sw\.js$/];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

/** Writes dist/sw.js from sw/sw.js with the list of files to precache and a content hash. */
function serviceWorker(): Plugin {
  let outDir = 'dist';
  return {
    name: 'service-worker',
    apply: 'build',
    configResolved(config) {
      outDir = config.build.outDir;
    },
    closeBundle() {
      const files = walk(outDir)
        .map((p) => relative(outDir, p).split('\\').join('/'))
        .filter((p) => !NOT_PRECACHED.some((re) => re.test(p)))
        .sort();
      const hash = createHash('sha256');
      for (const f of files) hash.update(f).update(readFileSync(join(outDir, f)));
      const version = hash.digest('hex').slice(0, 16);
      const source = readFileSync('sw/sw.js', 'utf8')
        .replace('self.__VERSION__', JSON.stringify(version))
        .replace('self.__PRECACHE__', JSON.stringify(['./', ...files.filter((f) => f !== 'index.html')]));
      writeFileSync(join(outDir, 'sw.js'), source);
    },
  };
}

export default defineConfig({
  // Relative asset URLs, so dist/ works under any path (e.g. GitHub Pages /<repo>/).
  base: './',
  plugins: [serviceWorker()],
  optimizeDeps: { exclude: ['@duckdb/duckdb-wasm'] },
  test: { include: ['tests/unit/**/*.test.ts'] },
});
