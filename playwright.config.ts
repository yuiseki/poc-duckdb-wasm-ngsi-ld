import { defineConfig } from '@playwright/test';

// E2E runs against the production build served as static files.
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 120_000,
  use: { baseURL: 'http://localhost:4199' },
  webServer: {
    command: 'npm run build && npx vite preview --port 4199 --strictPort',
    url: 'http://localhost:4199',
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
