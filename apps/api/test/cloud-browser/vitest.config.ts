import { defineConfig } from 'vitest/config';

export default defineConfig({ test: {
  include: ['test/cloud-browser/*.journey.ts'],
  fileParallelism: false,
  testTimeout: 180_000,
  hookTimeout: 120_000,
} });
