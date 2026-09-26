import { defineConfig } from 'vitest/config';

export default defineConfig({
  optimizeDeps: { exclude: ['@duckdb/duckdb-wasm'] },
  test: { include: ['tests/unit/**/*.test.ts'] },
});
