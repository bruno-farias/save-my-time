import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    rollupOptions: { input: 'sidepanel.html' },
    sourcemap: false,
  },
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    exclude: ['tests/**/*.integration.test.ts'],
    environment: 'jsdom',
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      include: ['src/lib/{browser,credential-store,extract,prompts,settings,streams,vault-crypto}.ts', 'src/locales/{catalog,validation}.ts'],
      reporter: ['text', 'html', 'lcov', 'json-summary'],
      thresholds: { perFile: true, statements: 95, branches: 85, functions: 95, lines: 95 },
    },
  },
});
