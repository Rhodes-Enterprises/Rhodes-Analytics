import path from 'node:path';
import { configDefaults, defineConfig } from 'vitest/config';

// Deliberately independent of vite.config.ts: that config requires the
// workflow-provided PORT and BASE_PATH env vars and throws without them,
// while tests must run from a plain shell (pnpm run test / validation).
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.test.{ts,tsx}'],
    // src/lib/*.test.ts are plain `node --test` suites (no framework); the
    // second half of the "test" script runs them. Vitest must not collect
    // them — it would find no vitest-registered tests and fail the files.
    exclude: [...configDefaults.exclude, 'src/lib/*.test.ts'],
  },
});
