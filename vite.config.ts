import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Relative asset URLs, so dist/ works under any path (e.g. GitHub Pages /<repo>/).
  base: './',
  optimizeDeps: { exclude: ['@duckdb/duckdb-wasm'] },
  test: { include: ['tests/unit/**/*.test.ts'] },
});
