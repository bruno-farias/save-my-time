import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e',
  outputDir: './test-results/browser',
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  use: { headless: true, viewport: { width: 390, height: 844 }, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  webServer: [
    { command: 'npm run dev -- --port 4173 --strictPort', url: 'http://127.0.0.1:4173/sidepanel.html', reuseExistingServer: !process.env.CI },
    { command: 'postman simulation run postman/simulations/providers.sim.yaml --port 4320 --no-history', url: 'http://127.0.0.1:4320/ollama/health', timeout: 30_000 },
  ],
});
