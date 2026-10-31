import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;

// E2E runs against the production build in dist/ made from the fictional demo data (fixtures/):
// build without GOOGLE_SERVICE_ACCOUNT / SHEETS_CITIES first, so the expected streets exist.
export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}/`,
    // The service worker would serve cached files between tests; the offline mode has its own checks elsewhere.
    serviceWorkers: 'block',
    locale: 'sr-RS',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'phone', use: { ...devices['Pixel 7'] } }],
  webServer: {
    command: `npx vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: !process.env.CI,
  },
});
