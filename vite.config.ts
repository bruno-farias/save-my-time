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
  },
});
