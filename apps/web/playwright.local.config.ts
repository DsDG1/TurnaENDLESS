import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.PLAYWRIGHT_LOCAL_PORT ?? 4173);
const baseURL = `http://127.0.0.1:${port}`;
export default defineConfig({
  testDir: './e2e',
  testMatch: ['**/app.spec.ts', '**/ai.spec.ts', '**/creative.spec.ts', '**/edition.spec.ts', '**/local-profile.spec.ts'],
  fullyParallel: false,
  workers: 1,
  outputDir: '../../out/local-profile-e2e',
  use: { baseURL, channel: process.env.PLAYWRIGHT_CHANNEL, trace: 'retain-on-failure', serviceWorkers: 'allow' },
  projects: [
    { name: 'desktop-local', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } } },
    { name: 'mobile-local', use: { ...devices['Pixel 7'] } },
  ],
  webServer: { command: `pnpm preview --port ${port} --strictPort`, url: baseURL, reuseExistingServer: false },
});
